# Sync Race Brief

## Summary

There is a real race condition in `Stash.sync()` where local edits made during an in-flight sync can be overwritten.

The core issue is that local state is captured once (`scan()`), then used later for reconcile/push/apply without revalidating that files stayed unchanged.

## New Tests Added

New integration tests were added at:

- `code/tests/integration/stash-sync.test.ts`
- Test names:
  - `sync: preserves local edits made after scan but before push (pre-push race window)`
  - `sync: preserves local edits made after push but before apply (post-push race window)`

### Test A: Pre-push window (`scan()` -> `provider.push()`)

1. Baseline file exists on both sides.
2. Remote gets Bob's edit at end of file.
3. Local gets Alice early edit at start of file.
4. Sync is started and provider `fetch()` is intentionally paused.
5. While sync is in-flight (after initial scan), local gets Alice late edit.
6. Sync resumes.

Expected behavior (desired):

- Final file contains Alice late edit + Bob remote edit.
- Final file does not keep stale Alice early content.

Current behavior:

- Test currently fails on current implementation.
- Late in-flight local edit is not preserved.

### Test B: Post-push window (`provider.push()` -> `apply()`)

1. Baseline file exists on both sides.
2. Remote gets Bob's edit at end of file.
3. Local gets Alice early edit at start of file.
4. Sync is started and provider `push()` is intentionally paused **after** remote write completes.
5. While sync is in-flight (after push, before apply), local gets Alice late edit.
6. Sync resumes and proceeds to local apply.

Expected behavior (desired):

- Final file contains Alice late edit + Bob remote edit.
- Final file does not keep stale Alice early content.

Current behavior:

- Test currently fails on current implementation.
- Post-push in-flight local edit is not preserved.

## Race Windows

### 1) `scan()` -> `provider.push()`

Location:

- `code/src/stash.ts` (`scan()` result stored in `localChanges`)
- `reconcile(localChanges, remoteChanges)` and then `provider.push(...)`

Risk:

- Local file changes after scan but before remote push are invisible to this sync pass.

### 2) `provider.push()` -> `apply()`

Location:

- `code/src/stash.ts` (`provider.push(...)` followed by `apply(...)`)

Risk:

- Even if push used correct state, local edits made after push and before/during apply can still be overwritten by `disk: "write"` mutations.

### 3) Retry loop with stale local snapshot

Location:

- `code/src/stash.ts` retry on `PushConflictError`

Risk:

- On conflict retry, remote is re-fetched, but `localChanges` from the original scan is reused.
- Additional local edits during retry window are not incorporated.

### 4) Watch mode event queuing does not prevent overwrite

Location:

- `code/src/watch.ts` (`pendingEvents` while `state === "syncing"`)

Risk:

- Watch mode schedules a follow-up sync after in-flight changes are detected, but the current sync can already overwrite content before that next cycle runs.

## Why This Matters

This is not just "commit noise". It is potential user-visible data loss at path level for text files being actively edited while sync is running.
