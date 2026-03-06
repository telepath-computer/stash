# Case-only renames cause unresolvable drift on case-insensitive filesystems

## Problem

On macOS (case-insensitive HFS+/APFS), renaming a file's case (e.g. `Arabella.md` → `arabella.md`) causes `stash sync` to fail with `local files changed during sync` on every attempt, with no way to self-resolve.

`scan()` walks the directory and gets the actual disk casing (`arabella.md`). The snapshot has `Arabella.md`. Scan reports `Arabella.md` as deleted and `arabella.md` as added — this is correct. Reconcile creates mutations for both paths — also correct.

The bug is in `currentHash()`. `buildExpectedHashes` sets expected hash for `Arabella.md` to `null` (locally deleted). But `currentHash("Arabella.md")` calls `existsSync()`, which returns `true` on macOS because the filesystem resolves `Arabella.md` to `arabella.md`. So it reads the file and returns a real hash. `null !== real_hash` → drift detected → retry × 5 → throws.

The file `Arabella.md` does not exist. `arabella.md` exists. `existsSync` lies on case-insensitive filesystems.

## Solution

Make `currentHash` verify exact filename casing before returning a hash. If `existsSync` finds a file but the actual filename on disk has different casing, return `null` — that exact path doesn't exist.

This check runs unconditionally (no filesystem detection needed). On case-sensitive filesystems `existsSync` already returns `false` for mismatched case, so the casing check never triggers — it's a no-op.

```typescript
/**
 * Check whether every segment of a relative path matches the actual
 * casing on disk. Returns false if any segment (directory or file)
 * has different casing than what the filesystem reports.
 */
private hasExactCasing(relPath: string): boolean {
  const segments = relPath.split("/");
  let current = this.dir;
  for (const segment of segments) {
    const entries = readdirSync(current);
    const actual = entries.find(
      (entry) => entry.toLowerCase() === segment.toLowerCase(),
    );
    if (!actual || actual !== segment) {
      return false;
    }
    current = join(current, actual);
  }
  return true;
}

private currentHash(path: string): string | null {
  const absPath = this.abs(path);
  if (!existsSync(absPath)) {
    return null;
  }
  // Verify exact casing for every path segment. existsSync resolves
  // case-insensitively on macOS, so "Research/Arabella.md" returns
  // true even when disk has "research/arabella.md".
  if (!this.hasExactCasing(path)) {
    return null;
  }
  const stat = lstatSync(absPath);
  if (!stat.isFile()) {
    return NON_FILE_HASH;
  }
  return hashBuffer(readFileSync(absPath));
}
```

`currentHash("Arabella.md")` now returns `null` when disk has `arabella.md`. The expected hash from `buildExpectedHashes` is `null`. Drift check passes.

Additionally, `apply()` must process delete mutations before write mutations. On case-insensitive filesystems, a case-only rename produces both a delete (`Arabella.md`) and a write (`arabella.md`). If the write happens first, it overwrites the existing file (same inode on case-insensitive FS), then the delete removes the just-written file. Reordering deletes before writes avoids this.

## Targets

### `code/src/stash.ts`

1. Add `hasExactCasing()` — verifies exact casing for each segment of a relative path against the directory listing.
2. Update `currentHash` to call `hasExactCasing` and return `null` when casing doesn't match.
3. Update `apply()` to process delete mutations before write mutations.

### `spec/stash.md`

1. Note that `currentHash` verifies exact path casing to handle case-insensitive filesystems.
2. Note that `apply()` processes deletes before writes.

## Tests

### Integration tests (`stash-sync.test.ts`)

These use FakeProvider and run on the local filesystem, so they naturally exercise case-insensitive behavior on macOS.

```
1. sync: case-only rename syncs successfully
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

### E2E tests (`stash-github-scenarios.e2e.test.ts`)

```
5. scenario: case-only rename syncs to remote and back
   - Machine A: create repo, sync "notes/Arabella.md" with content "hello"
   - Machine A: rename to "notes/arabella.md" on disk (same content)
   - Machine A: sync() — should succeed, not throw drift error
   - Verify remote has "notes/arabella.md" and no "notes/Arabella.md"
   - Machine B: connect to same repo, sync()
   - Verify Machine B has "notes/arabella.md" with content "hello"
```

## Refs

- GitHub issue: https://github.com/telepath-computer/stash/issues/9
