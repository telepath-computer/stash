# Spec: External sync target

Branch: `spec/external-sync-target`

## Goal

Stash should sync any folder without requiring a `.stash/` directory inside it. Per-stash metadata moves to `~/.stash/<id>/`. The motivating use case is syncing application-state folders like `~/.my-app` without polluting them. This becomes the only mode — no in-folder metadata.

Existing in-folder stashes will be migrated by hand; no automatic migration in scope.

## Final design

### Stash identity

A stash is identified by a **ULID** generated at creation time. Stable for the life of the stash — never changes, including across `relink`. The per-stash metadata directory is `~/.stash/<id>/`.

- Each stash also has a `path` (the folder being synced), stored in its `stash.json` and shown to users.
- `stash.id` is the stash's primary key (e.g. `01HF7E2K3Y4Z5N8M9PQRSTVWXY`). Internal — users mostly see paths.
- Uniqueness of *path* (no two stashes for the same canonical path) is enforced by **scan-before-create** under a registry lock. See [Registry lock](#registry-lock).

### Path canonicalisation

Paths go through `realpath` at registration to deduplicate aliases (symlinks, case differences on APFS, macOS firmlinks like `/var` vs `/private/var`). The resolved canonical path is what's stored in `stash.json` and matched against during dedup scans.

- **At registration** (`connect`, `relink <new-path>`): call `realpath` on the input. The resolved path is what's stored verbatim in `stash.json`. If `realpath` fails (path doesn't exist) at registration time, error.
- **At lookup-when-missing** (`disconnect <gone-path>`, `relink <gone-old-path>`): don't try to re-canonicalise. Use `path.resolve(input)` and match against existing stash.json `path` fields. **Caveat**: alias forms (`/var` vs `/private/var`, case differences on APFS, symlinks that have since vanished) won't match the stored canonical form once the path is gone. Users in that case must pull the exact canonical path from `stash status` output. Always try the canonical path first.
- **`stash status` always prints the canonical path** so the user has an exact handle to feed into `relink`/`disconnect` when their folder is gone.

### Registry lock

`~/.stash/.lock` (mode 0600) is the single primitive that serialises all registry-mutating operations. Both the CLI and the daemon use it, via a shared helper:

```ts
withRegistryLock(async () => {
  // …read on-disk state, mutate, etc. Lock is held for the duration.
});
```

Implementation: `O_CREAT | O_EXCL` with a brief retry loop. Released on exit (including via `process.on('exit')` and signal handlers). Stale-lock recovery: if the file exists but the holding pid is dead (or the file is older than 60s with no live pid), it's reclaimed.

**Who takes the lock, and when:**

| Caller | When | What runs under the lock |
|---|---|---|
| CLI `connect` | entire command | scan-before-create + `Stash.create()` (or tombstone resurrect) |
| CLI `disconnect` | entire command | scan + atomic rewrite of `stash.json` (writes `connections: []` for the last connection — never `rmdir`) |
| CLI `relink` | entire command | scan + atomic rewrite of `stash.json.path` |
| Daemon (any deletion site) | revalidate-and-rmdir step only | re-read on-disk state, `rmdir` only if precondition still holds |

The lock guards three invariants:
1. No two stashes for the same canonical path (scan-before-create can race without it).
2. `relink`'s scan-then-write of `stash.json` is serialised with concurrent `connect`s.
3. Daemon `rmdir` doesn't race with a CLI resurrection (tombstone → reconnect) or with an in-flight CLI `mkdir → write stash.json`.

Per-stash sync activity uses a different lock (`~/.stash/<id>/sync.lock`) and is unaffected.

**Lock discipline.** The CLI never `rmdir`s a per-stash dir — only the daemon does. The CLI mutates `stash.json` (atomic rename); dir lifecycle (mkdir on create, rmdir on cleanup) belongs to the daemon (mkdir excepted: `Stash.create()` mkdirs as part of bringing a new stash into existence). The daemon does NOT hold the lock while waiting for in-flight syncs; it calls `Watch.stop()` first (which waits for the active sync to finish), THEN takes the lock for the brief revalidate-and-rmdir step.

### Connections

Each provider registers a URI scheme equal to its name. Connections are identified by URIs:

```
github:owner/repo
iroh:docaaaeumlbdgjz...   (future)
s3:bucket/prefix          (future)
```

