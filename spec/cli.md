# CLI

Command-line interface for Stash. Parses commands, handles prompting, manages global config, and provides the `stash watch` auto-sync feature. Delegates all stash operations to the [Stash class](stash.md).

---

## Commands

### `stash init`

Initializes the current directory as a stash. Delegates to `Stash.init()`. Registers the directory in the [stash registry](#stash-registry).

```
stash init
```

If the directory is already a stash, informs the user and does nothing.

### `stash setup <provider>`

Configures global provider settings (e.g. auth). Provider declares required fields via its static spec. Accepts `--field value` flags or prompts interactively (masked for secret fields).

```
stash setup github --token ghp_...
stash setup github              # prompts for token
```

Writes to [global config](#global-config) under the provider name.

### `stash connect <provider>`

Connects this stash to a provider. Accepts `--field value` flags or prompts interactively. If setup has not been done for this provider, prompts for setup fields too (and writes them to global config).

```
stash connect github --repo user/repo
stash connect github            # prompts for repo (and token if not set up)
```

Delegates to `stash.connect()`. Registers the directory in the [stash registry](#stash-registry). One connection per provider per stash.

### `stash disconnect <provider>`

Removes the connection for the given provider. If no connections remain, removes the directory from the [stash registry](#stash-registry).

```
stash disconnect github
```

Delegates to `stash.disconnect()`.

### `stash sync`

Syncs local files with configured connections. See [stash.md](stash.md) for the sync algorithm.

```
stash sync
```

Subscribes to `mutation` events for live output:

```ts
stash.on("mutation", (mutation) => {
  console.log(`${mutation.path}: disk=${mutation.disk}, remote=${mutation.remote}`)
})
await stash.sync()
```

### `stash status`

Shows configured connections and files changed since last sync.

```
stash status
```

Delegates to `stash.connections` and `stash.status()`.

### `stash watch`

Watches and syncs automatically. Runs in the foreground until interrupted (Ctrl-C).

```
stash watch              # watch current directory
stash watch --all        # watch all registered stashes
```

See [Watch](#watch) for behavior details.

### `stash watch install`

Installs a background service (macOS launchd) that runs `stash watch --all` on login.

```
stash watch install
```

### `stash watch uninstall`

Stops and removes the background service.

```
stash watch uninstall
```

### `stash watch status`

Shows whether the background service is running, which stashes are being watched, last sync time per stash, and any recent errors.

```
stash watch status
```

---

## Global Config

Location: `~/.stash/config.json`. Respects `$XDG_CONFIG_HOME` if set (`$XDG_CONFIG_HOME/stash/config.json`). Directory (`~/.stash/`) allows room for future global state (cache, logs, stash registry).

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

### How CLI instantiates Stash

CLI reads global config and passes it in. Stash never reads global config itself.

```ts
const globalConfig = readGlobalConfig()
const stash = await Stash.load(dir, globalConfig)
```

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

## Stash Registry

Location: `~/.stash/stashes.json`. A list of absolute paths to stash directories.

```json
[
  "/Users/me/notes",
  "/Users/me/projects/shared-config"
]
```

**Auto-populated:** `stash init` and `stash connect` add the current directory to the registry. `stash disconnect` removes the directory if no connections remain.

**Cleanup:** when the watcher encounters a registered path whose `.stash` directory no longer exists, it removes the entry from the registry silently.

Used by `stash watch --all` and `stash watch install` to know which directories to watch.

---

## Watch

The watch feature keeps stashes in sync automatically — no manual `stash sync` needed.

### Triggers

Two things cause a sync:

1. **Filesystem changes** — the watcher monitors all tracked files (excluding dotfiles, symlinks, `.stash/`). When files are created, modified, or deleted, a sync is triggered.

2. **Periodic poll** — every 30 seconds, a sync runs regardless of local changes. This picks up remote changes (since there's no push notification from GitHub).

### Debounce

Filesystem changes are debounced. After the last detected change, the watcher waits 1 second of quiet before syncing. This avoids firing on every keystroke during active editing.

If a poll timer fires during the debounce window, the debounce takes priority — the poll is skipped and the debounced sync covers both local and remote changes.

### Single-stash mode

`stash watch` (no `--all`) watches the current directory. It loads the stash, starts the filesystem watcher and poll timer, and syncs until interrupted (Ctrl-C).

### Multi-stash mode

`stash watch --all` reads the stash registry and watches every listed stash. Each stash has its own filesystem watcher and poll timer. Syncs are independent — one stash syncing doesn't block another.

If the registry changes while watching (e.g. user runs `stash init` in another terminal), the watcher picks up the new entry on the next poll cycle.

### Output

**Foreground** (`stash watch` / `stash watch --all`): logs to stdout. One line per sync with a summary (stash path, number of changes, any notable events like merges or restores). Quiet when nothing happens.

**Background** (installed service): logs to `~/.stash/daemon.log`. Same format as stdout.

Principle: silent success, visible problems. A clean sync of unchanged files produces no output. A three-way merge, a content-wins restore, or an error does.

### Error handling

The watcher never crashes and never loses data.

- **Network down:** sync fails, watcher keeps watching files. Retries on the next poll cycle.
- **Auth expired:** logged, surfaced in `stash watch status`. Watcher keeps running — works again once the user re-runs `stash setup`.
- **Conflict retry exhausted:** logged, skipped. Retries on the next cycle.
- **Stash directory deleted:** entry removed from registry, watcher stops watching that path.

### launchd integration (macOS)

`stash watch install` writes a plist to `~/Library/LaunchAgents/com.stash.watch.plist` and loads it via `launchctl`. The plist runs `stash watch --all` with:

- `RunAtLoad: true` — starts immediately and on login.
- `KeepAlive: true` — restarts if the process exits.
- `StandardOutPath` / `StandardErrorPath` → `~/.stash/daemon.log`.

`stash watch uninstall` unloads via `launchctl` and removes the plist file.

`stash watch status` checks whether the launchd job is loaded and running, reads the stash registry, and reports per-stash status.
