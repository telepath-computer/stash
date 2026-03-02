# Sync Architecture

## Why

The original sync design has the provider return a full `Map<string, FileState>` for every file on the remote — all text content, all binary hashes — every single sync. Reconcile then takes three full maps (local, remote, snapshots) and walks the union of all paths to figure out what changed.

This works but is wasteful. In a typical sync, 1-3 files changed out of hundreds. Downloading everything and diffing everything is slow and expensive, especially over the GitHub API.

With the introduction of `snapshot.json` (a manifest of SHA-256 hashes stored both locally and on the remote), we can detect changes cheaply: compare hashes first, then only fetch the files that actually differ. This changes the fundamental shape of sync — instead of "give me everything, I'll figure out what changed", it becomes "tell me what changed, with content for those files only".

## What changes

**ChangeSet replaces full maps.** Both local scanning and remote fetching now produce a `ChangeSet` (added/modified/deleted files) rather than a map of all files. Reconcile takes two ChangeSets and only processes files that appear in at least one — unchanged files are skipped entirely.

**Provider interface changes.** `fetch()` now accepts `localSnapshot` (the local `snapshot.json` content) and returns a `ChangeSet` of what changed on the remote, not a full file listing. The provider fetches the remote `snapshot.json`, compares hashes, and only downloads changed file content.

**Sync flow reordered.** Push now happens before local disk writes. This ensures that if push fails (e.g. ref conflict from another machine), no local state has been modified. The new `snapshot.json` is computed in memory and included in the push commit.

