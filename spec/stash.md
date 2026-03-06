# Stash

Conflict-free synced folders. Multiple editors (humans, AI agents, scripts) read and write the same files concurrently — changes merge automatically.

## Goals

- Simple, small codebase.
- End-to-end tests: init → write files → sync → pull from another machine → edit both sides → sync → verify merge.
- GitHub provider only.
- No MCP. Just directories.

---

## Behavior

### `Stash.init(dir, globalConfig)`

Initializes `dir` as a stash. If the directory already contains files, they are included — nothing is lost or moved.

Calling `Stash.init()` on a directory that is already a stash is a no-op.

### `stash.connect(provider, fields)`

Connects this stash to a provider. One connection per stash per provider. Stored as a map keyed by provider name (supports multiple providers in future). CLI details (prompting, flags) in [cli.md](cli.md).

### `stash.disconnect(provider)`

Removes the connection for the given provider from this stash.

### `stash.sync()`

Syncs local files with configured connections. This is the core operation.

**What happens:**

- Local changes (files created, edited, or deleted since the last sync) are detected.
- Remote changes are fetched.
- Changes are merged and written to disk.
- The merged result is pushed to the remote.

If a file is unchanged on the remote, that file is not touched at all, to ensure that editing can continue uninterrupted.

**Merging rules:**

| Local | Remote | Result |
|-------|--------|--------|
| Unchanged | Unchanged | No action |
| Edited | Unchanged | Local version pushed to remote |
| Unchanged | Edited | Remote version written to disk |
| Edited | Edited | **Merged** — both sets of edits are preserved |
| Created | Doesn't exist | File pushed to remote |
| Doesn't exist | Created | File written to disk |
| Deleted | Unchanged | File deleted on remote |
| Unchanged | Deleted | File deleted locally |
| Deleted | Edited | **Content wins** — file restored with remote edits |
| Edited | Deleted | **Content wins** — file kept with local edits & re-created remotely |
| Deleted | Deleted | File stays deleted |
| Created | Created (same path) | **Merged** as if both edited |

**Text merge:** concurrent edits to the same text file are merged automatically. Edits in different regions merge cleanly. Overlapping edits are resolved with both versions preserved — no data is silently lost.

