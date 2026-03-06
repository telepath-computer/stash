# Case-only renames cause unresolvable drift on case-insensitive filesystems

## Problem

On macOS (case-insensitive HFS+/APFS), renaming a file's case (e.g. `Arabella.md` → `arabella.md`) causes `stash sync` to fail with `local files changed during sync` on every attempt, with no way to self-resolve.

`scan()` walks the directory and gets the actual disk casing (`arabella.md`). The snapshot has `Arabella.md`. Scan reports `Arabella.md` as deleted and `arabella.md` as added. Reconcile creates mutations for both paths. `buildExpectedHashes` sets expected hash for `Arabella.md` to `null` (locally deleted). But `currentHash("Arabella.md")` on macOS resolves to the lowercase file and returns a real hash. `null !== real_hash` → drift → retry × 5 → throws.

The drift check is correct in spirit — it's detecting that the file at the old path still exists. But the file _is_ the renamed file, not an external edit. The retry loop can never resolve this because the filesystem always resolves the old-case path to the new-case file.

## Solution

Detect case-insensitive filesystems and handle case-only renames in `scan()` so they produce a clean `modified` mutation (path changed, content may or may not have changed) rather than a delete+add pair.

### Filesystem detection

Add a `private caseInsensitiveFs: boolean` field to `Stash`, set once at load time. Detection: write a temp file in `.stash/`, check if the alternate-case path resolves to it, clean up.

```typescript
// In Stash constructor or a static helper
private static detectCaseInsensitive(dir: string): boolean {
  const probe = join(dir, ".stash", ".case-probe");
  try {
    writeFileSync(probe, "", { flag: "wx" });
    const altCase = join(dir, ".stash", ".CASE-PROBE");
    const result = existsSync(altCase);
    unlinkSync(probe);
    return result;
  } catch {
    return false; // assume case-sensitive if detection fails
  }
}
```

Cache the result — no need to re-probe on every sync.

### Scan changes

In `scan()`, after the directory walk builds the `seen` set and before reporting deleted paths, detect case-only renames:

```typescript
for (const snapshotPath of Object.keys(snapshot)) {
  if (seen.has(snapshotPath)) continue;

  if (this.caseInsensitiveFs) {
    const lowerSnapshotPath = snapshotPath.toLowerCase();
    const caseMatch = [...added.keys()].find(
      (p) => p.toLowerCase() === lowerSnapshotPath,
    );
    if (caseMatch) {
      // Case-only rename: treat as modified under the new path,
      // remove from added, don't add to deleted.
      // The old snapshot entry is superseded by the new path.
      const state = added.get(caseMatch)!;
      added.delete(caseMatch);
      modified.set(caseMatch, state);
      // Mark old path for snapshot cleanup
      deleted.push(snapshotPath);
      continue;
    }
  }

  deleted.push(snapshotPath);
}
```

Wait — this still produces a delete for the old path. That's correct: reconcile needs to know to remove the old-case entry from the snapshot and add the new-case entry. The key change is that the new-case file is now `modified` rather than `added`, so `buildExpectedHashes` will use its actual content hash instead of `null`.

But the real fix needs to be in `buildExpectedHashes` and `currentHash`. The problem is specifically that `currentHash(oldCasePath)` resolves to the renamed file on a case-insensitive FS. Two options:

**Option A: Fix `buildExpectedHashes` to handle case renames.**

When building expected hashes, if a mutation path is locally deleted AND a case-insensitive match exists in the added/modified set, set the expected hash to the matched file's hash instead of `null`. This makes the drift check pass because `currentHash` will resolve to that same file.

**Option B: Fix `currentHash` to be case-aware.**

When on a case-insensitive FS, `currentHash` should check whether the path's actual disk casing matches the requested path. If not (file exists but under different case), return `null` — the file doesn't really exist at that exact path.

Option B is more correct and surgical. It makes `currentHash` truthful about whether the file exists at the _exact_ path, regardless of FS behavior. This fixes the drift check without touching scan or reconcile logic.

### Recommended: Option B

```typescript
private currentHash(path: string): string | null {
  const absPath = this.abs(path);
  if (!existsSync(absPath)) {
    return null;
  }
  // On case-insensitive FS, verify the path's actual case matches.
  // existsSync("Foo.md") returns true even if disk has "foo.md".
  if (this.caseInsensitiveFs) {
    const actualName = readdirSync(dirname(absPath)).find(
      (entry) => entry.toLowerCase() === basename(absPath).toLowerCase(),
    );
    if (actualName && actualName !== basename(absPath)) {
      return null; // file exists under different case — not this path
    }
  }
  const stat = lstatSync(absPath);
  if (!stat.isFile()) {
    return NON_FILE_HASH;
  }
  return hashBuffer(readFileSync(absPath));
}
```

This makes `currentHash("Arabella.md")` return `null` when disk has `arabella.md`, matching the expected hash from `buildExpectedHashes`. Drift check passes. Reconcile then processes the delete (old case) + add (new case) normally, and the sync completes.

No changes needed to `scan`, `reconcile`, `buildExpectedHashes`, or `apply`.

## Targets

### `code/src/stash.ts`

1. Add `caseInsensitiveFs` field, detected at load time via probe file.
2. Update `currentHash` to verify actual path casing on case-insensitive FS (Option B above).

### `spec/stash.md`

1. Document case-insensitive FS detection.
2. Note that `currentHash` verifies exact path casing on case-insensitive filesystems.

## Tests

### Unit tests (`stash-sync.test.ts`)

```
1. sync: case-only rename syncs successfully on case-insensitive FS
   - Stash with snapshot containing "notes/Arabella.md"
   - Rename file on disk to "notes/arabella.md" (same content)
   - sync()
   - Remote receives delete for old path, write for new path
   - Local snapshot updated with new-case path
   - No error thrown

2. sync: case-only rename with content change syncs successfully
   - Stash with snapshot containing "notes/Arabella.md" (content "v1")
   - Rename to "notes/arabella.md" and change content to "v2"
   - sync()
   - Remote receives delete for old path, write for new path with "v2"
   - Local snapshot updated

3. sync: case-only rename does not trigger drift retry
   - Verify fetchCalls === 1 (no retries needed)

4. sync: true deletion still works on case-insensitive FS
   - Delete a file entirely (not rename)
   - sync()
   - Remote receives delete, snapshot updated
```

## Refs

- GitHub issue: https://github.com/telepath-computer/stash/issues/9
