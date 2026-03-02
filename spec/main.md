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

  // Private: apply merge table across all files, returns action per file
  private reconcile(
    local: Map<string, FileState>,
    remote: Map<string, FileState>,
    snapshots: Map<string, FileState>
  ): FileMutation[]

  // Private: single-file text merge via diff-match-patch
  // Three-way if snapshot exists, two-way if not (first sync)
  private merge(snapshot: string | null, local: string, remote: string): string
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
1. Scan disk → `local` map. Read `.stash/snapshot/` → `snapshots` map.
2. `provider.fetch()` → `remote` map.
3. `reconcile(local, remote, snapshots)` → `FileMutation[]`.
4. Apply mutations to disk: write/delete text files. For binary files where `source: "remote"`, call `provider.get(path)` and pipe to disk. Emit `mutation` events.
5. Build `PushPayload` from mutations where `remote` is `"write"` or `"delete"`.
6. `provider.push(payload)`.
7. Update snapshots to reflect merged result.

### Provider

```ts
interface Provider {
  // Get metadata + text content for all files on the remote
  fetch(): Promise<Map<string, FileState>>

  // Download a single binary file from the remote
  get(path: string): Promise<Readable>

  // Push changes to the remote
  push(payload: PushPayload): Promise<void>
}
```

- `fetch()` returns metadata for all files. Text files include content. Binary files include hash + modified only.
- `get()` streams a single binary file. Called after reconcile, only for binary files that need downloading.
- `push()` applies writes and deletes. Always preceded by a `fetch()`.

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

### Stash.reconcile()

Takes all local files, remote files, and snapshots. Returns a `FileMutation` for every path in the union of all three sets. Fully resolved — `sync()` just executes these without making any decisions.

Internally, for each path:

1. Determine which sides have the file and whether it changed (by comparing to snapshot).
2. Apply the merge table.
3. For text files where both sides edited: call `merge(snapshot, local, remote)` to produce merged content.
4. For binary files (not valid UTF-8): no merge — `content` is omitted, `source` indicates where `sync()` should copy bytes from.

```ts
interface FileMutation {
  path: string
  disk: "write" | "delete" | "skip"
  remote: "write" | "delete" | "skip"
  content?: string       // text content to write/push. Omitted for binary files.
  source?: "local" | "remote"  // for binary files: where to copy bytes from.
}
```

Mapping from the merge table:

| Local | Remote | disk | remote | content / source |
|-------|--------|------|--------|------------------|
| Unchanged | Unchanged | skip | skip | — |
| Edited | Unchanged | skip | write | local content |
| Unchanged | Edited | write | skip | remote content |
| Edited | Edited (text) | write | write | merged via `merge()` |
| Edited | Edited (binary) | write | write | source: last-modified wins |
| Created | Doesn't exist | skip | write | local content |
| Doesn't exist | Created | write | skip | remote content |
| Deleted | Unchanged | skip | delete | — |
| Unchanged | Deleted | delete | skip | — |
| Deleted | Edited | write | skip | remote content (content wins) |
| Edited | Deleted | skip | write | local content (content wins) |
| Deleted | Deleted | skip | skip | — |
| Created | Created (text) | write | write | merged via `merge()` |
| Created | Created (binary) | write | write | source: last-modified wins |

### Stash.merge()

