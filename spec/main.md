# Stash

Conflict-free synced folders. Multiple editors (humans, AI agents, scripts) read and write the same files concurrently — changes merge automatically.

## Goals

- Simple, small codebase.
- End-to-end tests: init → write files → sync → pull from another machine → edit both sides → sync → verify merge.
- GitHub provider only.
- No daemon, no MCP, no global registry. Just directories.

---

## Behavior

### `stash init`

Initializes the current directory as a stash. If the directory already contains files, they are included — nothing is lost or moved.

Running `stash init` in a directory that is already a stash informs the user, tells them they can delete the .stash directory if they need, and does nothing.

### `stash setup <provider>`

Configures global provider settings (e.g. auth). Provider declares required fields via its static spec. Accepts `--field value` flags or prompts interactively.

Example: `stash setup github --token ghp_...` or `stash setup github` (prompts for token).

### `stash connect <provider>`

Connects this stash to a provider. Provider declares required connection fields via its static spec. Accepts `--field value` flags or prompts interactively. If setup has not been done for this provider, prompts for setup fields too.

Example: `stash connect github --repo user/repo` or `stash connect github` (prompts).

One connection per stash per provider. Stored as a map keyed by provider name (supports multiple providers in future).

### `stash disconnect <provider>`

Removes the connection for the given provider from this stash.

### `stash sync`

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

**Single-flight:** only one sync runs at a time.

### `stash status`

Shows:

- Configured connections (if any).
- Files changed locally since the last sync (added, modified, deleted).
- Time since last sync.

### File tracking

- All files in the stash directory are tracked automatically. There is no `stash add`.
- Dotfiles (files/directories starting with `.`) are ignored.
- The `.stash/` metadata directory is ignored.
- Symlinks are ignored.

### What users never need to think about

- No branches, no commits, no staging area.
- No conflict markers to resolve manually.
- No pull/push distinction — `stash sync` does both.
- No daemon or background process required (but one could be added later to auto-sync).

---

## Architecture

Three components:

- **CLI** — pure UI. Parses commands, prints output. Delegates everything to Stash. Owns global config.
- **Stash** — owns per-stash config, file I/O, snapshots, scanning, merge logic. Coordinates the provider.
- **Provider** — transport only. Does not merge. Knows how to talk to a specific connection. Interface implemented by specific providers (e.g. GitHub).

### `.stash/` directory

```
.stash/
├── config.local.json          # connections config (local only, never pushed)
├── snapshot.json              # hashes + modified (also pushed to remote)
└── snapshot.local/            # text content for three-way merge (local only)
    ├── notes/todo.md
    └── README.md
```

- `config.local.json`: per-stash connections config.
- `snapshot.json`: SHA-256 hashes and metadata for all files. Pushed to remote.
- `snapshot.local/`: full text file content for three-way merge base. Local only.

Convention: `*.local.*` and `*.local/` are never pushed to remote.

Updated after every successful sync.

### Stash

```ts
type StashEvents = {
  mutation: FileMutation
}

class Stash extends Emitter<StashEvents> {
  static load(dir: string, globalConfig: GlobalConfig): Promise<Stash>
  static init(dir: string, globalConfig: GlobalConfig): Promise<Stash>

  readonly connections: Record<string, ConnectionConfig>

  connect(provider: string, fields: Record<string, string>): Promise<void>
  disconnect(provider: string): Promise<void>

  sync(): Promise<void>                 // emits 'mutation' events as it works
  status(): StatusResult                // synchronous, no network

  get config(): MergedConfig            // reads local config, merges with globalConfig

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

Extends `Emitter` from `ref/emitter.ts` (typed event emitter using `mitt`). `sync()` emits `mutation` events as actions are applied. CLI subscribes for live output:

```ts
stash.on("mutation", (action) => {
  // action is a FileMutation — CLI decides how to display it
})
await stash.sync()
```

`sync()` flow:
1. **Scan local**: `scan()` → local `ChangeSet`
2. **Fetch remote**: `provider.fetch(localSnapshot)` → remote `ChangeSet`
3. **Reconcile**: `reconcile(local, remote)` → `FileMutation[]`
4. **Compute snapshot**: `computeSnapshot(oldSnapshot, mutations)` → new `snapshot.json` in memory. Must happen before push because the new snapshot is included in the push payload.
5. **Push to remote**: build `PushPayload` from mutations + new `snapshot.json`, call `provider.push(payload)`. On `PushConflictError` → retry from step 2 (reuse local ChangeSet, max 3 retries).
6. **Apply to disk**: `apply(mutations, provider)` — write/delete files, emit mutation events. For binary files where `source: "remote"`, calls `provider.get(path)` and pipes to disk.
7. **Save snapshots**: `saveSnapshot(snapshot, mutations)` — write `snapshot.json` + text files to `snapshot.local/`

Push happens before local disk writes. If push fails, no local state has been modified — safe to retry or abort. If push succeeds but local writes fail (unlikely — disk full, permissions), next sync self-heals: remote has the correct state, stale local snapshot triggers a re-pull.

The retry loop reuses the original local ChangeSet because disk hasn't changed during sync (single-flight guarantee). Only the remote ChangeSet is re-fetched, since the remote may have moved.

Provider is constructed once per `sync()` call as a local variable. It is stateful within a sync cycle — `fetch()` stores the remote HEAD commit SHA internally, `push()` uses it as the parent commit for conflict detection. Not stored as a Stash instance property — each sync starts fresh.

### Provider

```ts
interface Provider {
  fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet>
  get(path: string): Promise<Readable>
  push(payload: PushPayload): Promise<void>
}
```

- `fetch()` returns what changed on the remote since last sync. `localSnapshot` is the local `snapshot.json` content — provider compares hashes against remote `snapshot.json` to determine what changed, then fetches only changed file content. If `localSnapshot` is undefined (first sync): all remote files returned as `added`. Text content is included inline because merge always needs both versions. Binary content is not — reconcile decides via last-modified-wins whether remote bytes are even needed.
- `get()` streams a single binary file from remote. Called after reconcile, only for binary files where reconcile determined `source: "remote"`.
- `push()` applies writes and deletes. Always preceded by a `fetch()`.

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
  "image.png": { "hash": "sha256-def...", "modified": "2026-03-01T12:00:00Z" }
}
```