**Multi-connection per stash is deferred.** For chunk #1, a stash holds at most one connection; `connect` errors if a connection already exists (with an idempotent no-op when the same URI is reconnected). The data model uses an array regardless — forward-compatible, no migration when multi-connection unlocks.

### Architecture preserved

Existing layering stays intact (per `docs/architecture.md`):

- `Stash` is the core engine: file scanning, reconciliation, snapshots, sync lifecycle. Owns its `~/.stash/<id>/` metadata.
- `Watch` is reusable scheduling: polling, fs events, debounce.
- `Daemon` runs one `Watch` instance per registered stash.
- Providers are transport-only: `fetch()`, `get()`, `push()`. They don't merge files or mutate local disk.

This spec doesn't touch those boundaries. Future p2p (chunk #3) is a *transport*, not a sync engine — stash core continues to handle reconciliation. The only optimisation a p2p provider may need is a way to signal the watch loop "peers updated, fetch now" instead of polling, but that's a small extension to the provider interface, not an architectural shift.

### `~/.stash/` layout

```
~/.stash/                                       (mode 0700)
├── config.json                                 (mode 0600 — holds secrets)
├── .lock                                       (registry lock, present during connect/disconnect/relink)
├── 01HF7E2K3Y4Z5N8M9PQRSTVWXY/                 (per-stash dir, keyed by ULID)
│   ├── stash.json                              (path + connections)
│   ├── snapshot.json                           (last-synced state)
│   ├── snapshot/                               (text merge bases)
│   ├── status.json                             (last sync result, written by Watch)
│   ├── sync.log
│   └── sync.lock                               (present only during active sync)
└── 01HF8G3M4P5Q6R7S8T9UVWXYZ0/
    └── …
```

**`config.json`** holds **only** providers (e.g. github token). No registry index — the list of stashes IS the list of `~/.stash/<id>/` directories.

```jsonc
{
  "providers": {
    "github": { "token": "ghp_…" }
  }
}
```

**`stash.json`** is the authoritative per-stash record:

```jsonc
{
  "path": "/Users/rupert/Notes",
  "connections": [
    { "provider": "github", "config": { "id": "rmanfredi/notes" } }
  ]
}
```

The path lives only in `stash.json` — single source of truth, no drift risk.

### Atomic writes

Both `~/.stash/config.json` and `~/.stash/<id>/stash.json` are written atomically: write to `<file>.tmp`, `chmod` (0600 for `config.json` since it carries secrets; default for others), then `rename`. Readers filter out `.tmp` files when listing.

Prevents the daemon from observing partial JSON during a CLI write.

### CLI

```bash
stash connect <path> <uri> [--dangerously-allow-git]
stash disconnect <path> [<uri>]
stash relink <old-path> <new-path> [--dangerously-allow-git]
stash status
stash start / stop
stash setup <provider>
```

Removed from prior versions: `stash sync`, `stash watch`, `stash add`, `stash join`, `stash list`, `stash share`, `stash config set/get`. `status` is the single overview command. The daemon syncs continuously.

### Per-command behavior

#### `stash connect <path> <uri> [--dangerously-allow-git]`