**Binary files** (anything that isn't valid UTF-8): last-modified wins. No merge attempted.

**First sync** with an empty remote: all local files are pushed up. First sync with a populated remote and no local files: all remote files are pulled down. First sync with both sides populated: files are two-way merged (no snapshot yet, so diff local vs remote directly — less precise than three-way, but no data is lost). The merged result becomes the first snapshot, enabling three-way merges from then on.

**No connection configured:** sync is a no-op.

**Single-flight:** only one sync runs at a time per process. A concurrent call throws `SyncLockError`.

**Cross-process safety:** `sync()` also acquires `.stash/sync.lock` before running. If another process holds the lock, `sync()` throws `SyncLockError`.

Lock details:
- Lock file: `.stash/sync.lock`
- Acquire via atomic create (`wx` flag). If create fails, lock is held.
- Lock file content is JSON:
  ```json
  { "pid": 12345, "startedAt": "2026-03-03T12:00:00Z", "hostname": "machine-a" }
  ```
- Stale TTL: 10 minutes. If `startedAt` is older than 10 minutes, assume crashed process, delete lock, retry acquire once.
- Lock is released in `finally` (delete `.stash/sync.lock`).

### `stash.status()`

Shows:

- Configured connections (if any).
- Files changed locally since the last sync (added, modified, deleted).
- Time since last sync.

### File tracking

- All files in the stash directory are tracked automatically. There is no `stash add`.
- Dotfiles (files/directories starting with `.`) are ignored.
- The `.stash/` metadata directory is ignored.
- Symlinks are ignored.
- Path filtering is shared between scan and watch via a single `isTrackedPath()` utility.

### What users never need to think about

- No branches, no commits, no staging area.
- No conflict markers to resolve manually.
- No pull/push distinction — `sync()` does both.

---

## Architecture

Three components:

- **CLI** — pure UI. Parses commands, prints output. Delegates everything to Stash. Owns global config. See [cli.md](cli.md).
- **Stash** — owns per-stash config, file I/O, snapshots, scanning, merge logic. Coordinates the provider, but doesn't care which provider it is.
- **Provider** — transport only. Does not merge. Does not know about or touch local files. Knows how to talk to a specific connection. Interface implemented by specific providers (e.g. GitHub).

### `.stash/` directory

```
.stash/
├── config.local.json          # connections config (local only, never pushed)
├── snapshot.json              # hashes + modified (also pushed to remote)
├── sync.lock                  # ephemeral sync lock (local only)
└── snapshot.local/            # text content for three-way merge (local only)
    ├── notes/todo.md
    └── README.md
```

- `config.local.json`: per-stash connections config.
- `snapshot.json`: SHA-256 hashes and metadata for all files. Pushed to remote.
- `sync.lock`: cross-process sync lock file. Created only while `sync()` is running. Local only.
- `snapshot.local/`: full text file content for three-way merge base. Local only.

Convention: `*.local.*` and `*.local/` are never pushed to remote.

`sync.lock` is also never pushed to remote.

Updated after every successful sync.

### Stash

```ts
type StashEvents = {
  mutation: FileMutation
}

class Stash extends Emitter<StashEvents> {
  static load(dir: string, globalConfig: GlobalConfig): Promise<Stash>
  static init(dir: string, globalConfig: GlobalConfig): Promise<Stash>

  get connections(): Record<string, ConnectionConfig>

  connect(provider: string, fields: Record<string, string>): Promise<void>
  disconnect(provider: string): Promise<void>

  sync(): Promise<void>                 // emits 'mutation' events as it works
  status(): StatusResult                // synchronous, no network

  // Private: scan disk + snapshot.json → local ChangeSet
  private scan(): ChangeSet

  // Private: apply merge table to two ChangeSets, returns action per file
  private reconcile(local: ChangeSet, remote: ChangeSet): FileMutation[]

  // Private: single-file text merge via diff-match-patch
  // Three-way if snapshot exists, two-way if not (first sync)
  private mergeText(snapshot: string | null, local: string, remote: string): string

  // Private: build new snapshot.json from old snapshot + mutations
  private computeSnapshot(
    oldSnapshot: Record<string, SnapshotEntry>,
    mutations: FileMutation[]
  ): Record<string, SnapshotEntry>

  // Private: write/delete files on disk, emit mutation events
  private apply(mutations: FileMutation[], provider: Provider): Promise<void>

  // Private: write snapshot.json + snapshot.local/ text files to disk
  private saveSnapshot(
    snapshot: Record<string, SnapshotEntry>,
    mutations: FileMutation[]
  ): Promise<void>
}
```

Extends `Emitter` from `@rupertsworld/emitter`. `sync()` emits `mutation` events as actions are applied. CLI subscribes for live output:

```ts
stash.on("mutation", (action) => {
  // action is a FileMutation — CLI decides how to display it
})
await stash.sync()
```

### Error types

```ts
class PushConflictError extends Error {}
class SyncLockError extends Error {}
```

`SyncLockError` is thrown when a sync cannot start because:
- Another sync is already running in this process
- `.stash/sync.lock` is held by another process (and is not reclaimable as stale)

Retry bound: sync uses a shared maximum of **5 attempts** for restart-worthy races (`PushConflictError` and pre-push drift restarts).
Failure contract: when that bound is exceeded, `sync()` throws the last error and stops the cycle (no further push/apply/save in that failed attempt).

`sync()` flow:
0. **Acquire sync lock**: in-process `syncInFlight` check + `.stash/sync.lock` file lock
1. **Scan local**: `scan()` → local `ChangeSet`
2. **Fetch remote**: `provider.fetch(localSnapshot)` → remote `ChangeSet`
3. **Reconcile**: `reconcile(local, remote)` → `FileMutation[]`
4. **Compute snapshot**: `computeSnapshot(oldSnapshot, mutations)` → new `snapshot.json` in memory. Must happen before push because the new snapshot is included in the push payload.
5. **Pre-push drift check**: re-read only mutation-target paths (targeted hash checks, not a full directory scan). If any target path drifted since step 1, restart from step 1 (max 5 attempts).
6. **Push to remote**: build `PushPayload` from mutations + new `snapshot.json`, call `provider.push(payload)`. Skip if the payload has no file writes or deletions **and** the snapshot hasn't changed — nothing to commit. If the snapshot changed (e.g. first sync establishing the baseline), a snapshot-only commit is pushed even with no file changes. On `PushConflictError` → retry from step 2 with fresh remote data.
7. **Pre-apply drift check**: before writing each `disk: "write"` mutation, verify that path still matches the state used for reconcile. If drift is detected, skip that local write (do not overwrite) and continue the cycle.
8. **Apply to disk**: `apply(mutations, provider)` — write/delete files, emit mutation events. For binary files where `source: "remote"`, calls `provider.get(path)` and pipes to disk.
9. **Save snapshots**: `saveSnapshot(snapshot, mutations)` — write `snapshot.json` + text files to `snapshot.local/`
10. **Release sync lock**: clear in-process flag and delete `.stash/sync.lock` in `finally`

Push happens before local disk writes. If push fails, no local state has been modified — safe to retry or abort. If push succeeds but local writes fail (unlikely — disk full, permissions), next sync self-heals: remote has the correct state, stale local snapshot triggers a re-pull.

Race handling: local files may change while sync is in flight. Drift checks are path-targeted (per mutation path), not full rescans. Pre-push drift restarts the cycle with a fresh scan (bounded to 5 attempts). Post-push drift does not restart; drifted local writes are skipped so newer local edits are preserved and converge on a later sync.

Snapshot guarantee: `snapshot.json` and `snapshot.local/` represent the synchronized state for that cycle, except paths skipped by post-push drift protection. For skipped paths, local snapshot entries intentionally remain at the prior base so the next sync treats both sides as changed and re-merges. They are not a lock on future disk state — files may change immediately after apply/save, and those newer local edits are picked up on the next sync.

Provider is constructed once per `sync()` call as a local variable. It is stateful within a sync cycle — `fetch()` stores the remote HEAD commit SHA internally, `push()` uses it as the parent commit for conflict detection. Not stored as a Stash instance property — each sync starts fresh.

### Sync lock

`sync()` uses two guards:

1. **In-process guard** (`syncInFlight`) — prevents concurrent sync calls in the same process.
2. **Cross-process file lock** (`.stash/sync.lock`) — prevents concurrent sync calls across processes.

Acquire order in `sync()`:

1. Check `syncInFlight`; if true, throw `SyncLockError`.
2. Acquire `.stash/sync.lock`.
3. Set `syncInFlight = true`.
4. Run sync steps.
5. In `finally`: clear `syncInFlight` and delete `.stash/sync.lock`.

Acquire uses atomic file create (`wx`). If create fails, `sync()` reads lock metadata and checks staleness:
- Parse `startedAt` from lock JSON.
- If lock is older than 10 minutes, delete lock and retry `wx` once.
- If retry still fails, throw `SyncLockError`.

Lock metadata:

```json
{ "pid": 12345, "startedAt": "2026-03-03T12:00:00Z", "hostname": "machine-a" }
```

### Path filtering

The tracked-path predicate is a shared utility in `src/utils/`:

```ts
function isTrackedPath(path: string): boolean
```

Rules:
- Regular paths return `true`
- Dotfiles and files inside dot-directories return `false`
- Paths under `.stash/` return `false`

Symlink filtering remains filesystem-based (`lstat().isSymbolicLink()`), but both scan and watch use the same `isTrackedPath()` predicate first so path inclusion rules stay identical.

### Provider

```ts
interface Provider {
  fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet>
  get(path: string): Promise<Readable>
  push(payload: PushPayload): Promise<void>
}
```

- `fetch()` returns what changed on the remote since last sync. First verifies the repo is accessible — if the repo returns 404, sync fails with a clear error rather than silently returning no changes. `localSnapshot` is the local `snapshot.json` content — provider compares hashes against remote `snapshot.json` to determine what changed, then fetches only changed file content. If `localSnapshot` is undefined (first sync): all remote files returned as `added`. Text content is included inline because merge always needs both versions. Binary content is not — reconcile decides via last-modified-wins whether remote bytes are even needed.
- `get()` streams a single binary file from remote. Called after reconcile, only for binary files where reconcile determined `source: "remote"`.
- `push()` applies writes and deletes. Always preceded by a `fetch()`. Only fast-forward failures (remote ref moved since fetch) are retried as push conflicts. Other 422 errors (rulesets, permissions) are surfaced directly as non-retryable errors.

On push, if the remote ref has moved since fetch (another machine synced), the provider throws `PushConflictError`. It does not retry — that's Stash's responsibility.

### Provider Spec

Providers declare their configuration requirements via a static spec:

```ts
interface ProviderSpec {
  setup: Field[]      // global, one-time (e.g. token)
  connect: Field[]    // per-stash (e.g. repo)
}

interface Field {
  name: string
  label: string
  secret?: boolean    // masks input in prompts
}
```

Example:

```ts
class GitHubProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [{ name: "token", label: "Personal access token", secret: true }],
    connect: [{ name: "repo", label: "Repository (user/repo)" }]
  }

  constructor(config: { token: string, repo: string }) { ... }
}
```

Provider registry is a simple name→class map:

```ts
const providers = { github: GitHubProvider }
```

### ChangeSet

The core data structure for change detection. Both local scanning and remote fetching produce a ChangeSet — a summary of what changed since the last sync.

```ts
interface ChangeSet {
  added: Map<string, FileState>       // files new since last sync
  modified: Map<string, FileState>    // files changed since last sync
  deleted: string[]                   // files removed since last sync
}
```

Uses the same `FileState` type — text files have content, binary files have hash + modified.

**Local ChangeSet** is produced by `scan()` — reading disk and comparing to `snapshot.json` hashes. A file whose content hash differs from `snapshot.json` is `modified`. A file on disk with no entry in `snapshot.json` is `added`. An entry in `snapshot.json` with no file on disk is `deleted`.

**Remote ChangeSet** is produced by the provider's `fetch()`. It fetches the remote `snapshot.json`, compares hashes against the `localSnapshot` passed in, and only downloads content for files that differ.

### snapshot.json

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
- `modified`: only present for binary files. Epoch milliseconds (`Date.now()`). Set from `fs.stat().mtimeMs` at push time — the filesystem modification time of the file when it was pushed. Used for last-modified-wins tiebreaker when both sides edit a binary file.

**Why `mtime`, not push time:** using the file's actual modification time means the most recently *edited* file wins, not the most recently *synced*. This matters when a machine is offline: if Machine A edits a file Monday and syncs Wednesday, while Machine B edited the same file Tuesday, Machine B's edit wins because it was edited more recently — even though Machine A synced later. Push time would incorrectly let Machine A's stale Monday edit overwrite Machine B's newer work.

Pushed to remote as part of each sync commit. This is what makes efficient change detection possible — the provider can fetch one small JSON file and know exactly what changed.

### Stash.reconcile()

Takes two ChangeSets — returns a `FileMutation` for every file that appears in at least one. Unchanged files are not in either set and are never touched. Fully resolved — `sync()` just executes these without making any decisions.

Change detection has already happened before reconcile — by the time it runs, we know exactly which files were added, modified, or deleted on each side. Reconcile applies the merge table to these change types directly.

For text files that appear as `modified` or `added` on both sides, reconcile calls `mergeText()` using the snapshot from `snapshot.local/` as the three-way base.

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

Merge table:

| Local | Remote | disk | remote | content / source |
|-------|--------|------|--------|------------------|
| modified | — | skip | write | local content |
| — | modified | write | skip | remote content |
| modified | modified (text) | write or skip | write or skip | merged via `mergeText()` — skip if merged equals that side's content |
| modified | modified (binary) | write or skip | write or skip | source: last-modified wins — skip if hashes equal |
| added | — | skip | write | local content |
| — | added | write | skip | remote content |
| added | added (text) | write or skip | write or skip | merged via `mergeText()` — skip if merged equals that side's content |
| added | added (binary) | write or skip | write or skip | source: last-modified wins — skip if hashes equal |
| deleted | — | skip | delete | — |
| — | deleted | delete | skip | — |
| deleted | modified | write | skip | remote content (content wins) |
| modified | deleted | skip | write | local content (content wins) |
| deleted | deleted | skip | skip | — |

### Stash.mergeText()

Single-file text merge via diff-match-patch (Google's algorithm, same as Obsidian Sync).

```ts
mergeText(snapshot: string | null, local: string, remote: string): string
```

- If snapshot exists: three-way merge (diff snapshot→local + diff snapshot→remote, apply both).
- If no snapshot (first sync): two-way merge (diff local vs remote directly).

### FileState

The state of a file that is known to have changed. Used inside `ChangeSet.added` and `ChangeSet.modified` maps where the key is the file path.

```ts
type FileState =
  | { type: "text", content: string }
  | { type: "binary", hash: string, modified: number }
```

- **Text**: full content string. Change detection has already happened (via `snapshot.json` hash comparison) before FileState is constructed.
- **Binary**: SHA-256 hash. `modified` is epoch ms — from `fs.stat().mtimeMs` for local files, from `snapshot.json` for remote files. Used for last-modified-wins. Actual binary bytes are fetched separately via `provider.get()` or read from disk.

### PushPayload

Built from `FileMutation[]` — Stash filters for mutations where `remote` is `"write"` or `"delete"`. Includes the updated `snapshot.json` to push alongside file changes in the same commit. Provider just executes. Always preceded by a `fetch()`.

```ts
interface PushPayload {
  files: Map<string, string | (() => Readable)>  // path → text content or binary stream
  deletions: string[]                              // paths to delete on remote
  snapshot: Record<string, SnapshotEntry>          // updated snapshot.json to push
}
```

- **Text files**: passed as strings (from `FileMutation.content`).
- **Binary files**: passed as a lazy stream factory (from `FileMutation.source` — Stash opens a read stream from disk).
- **Deletions**: paths where `remote: "delete"`.
- **Snapshot**: the computed `snapshot.json` content, pushed in the same commit as file changes.

### StatusResult

Returned by `status()`. Scans disk vs `snapshot.json` hashes — no network calls.

```ts
interface StatusResult {
  added: string[]       // files on disk, no snapshot
  modified: string[]    // files on disk that differ from snapshot
  deleted: string[]     // files in snapshot, not on disk
  lastSync: Date | null
}
```

Connections available via `stash.connections`.

---

## Config

### Overview

Config is split into two layers with clear ownership:

- **Global config** — CLI-owned. Provider setup data (auth tokens, API keys) that spans all stashes. One file per machine.
- **Per-stash config** — Stash-owned. Connection data specific to this stash. Lives inside `.stash/`.

Neither layer knows how the other is stored or managed. They meet at `Stash.load(dir, globalConfig)` — CLI passes global config in, Stash merges with local config internally.

### Per-stash config

Location: `.stash/config.local.json`. Never pushed to remote (`.local.` convention).

Managed by Stash via `connect()` / `disconnect()` methods. Written by `stash connect <provider>`.

Shape — `connections` map keyed by provider name:
```json
{
  "connections": {
    "github": {
      "repo": "user/repo"
    }
  }
}
```

Fields defined by the provider's `ProviderSpec.connect`.

### How Stash manages config

Stash holds `globalConfig` and `_connections` in memory. `load()` reads `.stash/config.local.json` once at startup. `connect()` and `disconnect()` update `_connections` in memory and write to disk — no hidden I/O on property access.

```ts
class Stash {
  private globalConfig: GlobalConfig
  private _connections: Record<string, ConnectionConfig>

  get connections() { return this._connections }

  connect(provider, fields) {
    this._connections[provider] = fields
    writeJson(".stash/config.local.json", { connections: this._connections })
  }

  disconnect(provider) {
    delete this._connections[provider]
    writeJson(".stash/config.local.json", { connections: this._connections })
  }
}
```

### Provider construction

When a provider is needed (e.g. during `sync()`):

1. Look up provider class from registry by name
2. Merge `globalConfig[name]` + `_connections[name]` into the provider's typed config
3. Pass to provider constructor

```ts
const name = "github"
const provider = new GitHubProvider({
  ...this.globalConfig[name],
  ...this._connections[name]
})
// GitHubConfig { token: "ghp_...", repo: "user/repo" }
```

Each provider defines its own config type (e.g. `GitHubConfig`). Provider receives a typed config object. It never reads or writes config files.

CLI flows for `stash setup` and `stash connect` are in [cli.md](cli.md).

---

## Sync Walkthrough

A concrete example of the full sync process.

### Setup

Machine A and Machine B share a stash connected to GitHub repo `user/notes`. Both last synced when the stash contained:

```
hello.md    → "hello world"
image.png   → <binary, hash: abc123>
```

Since the last sync:
- **Machine A** (local): edited `hello.md` to `"hello brave world"`, added `new.md` with `"draft"`, deleted `image.png`.
- **Machine B** (remote): edited `hello.md` to `"hello world!"`, added `photo.jpg`.

Machine A calls `stash.sync()`.

### Step 1: Scan local

`scan()` reads all files from disk, hashes them, compares to `snapshot.json`:

```
snapshot.json (from last sync):
  hello.md  → { hash: "sha256-of-hello-world" }
  image.png → { hash: "sha256-of-image", modified: 1709121600000 }
```

```
local ChangeSet = {
  added:    { "new.md":    { type: "text", content: "draft" } },
  modified: { "hello.md":  { type: "text", content: "hello brave world" } },
  deleted:  ["image.png"]
}
```

- `hello.md`: content hash differs from snapshot → `modified`
- `new.md`: on disk, not in snapshot.json → `added`
- `image.png`: in snapshot.json, not on disk → `deleted`

### Step 2: Fetch remote

`provider.fetch(localSnapshot)` fetches remote `snapshot.json`, compares hashes against local snapshot, downloads only changed content:

```
remote snapshot.json:
  hello.md  → { hash: "sha256-of-hello-world!" }     # differs from local snapshot
  image.png → { hash: "sha256-of-image" }             # same — not fetched
  photo.jpg → { hash: "sha256-of-photo", modified: 1709290800000 }  # new
```

```
remote ChangeSet = {
  added:    { "photo.jpg": { type: "binary", hash: "sha256-of-photo", modified: 1709290800000 } },
  modified: { "hello.md":  { type: "text", content: "hello world!" } },
  deleted:  []
}
```

Note: `image.png` has the same hash in both snapshots — it's not in the remote ChangeSet. Only `hello.md` (hash differs) and `photo.jpg` (not in local snapshot) are included.

### Step 3: Reconcile

`reconcile(local, remote)` walks files that appear in at least one ChangeSet: `hello.md`, `new.md`, `image.png`, `photo.jpg`.

**`hello.md`** — modified locally + modified remotely → both edited (text).
- Calls `mergeText("hello world", "hello brave world", "hello world!")` → `"hello brave world!"`
- → `{ path: "hello.md", disk: "write", remote: "write", content: "hello brave world!" }`

**`new.md`** — added locally, absent from remote ChangeSet (—) → push.
- → `{ path: "new.md", disk: "skip", remote: "write", content: "draft" }`

**`image.png`** — deleted locally, absent from remote ChangeSet (—) → delete on remote.
- → `{ path: "image.png", disk: "skip", remote: "delete" }`

**`photo.jpg`** — absent from local ChangeSet (—), added remotely → write to disk (binary).
- → `{ path: "photo.jpg", disk: "write", remote: "skip", source: "remote", hash: "sha256-of-photo", modified: 1709290800000 }`

### Step 4: Compute snapshot

`computeSnapshot(oldSnapshot, mutations)` — start from old snapshot, apply mutations:

```json
{
  "hello.md": { "hash": "sha256-of-hello-brave-world!" },
  "new.md": { "hash": "sha256-of-draft" },
  "photo.jpg": { "hash": "sha256-of-photo", "modified": 1709290800000 }
}
```

`image.png` removed. `hello.md` and `new.md` hashes computed from content strings. `photo.jpg` hash and modified taken from the mutation.

### Step 5: Push to remote

Build `PushPayload` from mutations where `remote` is `"write"` or `"delete"`, plus the computed snapshot:

```
PushPayload:
  files:
    hello.md → "hello brave world!"
    new.md   → "draft"
  deletions:
    image.png
  snapshot:
    (the snapshot.json computed in step 4)
```

Before `provider.push(payload)`, sync re-checks only mutation-target paths against the scanned local state (targeted hash reads). If any drifted, restart from step 1. If push fails due to `PushConflictError` (another machine synced), retry from step 2 with fresh remote data.

### Step 6: Apply to disk

Before writing each `disk: "write"` mutation, sync re-checks that target path for drift. If drift is found, skip that local write (no overwrite, no restart). Otherwise `apply(mutations, provider)`:

- `hello.md`: write `"hello brave world!"` to disk.
- `photo.jpg`: binary, `source: "remote"` → call `provider.get("photo.jpg")`, pipe stream to disk.
- Emit `mutation` events for each.

### Step 7: Save snapshots

`saveSnapshot(snapshot, mutations)`:

- Write `snapshot.json` (from step 4) to `.stash/snapshot.json`.
- Write text content to `snapshot.local/`:

```
.stash/snapshot.local/
  hello.md   → "hello brave world!"
  new.md     → "draft"
```

`image.png` removed from both. These become the base for the next sync's three-way merge.

### Result

After sync, Machine A's disk:
```
hello.md   → "hello brave world!"   (merged)
new.md     → "draft"                 (unchanged, now on remote too)
photo.jpg  → <binary from remote>    (pulled)
```

Remote:
```
hello.md   → "hello brave world!"   (merged)
new.md     → "draft"                 (pushed)
photo.jpg  → <binary>                (unchanged)
```

`image.png` is gone from both sides. No data was lost — every edit from both machines is preserved.

---

## Tests

Unit and integration tests for Stash core. End-to-end tests are in `tests.md`.

### Test Helpers

#### FakeProvider

An in-memory implementation of the `Provider` interface for testing Stash without network access. Stores files in a `Map<string, string | Buffer>` and a snapshot `Record<string, SnapshotEntry>`.

```ts
class FakeProvider implements Provider {
  files: Map<string, string | Buffer>
  snapshot: Record<string, SnapshotEntry>
  pushLog: PushPayload[]              // records all push() calls for assertions

  fetch(localSnapshot?): Promise<ChangeSet>   // diffs this.snapshot vs localSnapshot
  get(path): Promise<Readable>                // streams from this.files
  push(payload): Promise<void>                // applies to this.files + this.snapshot, logs to pushLog
}
```

- `fetch()` compares its internal snapshot against the passed `localSnapshot`, returns a ChangeSet of differences. Text files have inline content from `this.files`. Binary files have hash + modified from `this.snapshot`.
- `push()` applies the payload to its internal state (writes files, removes deletions, updates snapshot). Also appends the payload to `pushLog` for test assertions.
- Can be configured to throw `PushConflictError` on the next `push()` call (for retry testing).

#### Provider injection

Stash normally constructs a provider from the registry during `sync()`. For testing, the provider registry is overridable — tests register `FakeProvider` under a test provider name, or Stash accepts a provider factory option that tests can use to inject `FakeProvider` directly. The exact mechanism is an implementation detail, but the key requirement is that integration tests can supply their own provider without touching the network.

#### makeStash()

Creates a temp directory, writes files, and returns an initialized Stash. Shorthand for the common test setup.

```ts
async function makeStash(
  files?: Record<string, string | Buffer>,
  opts?: { snapshot?: Record<string, SnapshotEntry>, snapshotLocal?: Record<string, string> }
): Promise<{ stash: Stash, dir: string }>
```

- Writes files to disk.
- If `snapshot` provided, writes `.stash/snapshot.json` and `.stash/snapshot.local/` — simulates a stash that has already synced.
- Returns both the Stash instance and the directory path (for direct filesystem assertions).

#### makeChangeSet()

Builds a `ChangeSet` from a concise description. Avoids verbose Map construction in every test.

```ts
function makeChangeSet(desc: {
  added?: Record<string, FileState>,
  modified?: Record<string, FileState>,
  deleted?: string[]
}): ChangeSet
```

### Unit Tests

#### scan()

Scan reads all files from disk, hashes them, and compares against `snapshot.json` to produce a local ChangeSet.

```
1. No snapshot (first sync) — all files on disk are `added`
   - Write hello.md and notes/todo.md to disk, no .stash/snapshot.json
   - scan() → added: { "hello.md": ..., "notes/todo.md": ... }, modified: empty, deleted: empty

2. Unchanged files — empty ChangeSet
   - Write hello.md, create matching snapshot.json with correct hash
   - scan() → all empty

3. Modified file — detected by hash mismatch
   - Write hello.md ("changed"), snapshot.json has hash of "original"
   - scan() → modified: { "hello.md": { type: "text", content: "changed" } }

4. Deleted file — in snapshot but not on disk
   - snapshot.json has hello.md, but file doesn't exist on disk
   - scan() → deleted: ["hello.md"]

5. New file — on disk but not in snapshot
   - Write new.md, snapshot.json exists but doesn't include new.md
   - scan() → added: { "new.md": ... }

6. Dotfiles excluded
   - Write .hidden and .config/settings.json alongside visible.md
   - scan() → only visible.md appears

7. Symlinks excluded
   - Write real.md, create symlink link.md → real.md
   - scan() → only real.md appears

8. .stash/ directory excluded
   - Write .stash/config.local.json and .stash/snapshot.local/hello.md alongside visible.md
   - scan() → only visible.md appears (all .stash/ contents ignored)

9. Binary file detection
   - Write a file with invalid UTF-8 bytes
   - scan() → FileState has type: "binary" with hash and modified

10. Nested directories
    - Write a/b/c.md
    - scan() → added: { "a/b/c.md": ... } (path preserved)

11. Empty file
    - Write empty.md with empty content
    - scan() → correctly detected, type: "text", content: ""
```

#### reconcile()

Takes two ChangeSets, returns FileMutation[]. Each row of the merge table gets a test. Uses `makeChangeSet()` for inputs.

For tests involving text merge (both-modified, both-added), the snapshot.local content must be available. Reconcile reads the three-way base from `.stash/snapshot.local/` on disk — so tests must write the base content there via `makeStash({ snapshotLocal: { "a.md": "base content" } })`.

```
1.  Local modified, remote unchanged
    - local: modified { "a.md": text "new" }
    - remote: empty
    - → { path: "a.md", disk: "skip", remote: "write", content: "new" }

2.  Local unchanged, remote modified
    - local: empty
    - remote: modified { "a.md": text "new" }
    - → { path: "a.md", disk: "write", remote: "skip", content: "new" }

3.  Both modified (text) — calls mergeText()
    - local: modified { "a.md": text "local" }
    - remote: modified { "a.md": text "remote" }
    - snapshot.local has base content
    - → { path: "a.md", disk: "write", remote: "write", content: <merged> }

4.  Both modified (binary) — last-modified-wins
    - local: modified { "img.png": binary, hash: "aaa", modified: T1 }
    - remote: modified { "img.png": binary, hash: "bbb", modified: T2 }
    - T2 > T1 → source: "remote"
    - T1 > T2 → source: "local"

5.  Local added, remote absent
    - local: added { "new.md": text "draft" }
    - → { disk: "skip", remote: "write", content: "draft" }

6.  Remote added, local absent
    - remote: added { "new.md": text "draft" }
    - → { disk: "write", remote: "skip", content: "draft" }

7.  Both added (text) — merged
    - local: added { "notes.md": text "A" }
    - remote: added { "notes.md": text "B" }
    - → { disk: "write", remote: "write", content: <merged> }

8.  Both added (binary) — last-modified-wins
    - Same as test 4 but with added instead of modified

9.  Local deleted, remote absent
    - local: deleted ["old.md"]
    - → { disk: "skip", remote: "delete" }

10. Remote deleted, local absent
    - remote: deleted ["old.md"]
    - → { disk: "delete", remote: "skip" }

11. Local deleted, remote modified — content wins
    - local: deleted ["a.md"]
    - remote: modified { "a.md": text "saved" }
    - → { disk: "write", remote: "skip", content: "saved" }

12. Local modified, remote deleted — content wins
    - local: modified { "a.md": text "saved" }
    - remote: deleted ["a.md"]
    - → { disk: "skip", remote: "write", content: "saved" }

13. Both deleted
    - local: deleted ["a.md"]
    - remote: deleted ["a.md"]
    - → { disk: "skip", remote: "skip" }
```

#### mergeText()

Tests the diff-match-patch merge function directly.

```
1. Three-way, non-overlapping edits
   - snapshot: "line1\nline2\nline3"
   - local: "LINE1\nline2\nline3"
   - remote: "line1\nline2\nLINE3"
   - → "LINE1\nline2\nLINE3"

2. Three-way, overlapping edits — both preserved
   - snapshot: "hello world"
   - local: "hello brave world"
   - remote: "hello cruel world"
   - → result contains both "brave" and "cruel"

3. Two-way merge (no snapshot)
   - snapshot: null
   - local: "aaa\nbbb"
   - remote: "bbb\nccc"
   - → result contains content from both sides

4. One side unchanged
   - snapshot: "original"
   - local: "original"
   - remote: "changed"
   - → "changed"

5. Both sides make identical edit
   - snapshot: "old"
   - local: "new"
   - remote: "new"
   - → "new"

6. Empty content
   - snapshot: ""
   - local: "added"
   - remote: ""
   - → "added"
```

#### computeSnapshot()

Pure function: takes old snapshot + mutations, returns new snapshot.

```
1. Add new text file
   - old: { "a.md": { hash: "aaa" } }
   - mutation: { path: "b.md", content: "hello" }
   - → new snapshot has both a.md (unchanged) and b.md (hash of "hello")

2. Remove file deleted locally (pushed deletion to remote)
   - old: { "a.md": { hash: "aaa" }, "b.md": { hash: "bbb" } }
   - mutation: { path: "b.md", disk: "skip", remote: "delete" }
   - → new snapshot has only a.md

3. Remove file deleted remotely (applied deletion to disk)
   - old: { "a.md": { hash: "aaa" }, "b.md": { hash: "bbb" } }
   - mutation: { path: "b.md", disk: "delete", remote: "skip" }
   - → new snapshot has only a.md

4. Update modified text file
   - old: { "a.md": { hash: "old-hash" } }
   - mutation: { path: "a.md", content: "new content" }
   - → new snapshot a.md hash matches SHA-256 of "new content"

5. Binary file — uses hash and modified from mutation
   - mutation: { path: "img.png", source: "remote", hash: "abc", modified: 1709290800000 }
   - → snapshot entry: { hash: "abc", modified: 1709290800000 }

6. No mutations — snapshot unchanged
   - old: { "a.md": { hash: "aaa" } }
   - mutations: []
   - → identical to old
```

#### isValidText()

```
1. Valid UTF-8 string → true
2. ASCII-only bytes → true
3. Valid multi-byte UTF-8 (emoji, CJK) → true
4. Invalid byte sequence (0xFF 0xFE) → false
5. Latin-1 with bytes > 127 that aren't valid UTF-8 → false
6. Empty buffer → true (empty file is text)
7. Null bytes → false (binary indicator)
```

#### status()

```
1. No snapshot (never synced) — all files are added, lastSync is null
2. All files match snapshot — empty result, lastSync is set
3. Mix of added, modified, deleted — each list populated correctly
4. Connections returned from stash.connections
```

#### sync lock

```
1. Lock acquired and released on successful sync
   - makeStash with files, connect, FakeProvider
   - sync()
   - .stash/sync.lock does not exist after sync completes

2. Lock released on sync failure
   - makeStash, connect, FakeProvider that throws on push
   - sync() → throws
   - .stash/sync.lock does not exist

3. SyncLockError when lock held by another process
   - makeStash, connect
   - Manually write .stash/sync.lock with recent startedAt
   - sync() → throws SyncLockError

4. Stale lock is reclaimed
   - makeStash, connect, FakeProvider
   - Write .stash/sync.lock with startedAt 15 minutes ago
   - sync() → succeeds (stale lock reclaimed)
   - .stash/sync.lock does not exist after sync

5. Stale lock reclaim race
   - makeStash, connect
   - Write .stash/sync.lock with startedAt 15 minutes ago
   - Delete lock and immediately re-create with recent startedAt (simulate race)
   - sync() → throws SyncLockError

6. In-process single-flight throws SyncLockError
   - Start sync() with a slow FakeProvider
   - Call sync() again concurrently
   - Second call throws SyncLockError
   - First completes normally
```

#### isTrackedPath()

```
1. Regular file path → true
2. Dotfile (.hidden) → false
3. Dot-directory (.config/settings.json) → false
4. .stash/ path → false
5. Nested regular path (a/b/c.md) → true
```

### Integration Tests

Integration tests use `FakeProvider` to test `sync()` end-to-end without network access. They verify the full flow: scan → fetch → reconcile → compute snapshot → push → apply → save snapshot.

#### sync() with FakeProvider

```
1. First sync pushes all local files
   - makeStash with files, connect, FakeProvider with empty state
   - sync()
   - FakeProvider.files has all local files
   - FakeProvider.snapshot matches
   - .stash/snapshot.json written
   - .stash/snapshot.local/ has text file contents

2. First sync pulls all remote files
   - makeStash with no files, FakeProvider has files + snapshot
   - sync()
   - Files appear on disk
   - .stash/snapshot.json and snapshot.local/ written

3. Merge cycle
   - makeStash with hello.md, sync (pushes to FakeProvider)
   - Modify hello.md on disk
   - Modify hello.md in FakeProvider (different region)
   - sync()
   - Disk has merged content
   - FakeProvider has merged content
   - Snapshots match

4. Push payload correctness
   - Sync with local edits
   - Inspect FakeProvider.pushLog
   - Verify files, deletions, and snapshot are all correct in the payload

5. Mutation events emitted
   - Subscribe to stash.on("mutation")
   - sync()
   - Verify mutation events match the expected FileMutation list

6. PushConflictError triggers retry
   - Configure FakeProvider to throw PushConflictError on first push()
   - sync()
   - Verify push was called twice (retry succeeded)
   - Verify final state is correct

7. Max retries exceeded
   - Configure FakeProvider to always throw PushConflictError
   - sync() → throws after 5 retries
   - Verify push call count is exactly 5 (bounded retry)

8. No connection — sync is a no-op
   - makeStash with no connection
   - sync()
   - No errors, no FakeProvider interactions

9. Single-flight guard
   - Start sync() (use a slow FakeProvider that delays)
   - Start second sync() concurrently
   - Second call rejects or waits
   - First completes normally

10. Snapshot.local/ updated correctly
    - Sync with text files
    - Verify .stash/snapshot.local/ contains the correct text content
    - Verify binary files are NOT in snapshot.local/

11. Deleted files cleaned from snapshot.local/
    - Sync, then delete a file, sync again
    - Verify file removed from .stash/snapshot.local/

12. Pre-push drift: preserve in-flight local text edits
    - Start sync() with a local edit and a remote edit to the same file
    - Block provider.fetch() so local can change after initial scan
    - Change local file while sync is in-flight
    - Unblock sync and verify final file contains latest local edit + remote edit

13. Post-push drift: preserve local edits made before apply
    - Start sync() with a local edit and a remote edit to the same file
    - Block provider.push() after remote write succeeds, before apply()
    - Change local file while sync is paused
    - Unblock sync and verify local file keeps the newer local edit (no overwrite)
    - Verify convergence with remote merge on a subsequent sync cycle

14. Drift retries are bounded
    - Force repeated pre-push drift detection on each cycle
    - sync() retries restart loop up to exactly 5 attempts
    - Verify sync() throws once limit is exceeded
    - Verify retry count is exactly 5 (no unbounded loop)
    - Verify failed cycle does not continue to apply/save after terminal failure
```

#### connect() / disconnect()

```
1. connect writes to config.local.json
   - stash.connect("github", { repo: "user/repo" })
   - Read .stash/config.local.json → has github connection

2. disconnect removes from config.local.json
   - Connect then disconnect
   - Read .stash/config.local.json → no github connection

3. config getter merges global + local
   - Create stash with globalConfig: { github: { token: "t" } }
   - Connect with { repo: "r" }
   - stash.config → { github: { token: "t", repo: "r" } }
```
