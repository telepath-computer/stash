# Sync Architecture

Replaces the three-full-maps reconcile model with a ChangeSet model. Adds `snapshot.json` for efficient change detection. Reorders sync flow so push happens before local disk writes. Adds retry logic for ref conflicts. Driven by decisions 3, 4, 5, 6 in decisions.md.

## Target: spec/main.md

### New type: ChangeSet

Add to Architecture section:

```ts
interface ChangeSet {
  added: Map<string, FileState>       // files new since last sync
  modified: Map<string, FileState>    // files changed since last sync
  deleted: string[]                   // files removed since last sync
}
```

Core data structure for both local scanning and remote fetching. Uses the same `FileState` type — text files have content, binary files have hash + modified.

### New type: SnapshotEntry

```ts
type SnapshotEntry =
  | { hash: string }                              // text file
  | { hash: string, modified: string }            // binary file (ISO 8601)
```

Used in `snapshot.json`. `modified` only present for binary files (last-modified-wins tiebreaker). `hash` is SHA-256 of file content for both text and binary.

### snapshot.json

Stored both locally (`.stash/snapshot.json`) and on remote (`.stash/snapshot.json`). After a successful sync, both copies are identical. Between syncs they may diverge (remote updated by other machines, local unchanged until next sync).

```json
{
  "hello.md": { "hash": "sha256-abc..." },
  "image.png": { "hash": "sha256-def...", "modified": "2026-03-01T12:00:00Z" }
}
```

Pushed to remote as part of each sync commit. Enables efficient change detection: fetch `snapshot.json` first, compare hashes, only download files that differ.

### Provider interface

Replace:
```ts
fetch(): Promise<Map<string, FileState>>
```

With:
```ts
fetch(knownHashes?: Map<string, string>): Promise<ChangeSet>
```

- `knownHashes`: hash from local `snapshot.json` per file path. Provider compares against remote `snapshot.json` to determine what changed.
- If `knownHashes` is undefined/empty (first sync): all remote files returned as `added`.
- Provider fetches remote `snapshot.json` first, diffs against `knownHashes`, then fetches only changed file content.

`get()` and `push()` unchanged in signature.

### PushPayload

Add `snapshot` field:

```ts
interface PushPayload {
  files: Map<string, string | (() => Readable)>   // text content or binary stream
  deletions: string[]                               // paths to delete
  snapshot: Record<string, SnapshotEntry>           // updated snapshot.json to push
}
```

### Stash.reconcile()

Replace:
```ts
private reconcile(
  local: Map<string, FileState>,
  remote: Map<string, FileState>,
  snapshots: Map<string, FileState>
): FileMutation[]
```

With:
```ts
private reconcile(
  local: ChangeSet,
  remote: ChangeSet
): FileMutation[]
```

Only processes files that appear in at least one ChangeSet. Unchanged files are not in either set and are skipped automatically.

The merge table mapping is the same, but the inputs are change types (added/modified/deleted) rather than raw file states compared against snapshots. Reconcile no longer needs snapshots as input — change detection has already happened.

Merge table with ChangeSets:

| Local | Remote | disk | remote | content / source |
|-------|--------|------|--------|------------------|
| modified | — | skip | write | local content |
| — | modified | write | skip | remote content |
| modified | modified (text) | write | write | merged via `merge()` |
| modified | modified (binary) | write | write | source: last-modified wins |
| added | — | skip | write | local content |
| — | added | write | skip | remote content |
| added | added (text) | write | write | merged via `merge()` |
| added | added (binary) | write | write | source: last-modified wins |
| deleted | — | skip | delete | — |
| — | deleted | delete | skip | — |
| deleted | modified | write | skip | remote content (content wins) |
| modified | deleted | skip | write | local content (content wins) |
| deleted | deleted | skip | skip | — |

### Sync flow

Replace current steps 1-7 with:

1. **Scan local**: read disk + local `snapshot.json` → local `ChangeSet`
2. **Fetch remote**: `provider.fetch(knownHashes)` → remote `ChangeSet`
3. **Reconcile**: `reconcile(local, remote)` → `FileMutation[]`
4. **Compute snapshot**: build new `snapshot.json` in memory from mutations
5. **Push to remote**: build `PushPayload` from mutations + new `snapshot.json`, call `provider.push(payload)`. On `RefConflictError` → retry from step 2 (reuse local ChangeSet, max 3 retries).
6. **Apply to disk**: write/delete files, emit mutation events. For binary files where `source: "remote"`, call `provider.get(path)` and pipe to disk.
7. **Update local snapshots**: write `snapshot.json` + text files to `snapshot.local/`

Key changes from original flow:
- Push (step 5) happens before local disk writes (step 6). If push fails, no local state is changed. If push succeeds but local writes fail, next sync self-heals.
- Retry logic: provider throws `RefConflictError` when remote ref has moved. Stash catches it and retries from step 2 with fresh remote data, reusing the original local ChangeSet (disk hasn't changed — single-flight guarantee).
- `snapshot.json` is computed in memory (step 4) and included in the push payload, then written locally after success (step 7).

### Walkthrough section

Update the full walkthrough to use ChangeSet model:

**Step 1** becomes: scan disk, compare to `snapshot.json` hashes → local ChangeSet with added/modified/deleted.

**Step 2** becomes: `provider.fetch(knownHashes)` where knownHashes comes from local `snapshot.json`. Provider fetches remote `snapshot.json`, diffs hashes, fetches changed content → remote ChangeSet.

**Step 3** becomes: `reconcile(localChangeSet, remoteChangeSet)` → `FileMutation[]`. Only files in at least one ChangeSet are processed.

**Steps 4-7** follow new ordering: compute snapshot → push → apply to disk → update local snapshots.

**Step 6 (update snapshots)** becomes: write `snapshot.json` (hashes for all files) + write text content to `snapshot.local/`. No more binary `.hash` files.

### FileState

No changes to the type itself. But update the description:
- Remove: "Reconcile compares content to snapshot to detect changes" — change detection now happens before reconcile via `snapshot.json` hash comparison.
- `FileState` is used within `ChangeSet.added` and `ChangeSet.modified` maps.

### StatusResult

No changes to the type. But update description:
- "Scans disk vs snapshots" → "Scans disk vs `snapshot.json` hashes" (no longer reads full snapshot content for status).
