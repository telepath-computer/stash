# GitHub Provider — Decisions

## Decided

### 1. Storage format
1. All files on main branch
2. Exact same file paths (stash paths = repo paths)
3. One commit per sync push
4. Metadata stored in `.stash/` directory in the repo

### 2. fetch() — text vs binary classification
Use GitHub GraphQL `Blob.isBinary` as fast pre-filter. If GitHub says binary, trust it (hash only). If GitHub says text, verify valid UTF-8 on our side before treating as text — if it fails, treat as binary.

GitHub uses null-byte detection; main.md defines binary as "not valid UTF-8". This two-step approach satisfies both: GitHub filters out obvious binaries cheaply, our UTF-8 check catches edge cases (e.g. Latin-1 files with no null bytes).

### 3. snapshot.json + .stash layout

`snapshot.json` tracks hashes and metadata for all files. Stored both locally and on remote — after a successful sync, both copies are identical. Between syncs they may diverge (remote updated by other machines, local unchanged until next sync).

```json
{
  "hello.md": { "hash": "sha256-abc..." },
  "image.png": { "hash": "sha256-def...", "modified": "2026-03-01T12:00:00Z" }
}
```

- `hash`: SHA-256 of file content (text and binary). Matches local snapshot hashes directly.
- `modified`: only present for binary files — used for last-modified-wins tiebreaker.
- Updated by push() alongside file changes in the same commit.

**Local `.stash/`:**
```
.stash/
├── config.local.json          # remote config (local only)
├── snapshot.json              # hashes + modified (also pushed to remote)
└── snapshot.local/            # text content for three-way merge (local only)
    ├── hello.md
    └── notes/todo.md
```

**Remote:**
```
.stash/snapshot.json           # only this file
```

Convention: `*.local.*` and `*.local/` are never pushed to remote.

Solves three problems at once:
- **fetch() optimization**: download snapshot.json first (1 call), compare hashes to local snapshot.json, only fetch files that differ.
- **Hash mismatch**: everything is SHA-256 of content, no git blob SHA confusion.
- **Binary `modified` date**: included in snapshot.json, no commit history queries needed.

### 4. ChangeSet architecture + sync flow

**ChangeSet** is the core data structure for both local scanning and remote fetching:

```ts
interface ChangeSet {
  added: Map<string, FileState>       // files that are new since last sync
  modified: Map<string, FileState>    // files that changed since last sync
  deleted: string[]                   // files removed since last sync
}
```

Uses the same `FileState` from main.md — text files have content, binary files have hash + modified.

**Sync flow:**

1. **Scan local**: read disk + local `snapshot.json` → local `ChangeSet`
2. **Fetch remote**: `provider.fetch(knownHashes)` → remote `ChangeSet`
3. **Reconcile**: `reconcile(local, remote)` → `FileMutation[]`
4. **Compute snapshot**: build new `snapshot.json` in memory from mutations
5. **Push to remote**: build `PushPayload` from mutations + new `snapshot.json`, `provider.push(payload)`. On ref conflict → retry from step 2 (reuse local ChangeSet, max 3 retries).
6. **Apply to disk**: write/delete files, emit mutation events
7. **Update local snapshots**: write `snapshot.json` + `snapshot.local/` text files

**Example — two machines edited different files:**

Local snapshot.json (last sync):
```json
{ "hello.md": { "hash": "aaa" }, "todo.md": { "hash": "bbb" } }
```

Machine A edited `hello.md`. Machine B (remote) edited `todo.md`.

Step 1 — scan local (compare disk to snapshot.json):
```
local ChangeSet = {
  added: {},
  modified: { "hello.md": { type: "text", content: "hello brave world" } },
  deleted: []
}
```

Step 2 — fetch remote (provider compares remote snapshot.json to knownHashes):
```
remote snapshot.json: { "hello.md": { "hash": "aaa" }, "todo.md": { "hash": "ccc" } }

knownHashes passed in: { "hello.md": "aaa", "todo.md": "bbb" }

todo.md hash differs → fetch its content via GraphQL

remote ChangeSet = {
  added: {},
  modified: { "todo.md": { type: "text", content: "updated todo" } },
  deleted: []
}
```

Step 3 — reconcile: `hello.md` only in local → push. `todo.md` only in remote → write to disk.

**Example — both edited the same file:**

```
local ChangeSet = {
  modified: { "hello.md": { type: "text", content: "hello brave world" } }
}
remote ChangeSet = {
  modified: { "hello.md": { type: "text", content: "hello world!" } }
}
```

Reconcile sees `hello.md` in both → three-way merge using `snapshot.local/hello.md` as base.

**Example — one side deleted, other side edited:**

```
local ChangeSet = {
  deleted: ["notes.md"]
}
remote ChangeSet = {
  modified: { "notes.md": { type: "text", content: "important notes!" } }
}
```

Reconcile: content wins → `notes.md` restored locally with remote content.

**Provider interface:**