```ts
type SnapshotEntry =
  | { hash: string }                              // text file
  | { hash: string, modified: string }            // binary file (ISO 8601)
```

- `hash`: SHA-256 of file content. Same algorithm used locally and remotely — hashes are directly comparable.
- `modified`: only present for binary files. Records when the file was last pushed. Used for last-modified-wins tiebreaker when both sides edit a binary file.

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
  modified?: string                    // binary: modified date of winning side (ISO 8601)
}
```

- `content`: present for text files. Used for disk writes, push payload, and snapshot hashing.
- `source`, `hash`, `modified`: present for binary files. `source` tells sync where to stream bytes from. `hash` and `modified` go directly into the new snapshot entry.

Merge table:

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
  | { type: "binary", hash: string, modified?: Date }
```

- **Text**: full content string. Change detection has already happened (via `snapshot.json` hash comparison) before FileState is constructed.
- **Binary**: SHA-256 hash. `modified` is present on local (from `fs.stat()`) and remote (from `snapshot.json`) — used for last-modified-wins. Actual binary bytes are fetched separately via `provider.get()` or read from disk.

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

### Global config

Location: `~/.stash/config.json`. Respects `$XDG_CONFIG_HOME` if set (`$XDG_CONFIG_HOME/stash/config.json`). Directory (`~/.stash/`) allows room for future global state (cache, logs).

Managed by CLI via `readGlobalConfig()` / `writeGlobalConfig()` utility functions. Written by `stash setup <provider>`.

Shape — keyed by provider name, each provider owns its section:
```json
{
  "github": {
    "token": "ghp_..."
  }
}
```

Fields defined by the provider's `ProviderSpec.setup`.

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

### How CLI instantiates Stash

CLI reads global config from disk and passes it into Stash. Stash never reads global config itself.

```ts
const globalConfig = readGlobalConfig()
const stash = await Stash.load(dir, globalConfig)
```

### How Stash manages config

Stash holds `globalConfig` in memory (received at load time, never changes).

`get config()` reads `.stash/config.local.json` from disk each time and merges with `globalConfig`. No caching — the file is tiny, reads are free, and this guarantees config is always fresh after `connect()` / `disconnect()` writes.

```ts
class Stash {
  private globalConfig: GlobalConfig

  get config() {
    const local = readJson(".stash/config.local.json")
    return merge(this.globalConfig, local)
  }

  connect(provider, fields) {
    // write to .stash/config.local.json
    // next config read automatically picks it up
  }
}
```

### Provider construction

When a provider is needed (e.g. during `sync()`):

1. Read `this.config` (merges global + local)
2. Look up provider class from registry by name
3. Pass merged config to provider constructor

```ts
const provider = new GitHubProvider(this.config.connections["github"])
// { token: "ghp_...", repo: "user/repo" }
```

Provider receives a flat config object. It never reads or writes config files.

### CLI flow for `stash setup`

1. Look up provider class from registry
2. Read `ProviderSpec.setup` fields
3. For each field: use `--field value` flag if provided, otherwise prompt interactively (masked if `secret: true`)
4. Write to global config under provider name

### CLI flow for `stash connect`

1. Look up provider class from registry
2. Check global config for setup fields — if missing, prompt for them first (and write to global config)
3. Read `ProviderSpec.connect` fields
4. For each field: use `--field value` flag if provided, otherwise prompt interactively
5. Call `stash.connect(providerName, fields)` — Stash writes to `.stash/config.local.json`

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

Machine A runs `stash sync`.

### Step 1: Scan local

`scan()` reads all files from disk, hashes them, compares to `snapshot.json`:

```
snapshot.json (from last sync):
  hello.md  → { hash: "sha256-of-hello-world" }
  image.png → { hash: "sha256-of-image", modified: "2026-02-28T12:00:00Z" }
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
  photo.jpg → { hash: "sha256-of-photo", modified: "2026-03-01T10:00:00Z" }  # new
```

```
remote ChangeSet = {
  added:    { "photo.jpg": { type: "binary", hash: "sha256-of-photo", modified: 2026-03-01T10:00:00 } },
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
- → `{ path: "photo.jpg", disk: "write", remote: "skip", source: "remote", hash: "sha256-of-photo", modified: "2026-03-01T10:00:00Z" }`

### Step 4: Compute snapshot

`computeSnapshot(oldSnapshot, mutations)` — start from old snapshot, apply mutations:

```json
{
  "hello.md": { "hash": "sha256-of-hello-brave-world!" },
  "new.md": { "hash": "sha256-of-draft" },
  "photo.jpg": { "hash": "sha256-of-photo", "modified": "2026-03-01T10:00:00Z" }
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

`provider.push(payload)` sends this to GitHub. If push fails due to `PushConflictError` (another machine synced), retry from step 2 with fresh remote data (reuse local ChangeSet).

### Step 6: Apply to disk

`apply(mutations, provider)`:

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