- **Inputs.** Required `<path>` (use `.` for cwd). Required `<uri>` in the form `<scheme>:<opaque>`. Optional `--dangerously-allow-git` flag (gates a safety check, not stored).
- **Behavior.**
  1. `mkdir -p <path>` (no-op if it already exists), then resolve to canonical absolute via `realpath`.
  2. Detect `.git/`. If present and `--dangerously-allow-git` not passed → error: *"git repository detected. Pass `--dangerously-allow-git` if you really want stash to sync this folder."*
     - The flag is **not stored**. The check exists only at `connect` and `relink`. The runtime `.git/` check inside `Stash.sync()` (today at `stash.ts:162`) is **removed** — the connect/relink-time decision is final. Trade-off: if a user runs `git init` inside an already-synced folder, sync continues silently (no post-connect protection). Accepted; user explicitly opted in at registration.
  3. Parse URI: split on first `:` → `{ provider, config: { id } }`. Error if no colon.
  4. Look up provider class by scheme. Error if unknown.
  5. Read provider config from `~/.stash/config.json`'s `providers.<name>`. If any `global: true` items are missing, prompt for them and **collect into memory only** (do not write to disk yet).
  6. Construct the provider with merged `{ ...storedGlobal, ...pendingGlobal, ...connectionConfig }` to validate. Error if constructor throws (e.g. github rejects a malformed id). **No mutations have happened yet** — if anything failed in steps 1–6, no state has changed on disk.
  7. **If any pending global items were collected**, atomically write the updated provider config to `~/.stash/config.json` now. (Validation passed; safe to persist.)
  8. Inside `withRegistryLock`:
     - **Scan.** Read every `~/.stash/*/stash.json` (skipping `.tmp` files and dirs lacking a `stash.json`). Look for one whose `path` equals `canonicalPath`.
     - **None found** (new stash): call `Stash.create(record, globalConfig)` — generates a ULID, mkdirs `~/.stash/<id>/`, atomically writes `stash.json`.
     - **Found** (a stash already exists at this canonical path): read its `stash.json`.
       - If `connections` is empty (tombstone from a prior `disconnect`): atomically rewrite with the new connection. Resurrected. (Id stays the same.)
       - Else if a connection with this exact `{ provider, config }` already exists: idempotent no-op, print "Already connected." and exit.
       - Else (different connection present): error per the multi-connection rule.
  9. Daemon picks up the new dir (or rewritten `stash.json`) via its watches.
- **Output.**
  ```
  Connected github:rmanfredi/notes to /Users/rupert/Notes.
  Background sync is on · syncing automatically
  ```
  Or, on existing-other-connection error:
  ```
  Error: /Users/rupert/Notes is already connected to github:rmanfredi/old-repo.
  Multi-connection per stash is not yet supported. Run `stash disconnect /Users/rupert/Notes` first.
  ```

#### `stash disconnect <path> [<uri>]`

- **Inputs.** Required `<path>` (use `.` for cwd). Optional `<uri>` of the connection to drop.
- **Behavior.** Inside `withRegistryLock`:
  1. Resolve input: try `realpath(input)` first; on ENOENT, fall back to `path.resolve(input)`.
  2. Scan `~/.stash/*/stash.json` and find the entry whose `path` matches. Error if none.
  3. If `<uri>` given: drop that connection. Error if the stash doesn't have that connection.
  4. If `<uri>` omitted: if the stash has exactly one connection, drop it; else error and list current URIs.
  5. **CLI never `rmdir`s the per-stash dir.** It atomically rewrites `stash.json` with the connection removed (or sets `connections: []` if last).

  After the lock is released:
  - **Empty `connections` is the tombstone.** Daemon's reactive deletion site picks this up: `Watch.stop()`, then under `withRegistryLock` re-reads `stash.json` and `rmdir`s if still empty.
  - If the daemon isn't running, the dir stays as a tombstone until the daemon's startup pass dispatches it through the same site.
- **Output.**
  ```
  Disconnected github:rmanfredi/notes from /Users/rupert/Notes.
  ```

#### `stash relink <old-path> <new-path> [--dangerously-allow-git]`

- **Inputs.** Both required.
- **Behavior.** Inside `withRegistryLock`:
  1. Resolve `<old-path>`: try `realpath(<old-path>)` first; on ENOENT, fall back to `path.resolve(<old-path>)`. Call this `oldCanonical`.
  2. Resolve `<new-path>` via `realpath`. Error if it doesn't exist. Call this `newCanonical`.
  3. Detect `.git/` at `<new-path>`. If present and `--dangerously-allow-git` not passed → error (same message as `connect`).
  4. If `oldCanonical === newCanonical`: no-op, exit.
  5. Scan `~/.stash/*/stash.json`:
     - Find the entry matching `oldCanonical` → that's the stash to relink. Error if none.
     - Verify no other entry already matches `newCanonical`. Error: *"a stash already exists at `<new-path>`."*
  6. **Atomically rewrite `~/.stash/<id>/stash.json`** with `path: newCanonical`. Single atomic write — no rename, no two-step drift window. The id stays the same.

  After the lock is released: daemon picks up the `stash.json` edit via its periodic poll. Tears down old `Watch`, starts new one against the new path. (Same id, same dir — just a path change.)
- **Output.**
  ```
  Relinked /Users/rupert/Notes → /Users/rupert/Documents/Notes.
  ```