Single-file text merge via diff-match-patch (Google's algorithm, same as Obsidian Sync).

```ts
merge(snapshot: string | null, local: string, remote: string): string
```

- If snapshot exists: three-way merge (diff snapshot→local + diff snapshot→remote, apply both).
- If no snapshot (first sync): two-way merge (diff local vs remote directly).

### FileState

The state of a file as seen by any side (disk, remote, or snapshot). Used in `Map<string, FileState>` where the key is the file path.

```ts
type FileState =
  | { type: "text", content: string }
  | { type: "binary", hash: string, modified?: Date }
```

- **Text**: full content string. Reconcile compares content to snapshot to detect changes.
- **Binary**: SHA-256 hash to detect changes. `modified` is present on local (from `fs.stat()`) and remote (from provider) — used for last-modified-wins. Absent on snapshots (only hash needed to detect changes). Actual binary bytes are fetched separately via `provider.get()` or read from disk.

### PushPayload

Built from `FileMutation[]` — Stash filters for mutations where `remote` is `"write"` or `"delete"`. Provider just executes. Always preceded by a `fetch()`.

```ts
interface PushPayload {
  files: Map<string, string | (() => Readable)>  // path → text content or binary stream
  deletions: string[]                              // paths to delete on remote
}
```

- **Text files**: passed as strings (from `FileMutation.content`).
- **Binary files**: passed as a lazy stream factory (from `FileMutation.source` — Stash opens a read stream from disk).
- **Deletions**: paths where `remote: "delete"`.

### StatusResult

Returned by `status()`. Scans disk vs snapshots — no network calls.

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

Stash reads all files from disk and all snapshots from `.stash/snapshot.json` and `.stash/snapshot.local/`.

```
local (disk):
  hello.md  → { type: "text", content: "hello brave world" }
  new.md    → { type: "text", content: "draft" }

snapshot.json:
  hello.md  → { hash: "sha256-of-hello-world" }
  image.png → { hash: "sha256-of-image", modified: "2026-02-28T12:00:00Z" }
```

Local changes detected (by comparing disk to snapshot.json hashes):
- `hello.md`: modified (content hash differs from snapshot)
- `new.md`: added (on disk, not in snapshot.json)
- `image.png`: deleted (in snapshot.json, not on disk)

### Step 2: Fetch remote

`provider.fetch()` returns:

```
remote:
  hello.md  → { type: "text", content: "hello world!" }
  image.png → { type: "binary", hash: "sha256-of-image", modified: 2026-02-28T12:00:00 }
  photo.jpg → { type: "binary", hash: "sha256-of-photo", modified: 2026-03-01T10:00:00 }
```

### Step 3: Reconcile

`reconcile(local, remote, snapshots)` walks the union of all paths: `hello.md`, `new.md`, `image.png`, `photo.jpg`.

**`hello.md`** — in snapshot, local differs, remote differs → both edited (text).
- Calls `merge("hello world", "hello brave world", "hello world!")` → `"hello brave world!"`
- → `{ path: "hello.md", disk: "write", remote: "write", content: "hello brave world!" }`

**`new.md`** — not in snapshot, on disk, not on remote → created locally.
- → `{ path: "new.md", disk: "skip", remote: "write", content: "draft" }`

**`image.png`** — in snapshot, not on disk, on remote (unchanged from snapshot) → deleted locally, unchanged remotely.
- → `{ path: "image.png", disk: "skip", remote: "delete" }`

**`photo.jpg`** — not in snapshot, not on disk, on remote → created remotely (binary).
- → `{ path: "photo.jpg", disk: "write", remote: "skip", source: "remote" }`

### Step 4: Apply mutations to disk

- `hello.md`: write `"hello brave world!"` to disk.
- `photo.jpg`: binary, `source: "remote"` → call `provider.get("photo.jpg")`, pipe stream to disk.
- Emit `mutation` events for each.

### Step 5: Build PushPayload and push

Filter mutations where `remote` is `"write"` or `"delete"`:

```
PushPayload:
  files:
    hello.md → "hello brave world!"
    new.md   → "draft"
  deletions:
    image.png
```

`provider.push(payload)` sends this to GitHub.

### Step 6: Update snapshots

Write `snapshot.json` reflecting the merged result:

```json
{
  "hello.md": { "hash": "sha256-of-hello-brave-world!" },
  "new.md": { "hash": "sha256-of-draft" },
  "photo.jpg": { "hash": "sha256-of-photo", "modified": "2026-03-01T10:00:00Z" }
}
```

Write text content to `snapshot.local/`:

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