**Retry logic added.** If the remote ref has moved between fetch and push (another machine synced), the provider throws `PushConflictError`. Stash catches it and retries from fetch with fresh remote data, reusing the original local ChangeSet (disk hasn't changed — single-flight guarantee). Max 3 retries.

**PushPayload includes snapshot.** The push commit now includes the updated `snapshot.json` alongside file changes, so the remote manifest stays in sync.

## Target: spec/main.md

---

## ChangeSet

The core data structure for change detection. Both local scanning and remote fetching produce a ChangeSet — a summary of what changed since the last sync.

```ts
interface ChangeSet {
  added: Map<string, FileState>       // files new since last sync
  modified: Map<string, FileState>    // files changed since last sync
  deleted: string[]                   // files removed since last sync
}
```

Uses the same `FileState` type — text files have content, binary files have hash + modified.

**Local ChangeSet** is produced by scanning disk and comparing to `snapshot.json` hashes. A file whose content hash differs from `snapshot.json` is `modified`. A file on disk with no entry in `snapshot.json` is `added`. An entry in `snapshot.json` with no file on disk is `deleted`.

**Remote ChangeSet** is produced by the provider. It fetches the remote `snapshot.json`, compares hashes against the `localSnapshot` passed in, and only downloads content for files that differ.

## snapshot.json

Tracks the SHA-256 hash of every file's content at the time of last sync. Stored both locally and on the remote — after a successful sync, both copies are identical. Between syncs they may diverge (remote updated by other machines, local unchanged until next sync).

```json
{
  "hello.md": { "hash": "sha256-abc..." },
  "image.png": { "hash": "sha256-def...", "modified": 1709290800000 }
}
```

```ts
type SnapshotEntry =
  | { hash: string }                              // text file
  | { hash: string, modified: number }            // binary file (epoch ms)
```

- `hash`: SHA-256 of file content. Same algorithm used locally and remotely — hashes are directly comparable.
- `modified`: only present for binary files. Records when the file was last pushed. Used for last-modified-wins tiebreaker when both sides edit a binary file.

Pushed to remote as part of each sync commit. This is what makes efficient change detection possible — the provider can fetch one small JSON file and know exactly what changed.

## Provider interface

`fetch()` changes signature. Instead of returning all files, it returns only what changed:

```ts
interface Provider {
  fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet>
  get(path: string): Promise<Readable>
  push(payload: PushPayload): Promise<void>
}
```

- `localSnapshot`: the local `snapshot.json` content. Provider compares hashes against remote `snapshot.json` to determine what changed.
- If `localSnapshot` is undefined (first sync, no local snapshot): all remote files returned as `added`.
- Provider fetches remote `snapshot.json` first, diffs against `localSnapshot`, then fetches only changed file content.
- `get()` streams a single binary file from remote. Called after reconcile, only for binary files where reconcile determined `source: "remote"`. Binary content is fetched lazily because at fetch time we don't know if the file also changed locally — reconcile decides via last-modified-wins. If local wins, the remote bytes were never needed. Text is different: if both sides edited, merge always needs both versions, so text content is always useful and cheap to batch in `fetch()`.
- `push()` is unchanged in behavior but `PushPayload` gains a `snapshot` field.

On push, if the remote ref has moved since fetch (another machine synced between our fetch and push), the provider throws `PushConflictError`. It does not retry — that's Stash's responsibility.

## PushPayload

Gains a `snapshot` field — the updated `snapshot.json` content to push alongside file changes in the same commit.

```ts
interface PushPayload {
  files: Map<string, string | (() => Readable)>   // text content or binary stream
  deletions: string[]                               // paths to delete
  snapshot: Record<string, SnapshotEntry>           // updated snapshot.json to push
}
```

## Stash.reconcile()

Takes two ChangeSets instead of three full maps:

```ts
private reconcile(
  local: ChangeSet,
  remote: ChangeSet
): FileMutation[]
```

Only processes files that appear in at least one ChangeSet. Unchanged files are not in either set and are never touched.

Change detection has already happened before reconcile — by the time it runs, we know exactly which files were added, modified, or deleted on each side. Reconcile applies the merge table to these change types directly.

For text files that appear as `modified` or `added` on both sides, reconcile calls `mergeText()` using the snapshot from `snapshot.local/` as the three-way base.

Merge table with ChangeSets:

| Local | Remote | disk | remote | content / source |
|-------|--------|------|--------|------------------|
| modified | — | skip | write | local content |
| — | modified | write | skip | remote content |
| modified | modified (text) | write | write | merged via `mergeText()` |
| modified | modified (binary) | write | write | source: last-modified wins |
| added | — | skip | write | local content |
| — | added | write | skip | remote content |
| added | added (text) | write | write | merged via `mergeText()` |
| added | added (binary) | write | write | source: last-modified wins |
| deleted | — | skip | delete | — |
| — | deleted | delete | skip | — |
| deleted | modified | write | skip | remote content (content wins) |
| modified | deleted | skip | write | local content (content wins) |
| deleted | deleted | skip | skip | — |

## FileMutation

Gains `hash` and `modified` fields for binary files, making each mutation self-contained — no need to look back at ChangeSets to build the snapshot.

```ts
interface FileMutation {
  path: string
  disk: "write" | "delete" | "skip"
  remote: "write" | "delete" | "skip"
  content?: string                     // text content to write/push
  source?: "local" | "remote"          // binary: where to copy bytes from
  hash?: string                        // binary: SHA-256 hash of winning side
  modified?: number                    // binary: mtime of winning side (epoch ms)
}
```

- `content`: present for text files. Used for disk writes, push payload, and snapshot hashing.
- `source`, `hash`, `modified`: present for binary files. `source` tells sync where to stream bytes from. `hash` and `modified` go directly into the new snapshot entry.

## Stash.mergeText()

Renamed from `merge()` for clarity. Single-file text merge via diff-match-patch. No changes to signature or behavior:

```ts
private mergeText(snapshot: string | null, local: string, remote: string): string
```

## New Stash methods

Four new private methods on Stash:

```ts
// Step 1: scan disk + snapshot.json → local ChangeSet
private scan(): ChangeSet

// Step 4: build new snapshot.json from old snapshot + mutations
private computeSnapshot(
  oldSnapshot: Record<string, SnapshotEntry>,
  mutations: FileMutation[]
): Record<string, SnapshotEntry>

// Step 6: write/delete files on disk, emit mutation events
private apply(mutations: FileMutation[], provider: Provider): Promise<void>

// Step 7: write snapshot.json + snapshot.local/ text files to disk
private saveSnapshot(
  snapshot: Record<string, SnapshotEntry>,
  mutations: FileMutation[]
): Promise<void>
```

`scan()` reads all files from disk, hashes them, compares to `snapshot.json`. Files whose hash differs → `modified`. Files on disk with no snapshot entry → `added`. Snapshot entries with no file on disk → `deleted`.

`computeSnapshot()` starts from the old snapshot (unchanged files carry over). For each mutation: text files → hash the `content` string; binary files → use `hash` and `modified` from the mutation; deleted files → remove entry.

`apply()` executes mutations on disk. Writes text content, deletes files, emits `mutation` events. For binary files where `source: "remote"`, calls `provider.get(path)` and pipes to disk. For binary files where `source: "local"`, no disk write needed (file is already there).

`saveSnapshot()` writes the computed `snapshot.json` to disk and updates `snapshot.local/` — writes text content for files that were added or modified, removes files that were deleted. Takes mutations to know which `snapshot.local/` files to update.

## Provider lifecycle

Provider is constructed once per `sync()` call as a local variable. It is stateful within a sync cycle — `fetch()` stores the remote HEAD commit SHA internally, `push()` uses it as the parent commit for conflict detection.

Not stored as a Stash instance property. Each sync starts fresh — no stale state, no cleanup. If sync is interrupted at any point, the instance is discarded. Before push, nothing has changed anywhere. After push, next sync self-heals via stale snapshot detection.

```ts
async sync() {
  const provider = buildProvider("github")  // from registry + this.config
  const local = this.scan()
  const remote = await provider.fetch(localSnapshot)
  const mutations = this.reconcile(local, remote)
  const snapshot = this.computeSnapshot(oldSnapshot, mutations)
  await provider.push({ files, deletions, snapshot })
  await this.apply(mutations, provider)
  this.saveSnapshot(snapshot, mutations)
}
```

## Sync flow

1. **Scan local**: `scan()` → local `ChangeSet`
2. **Fetch remote**: `provider.fetch(localSnapshot)` → remote `ChangeSet`
3. **Reconcile**: `reconcile(local, remote)` → `FileMutation[]`
4. **Compute snapshot**: `computeSnapshot(oldSnapshot, mutations)` → new `snapshot.json` in memory. Must happen before push because the new snapshot is included in the push payload.
5. **Push to remote**: build `PushPayload` from mutations + new `snapshot.json`, call `provider.push(payload)`. On `PushConflictError` → retry from step 2 (reuse local ChangeSet, max 3 retries).
6. **Apply to disk**: `apply(mutations, provider)` — write/delete files, emit mutation events. For binary files where `source: "remote"`, calls `provider.get(path)` and pipes to disk.
7. **Save snapshots**: `saveSnapshot(snapshot, mutations)` — write `snapshot.json` + text files to `snapshot.local/`

Push happens before local disk writes. If push fails, no local state has been modified — safe to retry or abort. If push succeeds but local writes fail (unlikely — disk full, permissions), next sync self-heals: remote has the correct state, stale local snapshot triggers a re-pull.

The retry loop reuses the original local ChangeSet because disk hasn't changed during sync (single-flight guarantee from main.md). Only the remote ChangeSet is re-fetched, since the remote may have moved.

## FileState

No changes to the type:

```ts
type FileState =
  | { type: "text", content: string }
  | { type: "binary", hash: string, modified: number }
```

But its role shifts. Previously, `FileState` was used in full maps that reconcile diffed against snapshots. Now, `FileState` appears inside `ChangeSet.added` and `ChangeSet.modified` — change detection has already happened, and `FileState` carries the content/metadata for files that are known to have changed.

## StatusResult

No changes to the type. Status now compares disk to `snapshot.json` hashes rather than reading full snapshot file content. Faster for large stashes.

## Walkthrough updates

The walkthrough in main.md should be updated to reflect:
- Step 1 produces a local ChangeSet (not a full map)
- Step 2 uses `provider.fetch(localSnapshot)` producing a remote ChangeSet
- Step 3 uses `reconcile(localChangeSet, remoteChangeSet)`
- Steps 4-7 follow the new ordering: compute snapshot → push → apply to disk → update local snapshots
- Step 6 writes `snapshot.json` + `snapshot.local/` text files (no binary `.hash` files)
