# CLI

The CLI is the user-facing layer for provider setup, sync orchestration, and terminal output.

## Commands

### `stash init`

Initializes the current directory as a stash.

- creates `.stash/`
- preserves existing files
- is idempotent

If the directory is already initialized, the command succeeds and reports that it was already initialized.

### `stash setup <provider>`

Writes global provider configuration.

Example:

```bash
stash setup github --token ghp_...
```

If required fields are not provided on the command line, the CLI prompts for them. Secret fields are masked.

### `stash connect <provider>`

Initializes the current directory as a stash if needed, then writes per-directory provider connection config.

Example:

```bash
stash connect github --repo user/repo
stash connect github --repo user/repo --background
```

If global setup fields are missing, `connect` collects and writes them before storing connection fields.

If `--background` is supplied, the CLI also registers the current stash in the global background registry after connecting.

If the directory contains `.git/` and per-stash config does not have `allow-git: true`, `connect` still succeeds but prints a warning explaining that sync is blocked until the user either removes `.git/` or runs `stash config set allow-git true`.

### `stash disconnect <provider>`

Removes the provider connection from `.stash/config.json`.

### `stash config set <key> <value>`

Writes one per-stash config value into `.stash/config.json`.

Current supported keys:

- `allow-git`

Rules:

- unknown keys fail
- `true` and `false` are stored as JSON booleans
- the current directory must already be a stash

### `stash config get <key>`

Prints one per-stash config value from `.stash/config.json`.

### `stash sync`

Runs one sync cycle.

TTY output uses a live status line:

```text
◐ checking...
◐ syncing... ↑ hello.md
◐ syncing... ↓ photo.jpg
✓ synced (1↑ 1↓)
```

If there are no changes:

```text
◐ checking...
✓ up to date
```

If sync fails:

```text
✗ sync failed: network error
```

If sync is blocked by git safety:

```text
✗ sync failed: git repository detected — run `stash config set allow-git true` to allow syncing
```

### `stash watch`

Continuously syncs until interrupted.

Behavior:

- starts with an immediate sync
- debounces filesystem-triggered syncs by 1 second
- polls every 30 seconds to pick up remote-only changes
- resets the poll timer after each completed sync
- `.` triggers an immediate sync
- `q` and `Ctrl-C` stop the watcher
- waits for an in-flight sync to finish before normal shutdown

Additional behavior worth preserving:

- in TTY mode, watch shows a live status line with countdowns to the next poll
- in non-TTY mode, watch prints line-based results instead of updating one live line
- sync and watcher errors do not stop watch; it keeps retrying on the normal poll cadence
- filesystem events that arrive during a sync are queued and trigger a follow-up debounced sync

If sync is blocked by git safety, watch shows the same error message and keeps retrying on the normal poll cadence until the user removes `.git/` or sets `allow-git`.

If no provider is connected, watch exits with:

```text
no connection configured — run `stash connect <provider>` first
```

### `stash status`

Prints configured connections plus local `added`, `modified`, `deleted`, and `lastSync` status based on disk versus `snapshot.json`.

### `stash background install`

Installs the OS-managed background service:

- macOS uses a user `launchd` agent
- Linux uses a user `systemd` unit
- the installed service runs `stash background watch`
- other platforms fail with `not supported on this platform yet`

The CLI resolves the absolute `stash` binary path during install and writes it into the generated service file.

### `stash background uninstall`

Stops and removes the OS-managed background service for the current user.

### `stash background add [dir]`

Registers a stash for background syncing.

- `[dir]` defaults to the current directory
- the stored path is absolute
- the stash stays registered until explicitly removed
- if no provider is connected yet, the command warns but still registers the stash
- if the service is not installed, the command warns but still registers the stash

### `stash background remove [dir]`

Unregisters a stash from background syncing.

### `stash background status`

Prints:

- OS service state
- each registered stash path
- the most recent `.stash/status.json` summary for each stash

On unsupported platforms it reports `service status: unsupported platform` but still lists registered stashes.

### `stash background watch`

Hidden daemon entrypoint used by the OS service.

- loads the global background registry
- starts a headless watcher per registered stash
- hot-reloads when the global config changes
- writes `.stash/status.json` and capped `.stash/sync.log` for each stash

## Config Locations

- Global config: `~/.stash/config.json` or `$XDG_CONFIG_HOME/stash/config.json`
- Per-stash config: `.stash/config.json`

Global config shape:

```json
{
  "providers": {
    "github": { "token": "ghp_..." }
  },
  "background": {
    "stashes": ["/Users/me/notes"]
  }
}
```

## Scope

The CLI owns:

- prompting
- command parsing
- output rendering
- watch orchestration
- global config file I/O
- background service install/status commands

The CLI does not own sync logic or reconciliation rules; those live in `Stash`.
