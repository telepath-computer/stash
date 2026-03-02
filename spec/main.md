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

### `stash remote set <provider:path>`

Sets the remote. Example: `stash remote set github:user/repo`. Replaces any existing remote.

One remote per stash (multiple remotes may be supported in future).

### `stash remote`

Shows the current remote, or "no remote configured".

### `stash sync`

Syncs local files with the configured remote. This is the core operation.

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

**No remote configured:** sync is a no-op.

**Single-flight:** only one sync runs at a time.

### `stash status`

Shows:

- Configured remote (if any).
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

- **CLI** — pure UI. Parses commands, prints output. Delegates everything to Stash. See Behavior section above.
- **Stash** — owns everything: config, file I/O, snapshots, scanning, merge logic. Coordinates the provider.
- **Provider** — transport only. Does not merge. Knows how to talk to a specific remote. Interface implemented by specific providers (e.g. GitHub).

### `.stash/` directory

```
.stash/
├── config.json                # remotes, metadata
└── snapshot/                 # last-synced state per file
    ├── notes/todo.md          # text: full content (snapshot for merge)
    ├── README.md              # text: full content
    └── images/photo.jpg.hash  # binary: SHA-256 hash only
```

- **Text snapshots**: full file content, needed for three-way merge.
- **Binary snapshots**: `.hash` file containing SHA-256 — enough to detect changes.
- Updated after every successful sync.

### Stash

```ts
type StashEvents = {
  mutation: FileMutation
}

class Stash extends Emitter<StashEvents> {
  static load(dir: string): Promise<Stash>
  static init(dir: string): Promise<Stash>

  readonly remote: string | null         // current remote, read from config
  setRemote(remote: string): Promise<void>  // writes config, instantiates provider

  sync(): Promise<void>                 // emits 'mutation' events as it works
  status(): StatusResult                // synchronous, no network

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

Provider format: `scheme:address` — extensible to any backend (`github:user/repo`, `s3:bucket/prefix`, `stash://host:port/name`). A `ProviderRegistry` maps scheme prefixes to provider constructors so new providers can be added in future.

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

Remote is available via `stash.remote` — no need to duplicate here.

---

## Sync Walkthrough

A concrete example of the full sync process.

### Setup

Machine A and Machine B share a stash backed by `github:user/notes`. Both last synced when the stash contained:

```
hello.md    → "hello world"
image.png   → <binary, hash: abc123>
```

Since the last sync:
- **Machine A** (local): edited `hello.md` to `"hello brave world"`, added `new.md` with `"draft"`, deleted `image.png`.
- **Machine B** (remote): edited `hello.md` to `"hello world!"`, added `photo.jpg`.

Machine A runs `stash sync`.

### Step 1: Scan local

Stash reads all files from disk and all snapshots from `.stash/snapshot/`.

```
local (disk):
  hello.md  → { type: "text", content: "hello brave world" }
  new.md    → { type: "text", content: "draft" }

snapshots (.stash/snapshot/):
  hello.md  → { type: "text", content: "hello world" }
  image.png → { type: "binary", hash: "abc123" }
```

Local changes detected (by comparing disk to snapshots):
- `hello.md`: modified (content differs from snapshot)
- `new.md`: added (on disk, no snapshot)
- `image.png`: deleted (snapshot exists, not on disk)

### Step 2: Fetch remote

`provider.fetch()` returns:

```
remote:
  hello.md  → { type: "text", content: "hello world!" }
  image.png → { type: "binary", hash: "abc123", modified: 2026-02-28T12:00:00 }
  photo.jpg → { type: "binary", hash: "def456", modified: 2026-03-01T10:00:00 }
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

Write new snapshots reflecting the merged result:

```
.stash/snapshot/
  hello.md   → "hello brave world!"
  new.md     → "draft"
  photo.jpg.hash  → SHA-256 of downloaded bytes
```

`image.png` snapshot is deleted (file no longer exists).

These become the base for the next sync's three-way merge.

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