```ts
interface Provider {
  // Returns what changed on remote since last sync
  fetch(knownHashes?: Map<string, string>): Promise<ChangeSet>

  // Stream a single binary file from remote
  get(path: string): Promise<Readable>

  // Push resolved changes to remote
  push(payload: PushPayload): Promise<void>
}
```

**PushPayload** — what gets sent to the remote after reconciliation:

```ts
interface PushPayload {
  files: Map<string, string | (() => Readable)>   // text content or binary stream
  deletions: string[]                               // paths to delete
  snapshot: Record<string, SnapshotEntry>           // updated snapshot.json
}
```

Push doesn't distinguish added vs modified — the Git API just writes files.

### 5. push() — API approach
Git Trees + Blobs API:
1. Create blobs — only for binary files (1 call per file, parallel)
2. Create tree — 1 call. Text files + snapshot.json passed inline via `content` field. Binary files referenced by blob SHA from step 1.
3. Create commit — 1 call, points to new tree, parent is the HEAD from fetch.
4. Update ref — 1 call, moves `refs/heads/main` to new commit.

Typical text-only sync: 3 API calls total regardless of file count.
With binary changes: 3 + N binary blob calls (parallel).

### 6. Atomicity / race conditions
If another machine pushes between our fetch() and push(), the update ref call fails (main has moved). Response: retry from fetch with fresh remote data, reuse original local ChangeSet (disk hasn't changed — single-flight guarantee). Max 3 retries, then report error to user.

Push includes `snapshot.json` in the same commit (computed in memory before push). Local disk writes happen only after push succeeds. If local writes fail after successful push, next sync self-heals — remote has correct state, stale local snapshot triggers re-pull.

Provider throws `PushConflictError` on ref update failure — it doesn't know about retries. Stash catches it and retries the fetch/reconcile/push loop, reusing the original local ChangeSet.

Provider is stateful within a sync cycle — `fetch()` stores the HEAD commit SHA, `push()` uses it as parent. Constructed once per `sync()` call as a local variable (not a Stash instance property). If sync is interrupted, the instance is lost — but that's fine: before push, nothing changed anywhere; after push, next sync self-heals via stale snapshot detection.

### 7. Auth, CLI naming + provider spec

**Two phases: setup (global) and connect (per-stash).**

CLI:
```
stash setup github --token ghp_...     # explicit
stash setup github                     # prompts for token

stash connect github --repo user/repo  # explicit (fails if no setup)
stash connect github                   # prompts for token if missing, then repo

stash disconnect                       # removes connection
```

Terminology: "connection" not "remote" throughout. (Requires main.md update.)

**Provider declares its requirements via a static spec:**

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

GitHub provider:
```ts
class GitHubProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [{ name: "token", label: "Personal access token", secret: true }],
    connect: [{ name: "repo", label: "Repository (user/repo)" }]
  }

  constructor(config: { token: string, repo: string }) {
    // merged result of setup + connect fields
  }
}
```

**Config split:**

Global config lives at `~/.stash/config.json` by default. Respects `$XDG_CONFIG_HOME` if set (`$XDG_CONFIG_HOME/stash/config.json`). Using a directory (`~/.stash/`) so we have room for future global state (cache, logs, etc.).

Global `~/.stash/config.json` (setup fields):
```json
{
  "github": {
    "token": "ghp_..."
  }
}
```

Per-stash `.stash/config.local.json` (connect fields):
```json
{
  "connections": {
    "github": {
      "repo": "user/repo"
    }
  }
}
```

Provider never touches config files. A registry maps names to classes:
```ts
const providers = { github: GitHubProvider }
```

### 8. Config ownership
- **CLI** owns global config (`~/.stash/config.json` or XDG path) via `readGlobalConfig()` / `writeGlobalConfig()` utility functions. Handles `stash setup`.
- **Stash** owns per-stash config (`.stash/config.local.json`) via `connect()` / `disconnect()` methods. Handles `stash connect` / `stash disconnect`.
- `Stash.load(dir, globalConfig)` — CLI reads global config, passes it in. Stash merges with local config, constructs providers when needed.
- No Config class needed.

Details TBD during spec.

### 9. Repo creation + first connect
Repo must be created by the user first. `stash connect` does not create repos.

Three cases on first connect:

1. **Empty repo** (no commits) — first push creates initial commit with no parent and no base tree. All local files + `snapshot.json` pushed.
2. **Repo with files but no `.stash/snapshot.json`** — another user or GitHub's "initialize with README". fetch() sees no `snapshot.json` → returns all remote files as "added" in ChangeSet (ignores `knownHashes`). Local scan also has no `snapshot.json` → all local files "added". Reconcile handles created/created via two-way merge.
3. **Repo with `.stash/snapshot.json`** — another machine already connected. Normal sync flow.

Cases 1 and 2 are both "no `snapshot.json` on remote". Provider handles both: no `snapshot.json` = fetch all files as added. Push handles case 1: no HEAD = create commit with no parent.
