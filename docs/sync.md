# Sync

This document describes the `stash.sync()` lifecycle and the invariants around locking, retries, drift handling, and snapshots.

## High-Level Behavior

One sync cycle:

1. Scans local files against the previous snapshot.
2. Fetches remote changes through the configured provider.
3. Reconciles local and remote changes into file mutations.
4. Computes the next snapshot in memory.
5. Checks for pre-push drift on affected paths.
6. Pushes remote updates.
7. Applies local writes and deletes.
8. Saves local snapshot state.

If no provider connection is configured, sync is a no-op.

## Single-Flight And Locking

Only one sync may run at a time for a given stash.

There are two guards:

- in-process guard: a `syncInFlight` flag on the `Stash` instance
- cross-process guard: `.stash/sync.lock`

The lock file is created with atomic write semantics and contains:

```json
{
  "pid": 12345,
  "startedAt": "2026-03-03T12:00:00.000Z",
  "hostname": "machine-a"
}
```

Rules:

- If another active sync already holds the lock, `sync()` throws `SyncLockError`.
- Locks older than 10 minutes are treated as stale and reclaimed once.
- Lock acquisition happens before the sync body starts.
- Lock release happens in `finally`, even on failure.

## Lifecycle

Within one provider sync cycle, Stash does the following:

1. Read the current local `snapshot.json`.
2. Run `scan()` to build the local `ChangeSet`.
3. Call `provider.fetch(localSnapshot)` to get the remote `ChangeSet`.
4. Reconcile both sides into `FileMutation[]`.
5. Compute the next snapshot from the old snapshot plus those mutations.
6. Build expected hashes for each affected local path and check for drift.
7. If local drift is found before push, restart the cycle.
8. Build a push payload from remote writes, deletions, and the next snapshot.
9. Call `provider.push(payload)`.
10. Apply local deletes first, then writes.
11. Skip any local write whose target drifted after push but before apply.
12. Save the local snapshot and snapshot-local text bases.

## Retry Rules

Sync retries are bounded to 5 attempts for restart-worthy conditions:

- local pre-push drift
- `PushConflictError` from the provider

When the retry limit is exhausted, sync throws the last error and stops.

There is no unbounded restart loop.

## Drift Handling

Stash protects in-flight local edits in two places.

### Pre-Push Drift

Before pushing, Stash re-checks only mutation-targeted paths rather than rescanning the whole tree.

- If a targeted path changed since the initial scan, the cycle restarts.
- This protects local edits that happened while remote state was being fetched or reconciled.

### Post-Push Drift

Before writing each local `disk: "write"` mutation, Stash re-checks that path again.

- If the local file changed after push but before apply, the local write is skipped.
- The remote push is not rolled back.
- The local snapshot intentionally rolls back that skipped path to the previous base so the next sync will treat both sides as changed and re-merge.

This preserves newer local edits while still allowing later convergence.

## Snapshot Semantics

`snapshot.json` stores the synchronized content hash for every tracked file:

```json
{
  "notes/todo.md": { "hash": "sha256-abc..." },
  "image.png": { "hash": "sha256-def...", "modified": 1709290800000 }
}
```

- Text entries store only `hash`.
- Binary entries store `hash` plus `modified`.
- The same snapshot is pushed to the remote and stored locally after a successful cycle.

`.stash/snapshot.local/` stores the full text base for files that need later three-way merges. Binary files are not stored there.

## Push Ordering

Push happens before local disk writes.

That ordering matters:

- if push fails, local files have not been rewritten yet
- if push succeeds but a later local apply step fails or is skipped, the next sync can self-heal from the remote and the preserved snapshot base

## Provider Contract

Providers are expected to:

- `fetch(localSnapshot)` - return remote changes since the last synchronized snapshot
- `get(path)` - stream a remote binary file
- `push(payload)` - apply remote writes, deletions, and the new snapshot atomically enough to detect ref conflicts

See `docs/providers/github.md` for the concrete GitHub behavior.