#### `stash status`

- **Inputs.** None.
- **Behavior.** Daemon liveness header + one block per registered stash, with brief sync state. Sourced from each stash's `~/.stash/<id>/status.json` (written by the daemon's Watch instance). Missing-path stashes flagged with the suggested `relink` command.
- **Output.**
  ```
  Daemon: running

  /Users/rupert/Notes
    github:rmanfredi/notes
    State:        idle
    Last sync:    2m ago
    Pending:      3 modified, 1 added

  /Users/rupert/Repos/television/.television
    github:rmanfredi/tv-state
    State:        syncing
    Last sync:    14s ago

  /Users/rupert/Old/Folder  (path missing — run `stash relink /Users/rupert/Old/Folder <new-path>`)
  ```

#### `stash start` / `stash stop`

- **Inputs.** None.
- **Behavior.** Install/start the daemon as a system service (launchd on macOS, systemd on Linux); stop and uninstall. Unchanged from today.
- **Output.** `Daemon started.` / `Daemon stopped.`

#### `stash setup <provider>`

- **Inputs.** Provider name. The provider's `global: true` `configSchema` items are prompted interactively (or supplied as flags via the existing `addFieldOptions` wiring).
- **Behavior.** Stores provider-level config under `providers.<name>` in `~/.stash/config.json` (atomic write at mode 0600). Re-running `setup` re-prompts and overwrites.
- **Output.** `Configured github.`

### Daemon behavior

Two watches:

- **`~/.stash/config.json`** — fires on provider-level config changes (e.g. github token rotation).
- **`~/.stash/`** (the directory) — fires on per-stash dir add/remove (i.e. `connect` / final `disconnect`).

Plus a periodic poll (30–60s) covering edits to existing `stash.json` files (relink, future connection edits) — the dir set doesn't change but the contents do, so `fs.watch` on `~/.stash/` won't fire.

On any signal, the daemon re-reads:
1. `~/.stash/config.json` for provider config.
2. `readdir(~/.stash/)` for the stash list. Each subdir's `stash.json` is read for path + connections.

It then diffs against currently-running `Watch` instances. The reconciliation has three rules, in order:

1. **Tombstone (`connections: []`) is a removal.** If a `stash.json` has empty connections, treat the entry as deleted: call `Watch.stop()` (waits for in-flight sync, NOT under lock), then dispatch to the reactive deletion site. This is the final-disconnect path.
2. **Removed tuple** (id no longer in the dir listing) → call `Watch.stop()`, then nothing else (dir is already gone).
3. **New / changed tuple** (id appeared, or `(stashRecord, providerConfig)` differs from last seen) → if there's an existing Watch, tear it down; then start a new `Watch` via `Stash.load(id, globalConfig)`.

Tear-down-and-recreate; no in-place reconfiguration. Watches are cheap.

**Deletion sites.** Only the daemon `rmdir`s per-stash dirs. There are three sites; all use `withRegistryLock` and revalidate the precondition under the lock before acting:

