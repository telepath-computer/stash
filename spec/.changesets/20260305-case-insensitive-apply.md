# Directory case renames don't apply on case-insensitive filesystems

Follow-up to `20260305-case-insensitive-drift.md`. The read-side fix (`hasExactCasing` / `currentHash`) handles single-machine case renames correctly. But when Machine B pulls a directory case change from the remote, the directory casing on disk doesn't update — causing an oscillation loop between machines.

## Problem

Machine A renames `Notes/` → `notes/` and syncs. Remote now has `notes/draft.md`. Machine B syncs and receives mutations: delete `Notes/draft.md`, write `notes/draft.md`.

In `apply()`:

1. Delete `Notes/draft.md` — file is removed, but `Notes/` directory remains (empty).
2. Write `notes/draft.md` — calls `mkdir("notes/", { recursive: true })`. On case-insensitive FS, `Notes/` already exists and satisfies the mkdir. No rename occurs. The file is written into `Notes/`, so disk still has `Notes/draft.md`.

Machine B's next sync sees `Notes/draft.md` on disk but `notes/draft.md` in the snapshot. It pushes the uppercase version back to remote. Machine A syncs, sees the uppercase version, pushes lowercase back. Infinite oscillation.

The root cause: `mkdir` on a case-insensitive filesystem treats `notes/` and `Notes/` as the same directory and does nothing. The directory is never renamed.

## Solution

In `apply()`, before writing a file, check whether each directory segment in the target path has the correct casing on disk. If a directory exists with different casing, rename it to match the mutation path.

Extract this as a private method `ensureDirectoryCasing(relPath: string)` that walks each directory segment of the path, compares against the actual disk listing (using `readdirSync`), and renames any mismatched segment directly. macOS APFS handles direct case-only `renameSync("Notes", "notes")` correctly — the directory is renamed in place with contents preserved.

```typescript
private ensureDirectoryCasing(relPath: string): void {
  const segments = relPath.split("/");
  // Only check directory segments (skip the filename at the end)
  const dirSegments = segments.slice(0, -1);
  let current = this.dir;
  for (const segment of dirSegments) {
    const entries = readdirSync(current);
    const actual = entries.find(
      (entry) => entry.toLowerCase() === segment.toLowerCase(),
    );
    if (actual && actual !== segment && !entries.includes(segment)) {
      renameSync(join(current, actual), join(current, segment));
    }
    current = join(current, segment);
  }
}
```

Call `ensureDirectoryCasing(mutation.path)` in `apply()` immediately before the `mkdir` call in the write branch. The subsequent `mkdir` is still needed for genuinely new directories.

This is safe on case-sensitive filesystems where `Notes/` and `notes/` can coexist as separate directories. The `!entries.includes(segment)` guard ensures we only rename when the exact-case directory doesn't already exist. On case-sensitive FS, if we're writing to `notes/` and both `Notes/` and `notes/` exist, we leave both alone. On case-insensitive FS, they can't coexist, so the guard is always satisfied when `actual !== segment`.

## Targets

### `code/src/stash.ts`

1. Add `renameSync` to the `node:fs` import.
2. Add `ensureDirectoryCasing(relPath: string)` — walks directory segments, renames any that exist with wrong casing.
3. Call `ensureDirectoryCasing(mutation.path)` in `apply()` before `mkdir` in the write branch.

### `spec/stash.md`

1. Note that `apply()` ensures directory casing matches mutation paths before writing.

## Tests

### Integration tests (`stash-sync.test.ts`)

```
1. sync: directory case rename applies correctly on pull
   - Stash with snapshot containing "Notes/draft.md"
   - Remote has "notes/draft.md" (lowercase directory)
   - sync()
   - Verify disk has "notes/" directory (not "Notes/")
   - Verify file content preserved

2. sync: nested directory case rename applies correctly
   - Stash with snapshot containing "Docs/Notes/draft.md"
   - Remote renames to "docs/notes/draft.md"
   - sync()
   - Verify disk has "docs/notes/" (both segments renamed)
```

### E2E tests (`stash-github-scenarios.e2e.test.ts`)

```
3. scenario 37: directory case rename converges across two machines
   (already exists as a failing test — should pass after fix)
```

## Refs

- Follows from: `20260305-case-insensitive-drift.md`
- GitHub issue: https://github.com/telepath-computer/stash/issues/9
