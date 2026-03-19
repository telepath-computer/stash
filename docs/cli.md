# CLI

The CLI is the user-facing layer for provider setup, sync orchestration, and terminal output.

## Commands

### `stash setup <provider>`

Writes global provider configuration.

Example:

```bash
stash setup github --token ghp_...
```

If required fields are not provided on the command line, the CLI prompts for them. Secret fields are masked.

### `stash connect <provider>`

Initializes the current directory as a stash if needed, writes per-directory provider connection config, and registers the stash for background sync.

Example:

```bash
stash connect github --repo user/repo
```

If global setup fields are missing, `connect` collects and writes them before storing connection fields.

Example output:

```text
Connected github.
```

If background sync is already running:

```text
Connected github.
Background sync is on · This stash is now syncing automatically
```

### `stash disconnect`

Disconnects the current stash completely.

The CLI removes all provider connections, unregisters the stash from background sync, and removes `.stash/`.

If the directory contains `.git/` and per-stash config does not have `allow-git: true`, `connect` still succeeds but prints a warning explaining that sync is blocked until the user either removes `.git/` or runs `stash config set allow-git true`.

### `stash disconnect <provider>`

Removes the provider connection from `.stash/config.json`.

If that was the last remaining provider connection, the CLI also removes the stash from the global background registry and deletes `.stash/`.

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

### `stash start`

Installs and starts the OS-managed background sync service:

- macOS uses a user `launchd` agent
- Linux uses a user `systemd` unit
- the installed service runs the hidden `stash daemon` entrypoint
- other platforms report that background sync is not supported

Example output:

```text
Background sync is on
Watching 3 stashes · starts on startup
```

### `stash stop`

Stops and uninstalls the OS-managed background sync service for the current user.

Example output:

```text
Background sync is off
Run `stash start` to resume syncing 3 stashes
```

### `stash sync`

Runs one sync cycle.

TTY output uses a live status line:

```text
◐ Checking...
◐ Syncing... ↑ hello.md
◐ Syncing... ↓ photo.jpg
✓ synced (1↑ 1↓)
```

If there are no changes:

```text
◐ Checking...
✓ up to date
```

If sync fails:

```text
✗ Sync failed: network error
```

If sync is blocked by git safety:

```text
✗ sync failed: git repository detected — run `stash config set allow-git true` to allow syncing
```

### `stash watch`

Continuously syncs the current stash until interrupted.

Behavior:

- starts with an immediate sync
- debounces filesystem-triggered syncs by 1 second
- polls every 10 seconds to pick up remote-only changes
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
No connection configured — run `stash connect <provider>` first
```

### `stash status`

Prints local status for the current stash.

It shows configured connections plus local `added`, `modified`, `deleted`, and `lastSync` status based on disk versus `snapshot.json`.

If the current stash is registered for background sync, the CLI also prints a short hint toward `stash status --all`.

If run outside a stash directory:

```text
Not in a stash directory — run `stash status --all` to view all stashes
```

### `stash status --all`

Prints global background sync status plus all registered stashes.

It shows:

- whether background sync is running
- each registered stash basename and path
- the configured provider label for each stash
- local pending changes and last sync time, or the current background error

Example output:

```text
Background sync is on · watching 2 stashes

● notes
  /Users/me/notes
  github  user/notes · Up to date · synced 2m ago

● work
  /Users/me/work
  github  user/work · Local changes: 1 added, 2 modified · synced 5m ago
```

### Hidden: `stash daemon`

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

## UI Style

The CLI output intentionally uses a compact, app-like style:

- primary state lines use sentence case, for example `Background sync is on`
- secondary context lines are short and actionable, for example `Run \`stash start\` to resume syncing 3 stashes`
- transient spinner/live lines also use sentence case, for example `Checking...` and `Syncing...`
- local and global status phrases are capitalized consistently: `Up to date`, `Local changes`, `Waiting for first sync`, `Directory not found`
- counts should pluralize naturally, for example `Watching 1 stash` and `Watching 3 stashes`
- color is part of the UI contract in TTY mode:
  - success/current healthy state uses green
  - warnings or changed local state use yellow where applicable
  - failures and unsupported platform messages use red
  - secondary detail uses dim text

These presentation details are intentional behavior, not incidental formatting.

## Scope

The CLI owns:

- prompting
- command parsing
- output rendering
- watch orchestration
- global config file I/O
- background service lifecycle commands

The CLI does not own sync logic or reconciliation rules; those live in `Stash`.
