# CLI

The CLI is the user-facing layer for provider setup, connection management, status display, and background-service lifecycle.

All commands print plain text. Errors go to **stderr** with an `Error:` prefix and exit code 1; success messages go to **stdout**. Color is applied only when stdout is a TTY (via `picocolors`); non-TTY output is the same characters without ANSI codes.

## Style

These rules apply across every command. Color is applied via `picocolors` and only when stdout is a TTY; non-TTY output is the same characters without ANSI codes.

### Palette

Color is used sparingly. The aim is *one* accented token per line at most — usually a verb at the start, or a state value in the daemon line / status table. Connector words and URIs in plain confirmation lines stay default; URIs are only colored inside the `status` table (where the column structure makes the accent earn its place) or inside error messages (where it draws the eye to the offending value).

| Role     | Color   | Used for                                                         |
|----------|---------|------------------------------------------------------------------|
| default  | (none)  | most content — paths, URIs in confirmation lines, connectors     |
| accent   | cyan    | URIs inside the `status` table; URIs inside error messages       |
| success  | green   | confirmation verbs (`Connected`, `Disconnected`, `Configured`, `Relinked`, `Already connected`, `Already linked`); daemon `running` |
| warn     | yellow  | daemon `stopped`; `(path missing)` marker; `unsupported` state   |
| error    | red     | `Error:` prefix on stderr; daemon `error` state; `State` value when it's `error`; `Message` value when sourced from an error |
| muted    | grey    | hint suffixes, table row labels, time qualifiers — see below     |

### What gets greyed

- **Table row labels** in `status` (`Connection`, `State`, `Last sync`, `Pending`, `Message`) — let the values carry the weight.
- **Time qualifiers** in the `Last sync` row — `2m ago`, `14s ago`.
- **Hint suffixes** — the second line on `connect` (`Background sync is on. Run \`stash status\` to check.`) is fully muted; same for the `Run: stash relink …` line under a path-missing stash.

Connector words (`to`, `from`, `—`, `→`) in confirmation lines are **default**, not grey — they stay readable next to the verb.

### Paths

Paths in output are **tilde-shortened** (`/Users/rupert/Notes` → `~/Notes`). Stored canonical paths on disk remain absolute; this is rendering only.

### Symbols

- **`→`** (muted) separates source and destination on transitions (`relink ~/old → ~/new`, `connect ~/Notes → github:owner/notes` in non-confirmation contexts).
- **No emojis** in any output.
- **No bold** — color does the emphasis work.

### Punctuation

- **No trailing periods** on confirmation lines. Errors do end with periods.
- Connectors are lowercase prose (`to`, `from`, `at`), not symbols.

### Spacing

- **Every command's output ends with a blank line** so the shell prompt has breathing room. Tested in the integration suite.
- **Two-line `connect` output** (success + daemon hint) has no blank line between the two lines; the hint is rendered directly under the confirmation in muted grey.
- **`status`** uses a blank line between the daemon header, each per-stash block, and the count outro.
- **Errors** are tight: summary line on stderr, any detail lines immediately under it; the trailing blank line is on **stderr**, not stdout.

## Commands

### `stash setup <provider>`

Writes global provider configuration to `~/.stash/config.json`. Always prompts for the provider's `global` fields; values from CLI flags (e.g. `--token`) override prompts.

Re-running `setup` re-prompts and overwrites existing values.

Example:

```bash
stash setup github
# prompts for: Personal access token

stash setup github --token ghp_…    # no prompt
```

Output:

```text
Configured github
```

Color: `Configured` green; provider name default.

### `stash connect [<path>] <uri> [--dangerously-allow-git]`

Connects a folder to a provider URI. If `<path>` is omitted, defaults to the current directory.

The URI form is `<provider>:<id>`, e.g. `github:owner/repo`. The CLI parses the provider, validates the connection, and registers the stash under `~/.stash/<id>/`.

If the provider's global fields are not yet set (e.g. github token), `connect` prompts for them and persists the result to `~/.stash/config.json` *only after* the connection validates successfully.

Examples:

```bash
stash connect github:owner/repo                  # current directory
stash connect ~/Notes github:owner/notes          # explicit path
```

Output (new connection):

```text
Connected github:owner/repo to ~/Notes
Background sync is on. Run `stash status` to check.
```

Color: `Connected` green; everything else default; the second line entirely muted grey.

The second line appears only when the daemon is running. If the daemon isn't running (or the platform doesn't support it), only the first line prints.

Output (idempotent re-run on the same URI):

```text
Already connected — github:owner/repo
```

Color: `Already connected` green; everything else default.

Output (`.git/` detected without `--dangerously-allow-git`), to **stderr**, exit 1:

```text
Error: ~/code/myrepo is a git repository.
Pass --dangerously-allow-git if you really want stash to sync this folder.
```

Output (path already connected to a different URI), to **stderr**, exit 1:

```text
Error: ~/Notes is already connected to github:owner/old-repo.
Multi-connection per stash is not yet supported. Run `stash disconnect ~/Notes` first.
```

### `stash disconnect [<path>] [<uri>]`

Disconnects a stash from a provider URI. If `<path>` is omitted, defaults to the current directory. If `<uri>` is omitted and the stash has exactly one connection, drops that connection.

If the stash has multiple connections (a future feature), `<uri>` is required.