```ts
// Reactive tombstone (daemon observed connections: [] for an active stash)
await watch.stop();                                    // wait for in-flight sync — NOT under lock
await withRegistryLock(async () => {
  const r = await readStashJsonIfExists(id);
  if (r && r.connections.length === 0) {
    await rm(stashDir(id), { recursive: true });
  }
  // else: user resurrected the tombstone; another reconciliation tick will pick up the new state
});

// Orphan GC (dir has no stash.json — partial state from a crashed mkdir)
await withRegistryLock(async () => {
  const hasJson = await exists(stashJsonPath(id));
  const old = await mtimeOlderThan(stashDir(id), 5 * 60_000);
  if (!hasJson && old) {
    await rm(stashDir(id), { recursive: true });
  }
});

// Startup GC: walks `~/.stash/*/` and dispatches each dir to the matching site above (or no-op).
```

This closes the window where a CLI `connect` resurrects a tombstone (or completes an in-flight `mkdir → write stash.json`) between the daemon observing the precondition and acting on it. Each site re-reads from disk under the lock — never trusts cached state — so the precondition reflects ground truth at delete time. The lock is fast (CLI mutations are sub-second); `Watch.stop()` happens *before* taking the lock, so the lock isn't held while waiting for in-flight syncs.

**Missing-path stashes** (`stash.json` references a `path` that doesn't exist) get a synthetic `status.json` with `kind: "missing"` and no `Watch`. Daemon revisits each tick; the moment the user `relink`s, a real Watch starts. (No "user just `mv`d the folder back" auto-detect — they have to relink.)

**Incomplete-dir reads**: there is a brief window between `mkdir(~/.stash/<id>/)` and the atomic `stash.json` write where the dir exists but has no `stash.json` (or only `stash.json.tmp`). The daemon's reader **ignores any per-stash dir that lacks a non-tmp `stash.json`** during reconciliation. Such dirs are revisited on the next tick (still in-flight) or eventually become orphan-GC candidates (>5 min old without `stash.json` → reclaimed via the orphan-deletion site above).

**Daemon-was-off-during-disconnect**: tombstone dirs persist as-is across daemon restarts. On startup, the daemon walks `~/.stash/*/` and dispatches each dir through the deletion sites above (tombstone dispatch picks up empty-connection dirs; orphan dispatch picks up old incomplete dirs; live dirs become reconciliation entries).

### `Stash` class

```ts
/**
 * Stash is the per-stash sync engine. It owns:
 *   - the metadata directory at `~/.stash/<id>/` (snapshot, status, log, lock, merge bases);
 *   - file scanning and reconciliation against the user's `path`;
 *   - the sync lifecycle (push/fetch via providers).
 *
 * Stash does NOT own:
 *   - the registry (it's just a directory listing of `~/.stash/`);
 *   - the daemon lifecycle or watch scheduling;
 *   - global provider config — that's read elsewhere and passed in.
 *
 * Two ways to materialise a Stash:
 *   - Stash.create(record, globalConfig) — for new stashes (creates the dir, writes stash.json).
 *   - Stash.load(id, globalConfig)       — for existing stashes (reads stash.json).
 */
class Stash {
  readonly id: string;          // ULID, generated at create()
  readonly record: StashRecord; // { path, connections }

  private constructor(id: string, record: StashRecord, globalConfig: GlobalConfig) { ... }

  /**
   * Create a new stash for `record.path`. Generates a fresh ULID and writes the per-stash
   * dir + stash.json. MUST be called from inside `withRegistryLock` after a scan has confirmed
   * no existing stash matches `record.path`. Stash itself does not take the lock.
   */
  static async create(record: StashRecord, globalConfig: GlobalConfig): Promise<Stash> {
    const id = ulid();
    await mkdir(`~/.stash/${id}/`, { mode: 0o700 });
    await writeStashJson(`~/.stash/${id}/stash.json`, record);  // atomic write
    return new Stash(id, record, globalConfig);
  }

  static async load(id: string, globalConfig: GlobalConfig): Promise<Stash> {
    const record = await readStashJson(`~/.stash/${id}/stash.json`);
    return new Stash(id, record, globalConfig);
  }

  // existing instance methods (sync, scan, etc.) — unchanged contract
}
```

`Stash.init()` is removed. `Stash.create()` and `Stash.load()` are pure operations — they read/write the metadata dir but don't take the registry lock. Callers (CLI commands, daemon reconciliation) wrap calls in `withRegistryLock` when needed. Tests typically use `Stash.load` against fixtures, or construct via the static factories with temp dirs.

### `status.json` schema (per stash)

```ts
{
  kind: "idle" | "syncing" | "error" | "missing" | "never";
  lastSync?: number;          // unix ms
  summary?: string;
  error?: string;             // present iff kind === "error"
  currentOperation?: "scanning" | "fetching" | "merging" | "pushing";
  pendingChanges?: { added: number; modified: number; deleted: number };
}
```

Existing fields preserved; `"missing"` is a new `kind`; `currentOperation` and `pendingChanges` are new optional fields the Watch can populate cheaply.

### Provider interface

The provider class, its constructor, and its `fetch`/`get`/`push` methods stay as they are. The only changes:

- Drop the old `ProviderSpec { setup, connect }` type.
- Replace with a single `static configSchema: ConfigItem[]` on each provider class.
- Drop interactive prompts for non-global items at connect time — they come from the URI.

```ts
type ConfigItem = {
  name: string;
  label: string;
  secret?: boolean;
  global?: boolean;  // true → stored in ~/.stash/config.json's providers.<name>
                     // false (default) → per-connection (sourced from URI in chunk #1)
};

