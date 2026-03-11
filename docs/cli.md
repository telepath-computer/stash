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
```

If global setup fields are missing, `connect` collects and writes them before storing connection fields.

### `stash disconnect <provider>`

Removes the provider connection from `.stash/config.local.json`.

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

If no provider is connected, watch exits with:

```text
no connection configured — run `stash connect <provider>` first
```

### `stash status`

Prints configured connections plus local `added`, `modified`, `deleted`, and `lastSync` status based on disk versus `snapshot.json`.

## Config Locations

- Global config: `~/.stash/config.json` or `$XDG_CONFIG_HOME/stash/config.json`
- Per-stash config: `.stash/config.local.json`

## Scope

The CLI owns:

- prompting
- command parsing
- output rendering
- watch orchestration
- global config file I/O

The CLI does not own sync logic or reconciliation rules; those live in `Stash`.