The CLI atomically rewrites `~/.stash/<id>/stash.json` to drop the connection. The per-stash directory is *not* deleted by the CLI — when the last connection is removed, the daemon picks up the empty-connections tombstone and cleans up the directory.

Examples:

```bash
stash disconnect                                  # current directory, only connection
stash disconnect ~/Notes                          # explicit path, only connection
stash disconnect ~/Notes github:owner/notes       # explicit path + URI
stash disconnect github:owner/notes               # URI only (looks up cwd)
```

Output:

```text
Disconnected github:owner/notes from ~/Notes
```

Color: `Disconnected` green; everything else default.

Output (no stash at path), to **stderr**, exit 1:

```text
Error: No stash found at ~/Notes.
```

Output (multiple connections, no `<uri>` given), to **stderr**, exit 1:

```text
Error: Multiple connections at ~/Notes:
  github:owner/notes
  github:owner/notes-mirror
Pass the URI to disconnect: stash disconnect ~/Notes <uri>
```

### `stash relink <old-path> <new-path> [--dangerously-allow-git]`

Moves a registered stash to a new path. The old path may no longer exist (e.g. you renamed the folder). The new path must exist.

The CLI atomically rewrites `~/.stash/<id>/stash.json` with the new `path` field. The stash's id stays the same.

Example:

```bash
stash relink ~/OldFolder ~/Documents/NewFolder
```

Output:

```text
Relinked ~/OldFolder → ~/Documents/NewFolder
```

Color: `Relinked` green; everything else default.

Output (no stash at old path), to **stderr**, exit 1:

```text
Error: No stash found at ~/OldFolder.
```

Output (a stash already exists at the new path), to **stderr**, exit 1:

```text
Error: A stash already exists at ~/Documents/NewFolder.
```

### `stash status`

Shows daemon liveness and a per-stash block for every registered stash.

Output:

```text
Daemon: running

~/Notes
┌────────────┬──────────────────────────┐
│ Connection │ github:owner/notes       │
│ State      │ idle                     │
│ Last sync  │ 2m ago                   │
│ Pending    │ 3 modified, 1 added      │
└────────────┴──────────────────────────┘

~/Repos/television/.television
┌────────────┬─────────────────────────┐
│ Connection │ github:owner/tv-state   │
│ State      │ syncing                 │
│ Last sync  │ 14s ago                 │
└────────────┴─────────────────────────┘

2 stashes
```

The per-stash table is rendered with `cli-table3`. Rows that are absent (no message, no pending changes) are omitted from the table. The `Message` row carries either the latest sync `summary` (e.g. `synced 3 modified`) or an `error` string — error wins when both are present.

Color in the table: row labels (left column) muted grey, values default — except the URI in the `Connection` row which is cyan, the `State` value when it's `error` which is red, and the `Message` value which is red when sourced from `error` (default fg when sourced from `summary`).

If a stash's path no longer exists, the table is replaced with a one-line warning:

```text
~/Old/Folder (path missing)
Run: stash relink ~/Old/Folder <new-path>
```

Color: path default; `(path missing)` yellow; the `Run:` hint line entirely muted grey.

Output (no stashes registered):

```text
Daemon: running

No stashes registered. Run `stash connect <path> <uri>` to add one.
```

The `Daemon:` line is colored — `running` green, `stopped` yellow, `unsupported` yellow, `error` red — when stdout is a TTY.

### `stash start`

Installs and starts the background sync daemon as a system service (launchd on macOS, systemd on Linux).

Output:

```text
Daemon installed and running
```

Color: `running` green; the rest default.

Output on unsupported platforms, to **stderr**, exit 1:

```text
Error: This platform does not support background services yet.
```

### `stash stop`

Stops and uninstalls the background sync daemon.

Output:

```text
Daemon stopped
```

Output if the daemon is not running, to **stderr**, exit 1:

```text
Error: Daemon is not running.
```

### `stash daemon` (hidden)

Runs the background daemon in the foreground. Used internally by the system service; not normally invoked by users. Hidden from `--help`.

## Provider config schema

Each provider class declares a `static configSchema: ConfigItem[]`. Each item has:

- `name` — the field key (used for both the CLI flag `--<name>` and the prompt label fallback).
- `label` — the human-friendly prompt text.
- `secret?` — if true, the prompt masks input (used for tokens).
- `global?` — if true, the field is provider-level (stored in `~/.stash/config.json`); if false (or omitted), it's per-connection (sourced from the URI).

`stash setup` collects only the `global: true` fields. `stash connect` collects any `global: true` fields that aren't already set, plus per-connection fields from the URI.

GitHub provider:

| name  | label                        | secret | global |
|-------|------------------------------|--------|--------|
| token | Personal access token        | ✓      | ✓      |
| id    | Identifier (e.g. owner/repo) |        |        |

The `id` field is sourced from the URI: `github:owner/repo` parses to `{ provider: "github", config: { id: "owner/repo" } }`.

## Errors and exit codes

- Successful commands exit with code 0; their output goes to **stdout**.
- Any error exits with code 1; the message goes to **stderr** with an `Error:` prefix.
- Errors do not produce partial state. If a command fails before its mutation step, no files have been written. Mutations under the registry lock (`connect`, `disconnect`, `relink`) are atomic — either the `stash.json` write succeeds in full or the operation aborts.