class GitHubProvider {
  static configSchema: ConfigItem[] = [
    { name: "token", label: "Personal access token", secret: true, global: true },
    { name: "id",    label: "Identifier (e.g. owner/repo)" },
  ];

  constructor(config: { token: string; id: string }) { ... }
  // existing fetch / get / push
}
```

URIs are stash core's concern, not the provider's. Stash core has one generic parser:

```ts
function parseUri(uri: string): { provider: string; config: { id: string } } {
  const i = uri.indexOf(':');
  if (i < 0) throw new InvalidUriError(uri);
  return { provider: uri.slice(0, i), config: { id: uri.slice(i + 1) } };
}
```

At construction time, stash core merges global + connection config:

```ts
const providerConfig   = readGlobalProviderConfig(connection.provider);
const connectionConfig = connection.config;
const provider = new ProviderClass({ ...providerConfig, ...connectionConfig });
```

URIs are reconstructed for display via `${provider}:${config.id}`.

## Phasing

1. **`~/.stash/<id>/` layout.** New `config.json` schema (providers only). Per-stash dirs keyed by ULID. Atomic writes utility. `withRegistryLock(fn)` helper (`~/.stash/.lock`, `O_CREAT | O_EXCL`, stale-lock recovery). `~/.stash/` at 0700, `config.json` and `.lock` at 0600.
2. **`Stash` class refactor.** Drop `Stash.init()`. Add `Stash.create()` (generates ULID) and `Stash.load()` static factories. Update doc comments.
3. **Provider spec rework.** Replace `ProviderSpec { setup, connect }` with `static configSchema: ConfigItem[]`. Update github's spec; rewire `runConnect` / `runSetup` / `addFieldOptions` callsites.
4. **Generic URI parser in stash core.** Split-on-first-`:` to `{ provider, config: { id } }`. CLI uses this in `connect`.
5. **Daemon registry watching.** Watch `config.json` + `~/.stash/` directory. Diff by `(id, record, providerConfig)` tuple. Tear-down-and-recreate. GC-on-startup. Periodic poll fallback.
6. **CLI rewrite.** New `connect` (with cwd default, `--dangerously-allow-git`, validate-before-mutate flow), `disconnect`, `relink`, `status`. Remove `sync`, `watch`, `add`, `join`, `list`, `share`, `config set/get`.

## Out of scope

- Migration of existing in-folder `.stash/` stashes (handled manually).
- Auto-detect moved folders (use `stash relink`; surface missing paths in `stash status`).
- Per-provider non-URI connect fields like `--branch`. URI carries primary identity only for now.
- Multi-connection per stash. Data model supports it; CLI rejects it.
- Keychain integration for secrets. Token stays plaintext in `~/.stash/config.json` (mode 0600).
- Synchronous CLI↔daemon confirmation. The daemon picks up changes asynchronously via watch + poll. (See [TODO.md](../../TODO.md) item 4.)
- Per-stash flags. `local-config.ts` and `stash config set/get` are removed entirely. `--dangerously-allow-git` is a connect/relink-time gate, not a stored flag.
- Manual `sync`/`watch` fallback for environments where the OS service mechanism is unavailable (no launchd / no systemd / etc.). Stash is daemon-only in chunk #1; users on those platforms wait for [TODO #4 (CLI↔daemon IPC)] or a future userland-daemon mode.

## Future considerations

These don't constrain this spec but should not be made harder by it:

- **Structured data syncing.** First-class support for syncing structured documents (JSON, YAML, TOML, etc.) with field-level merge semantics rather than whole-file last-writer-wins.
- **Direct p2p syncing.** A future `iroh:` (or similar) provider, transport-only — stash core continues to handle reconciliation. Reads `stash share <path>` (or similar) output, pastes into another client. The URI-as-canonical-form decision and the `Stash.create`/`Stash.load` shape are designed to make this drop in cleanly. Likely also: an event-driven hook so the provider can wake the watch loop ("peers updated, fetch now") instead of polling, and a machine-level `~/.stash/identity.json` for the iroh NodeId.
- **Multi-connection.** Reuse the existing array shape on `stash.json`. Drop the "single-connection" check in `connect`.
