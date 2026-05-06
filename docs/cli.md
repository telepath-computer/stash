# CLI

`docs/cli.md` is the canonical reference for stash's command surface and terminal UI.

- It defines what commands exist.
- It defines how those commands render output.
- It is the style guide for future CLI changes.

The design spec lives at [docs/plans/external-sync-target.md](./plans/external-sync-target.md). This file is the user-facing contract.

## Command surface

The supported commands are:

```bash
stash setup <provider>
stash connect [<path>] <uri> [--dangerously-allow-git]
stash disconnect [<path>] [<uri>]
stash relink <old-path> <new-path> [--dangerously-allow-git]
stash status
stash start
stash stop
stash daemon
```

Removed commands from earlier CLI versions:

- `stash sync`
- `stash watch`
- `stash add`
- `stash join`
- `stash list`
- `stash share`
- `stash config set`
- `stash config get`

`stash daemon` is internal. It exists so the service manager can launch the background process, but it is not part of the day-to-day user workflow.

## Libraries

The CLI uses:

- `@clack/prompts` for intros, outros, prompts, and error blocks
- `picocolors` for the small fixed palette below
- `cli-table3` for `stash status` tables only

No other terminal UI library should be introduced without updating this document.

## Shared style

### Layout

Interactive commands use the same overall flow:

1. `intro("<command>")`
2. body content
3. `outro("<final hint or confirmation>")`

Successful runs should feel like:

```text
┌  stash connect
│
◇  ~/Notes → github:user/notes
│
└  Background sync is on. Run `stash status` to check.
```

Errors use `cancel(...)`, followed by an outro:

```text
┌  stash connect
│
■  ~/code/app is a git repository.
│  Pass --dangerously-allow-git if you really want stash to sync this folder.
│
└  No changes made.
```

### Palette

Use only these roles:

- `gray` for labels and secondary detail
- default terminal color for values and body text
- `cyan` for highlighted URIs inside prose when needed
- `green` for success states
- `yellow` for warnings and degraded states
- `red` for error states

Do not add bold, background colors, emojis, or custom themes.

### Symbols

- Use `→` for transitions
- Use `·` only inside prose-like summary lines
- Drop trailing periods on confirmation lines
- Keep periods on error sentences

### Rendered paths

All displayed paths are shortened from `$HOME/...` to `~/...`.

- This is rendering only.
- Paths stored on disk stay canonical absolute paths.
- `status`, `connect`, `disconnect`, and `relink` all render shortened paths.

### Prompts

Prompts use clack's `text()` and `password()` helpers.

- Reuse `ConfigItem.label`
- Do not prefix with filler text like "Please enter..."
- Validate before any config write

### Errors

Errors always follow this shape:

```text
┌  stash <command>
│
■  <one-line summary>
│  <optional detail or next step>
│
└  No changes made.
```

Rules:

- Use `cancel("<one-line summary>")`
- Keep the first line short and specific
- Add a second indented line only if the user needs a next step
- Exit with status code `1`
- Do not fall through to commander's default `error:` output

### Don'ts

- No emojis
- No raw stack traces for normal user-facing failures
- No box-drawing assertions in tests
- No trailing periods on successful confirmation lines
- No ad-hoc table formatting outside `status`

## Commands

### `stash setup <provider>`

Stores provider-level global config in `~/.stash/config.json`.

Behavior:

- Looks up the provider's `global: true` config fields
- Accepts those fields from CLI flags or interactive prompts
- Overwrites the provider's stored global config

Example:

```text
┌  stash setup
│
◇  github
│
└  Configured github
```

Prompted secret fields use masked input.

### `stash connect [<path>] <uri> [--dangerously-allow-git]`

Connects a folder to a provider URI.

Behavior:

- `<path>` defaults to the current working directory
- `<uri>` uses the form `<provider>:<id>`
- The rendered success line shows the shortened path and URI
- If the daemon is running, the outro is:
  `Background sync is on. Run \`stash status\` to check.`
- If the daemon is not running or unsupported, do not add a daemon-status hint

Success example:

```text
┌  stash connect
│
◇  ~/Notes → github:user/notes
│
└  Background sync is on. Run `stash status` to check.
```

Idempotent reconnect example:

```text
┌  stash connect
│
└  Already connected — github:user/notes
```

Git-protected path example:

```text
┌  stash connect
│
■  ~/code/myrepo is a git repository.
│  Pass --dangerously-allow-git if you really want stash to sync this folder.
│
└  No changes made.
```

Multi-connection-not-supported example:

```text
┌  stash connect
│
■  ~/Notes is already connected to github:user/old-notes.
│  Multi-connection per stash is not yet supported. Run `stash disconnect ~/Notes` first.
│
└  No changes made.
```

### `stash disconnect [<path>] [<uri>]`

Disconnects one connection from a stash.

Behavior:

- With no arguments, targets the current working directory
- With only `<path>`, targets that stash
- With only `<uri>`, targets the current working directory and removes that URI
- With both `<path>` and `<uri>`, removes that URI from that stash
- If the last connection is removed, the CLI writes a tombstone; the daemon owns deletion

Success example:

```text
┌  stash disconnect
│
└  Disconnected github:user/notes from ~/Notes
```

Multiple-connections example:

```text
┌  stash disconnect
│
■  Multiple connections at ~/Notes:
│  github:user/notes
│  github:user/notes-mirror
│
└  Pass the URI to disconnect: stash disconnect ~/Notes <uri>
```

Unknown stash example:

```text
┌  stash disconnect
│
■  No stash found at ~/Missing
│
└  No changes made.
```

Unknown URI example:

```text
┌  stash disconnect
│
■  Connection not found: github:user/missing
│
└  No changes made.
```

### `stash relink <old-path> <new-path> [--dangerously-allow-git]`

Moves an existing stash registration from one path to another without changing its stash id.

Success example:

```text
┌  stash relink
│
└  ~/Old/Notes → ~/Documents/Notes
```

Git-protected new path example:

```text
┌  stash relink
│
■  ~/code/newrepo is a git repository.
│  Pass --dangerously-allow-git if you really want stash to sync this folder.
│
└  No changes made.
```

Duplicate-path example:

```text
┌  stash relink
│
■  A stash already exists at ~/Documents/Notes.
│
└  No changes made.
```

### `stash status`

Shows daemon state first, then one block per registered stash.

Rules:

- Always render `Daemon: <state>` even when no stashes are registered
- Color daemon state with `picocolors`
  - running: green
  - stopped: yellow
  - unsupported: red
  - error: red
- Each live stash uses `cli-table3`
- Missing-path stashes do not use a table
- `Last error` only appears when there is an error
- The outro is either a count summary or the empty-state hint

Healthy stash example:

```text
┌  stash status
│
◇  Daemon: running
│
│  ~/Notes
│  ┌──────────────┬────────────────────┐
│  │ Connection   │ github:user/notes  │
│  │ State        │ idle               │
│  │ Last sync    │ 2m ago             │
│  │ Pending      │ 3 modified, 1 added│
│  └──────────────┴────────────────────┘
│
└  1 stash
```

Mixed state example:

```text
┌  stash status
│
◇  Daemon: running
│
│  ~/Notes
│  ┌──────────────┬────────────────────┐
│  │ Connection   │ github:user/notes  │
│  │ State        │ syncing            │
│  │ Last sync    │ 14s ago            │
│  └──────────────┴────────────────────┘
│
│  ~/Old/Folder (path missing)
│  Run: stash relink ~/Old/Folder <new-path>
│
└  2 stashes
```

Error row example:

```text
┌  stash status
│
◇  Daemon: running
│
│  ~/Notes
│  ┌──────────────┬─────────────────────────────┐
│  │ Connection   │ github:user/notes           │
│  │ State        │ error                       │
│  │ Last sync    │ 2m ago                      │
│  │ Last error   │ rate limit resets in 43s    │
│  └──────────────┴─────────────────────────────┘
│
└  1 stash
```

Empty state example:

```text
┌  stash status
│
◇  Daemon: running
│
└  No stashes registered. Run `stash connect <path> <uri>` to add one.
```

### `stash start`

Installs and starts the daemon service for the current user.

Success example:

```text
┌  stash start
│
└  Daemon installed and running
```

Unsupported example:

```text
┌  stash start
│
■  This platform does not support background services yet.
│
└  No changes made.
```

### `stash stop`

Stops and uninstalls the daemon service for the current user.

Success example:

```text
┌  stash stop
│
└  Daemon stopped
```

Already stopped example:

```text
┌  stash stop
│
■  Daemon is not running.
│
└  No changes made.
```

### `stash daemon`

Internal command used by the service manager.

- Not documented in top-level user help beyond existing hidden-command behavior
- No CLI polish requirements beyond correct execution

## Test guidance

CLI integration tests should assert on user-visible content, not frame glyphs.

Good assertions:

- `"Connected"`
- `"github:user/notes"`
- `"~/Notes"` or the full expected path when testing a non-tilde environment
- `"Daemon: running"`
- `"No changes made."`

Bad assertions:

- full box-drawing snapshots
- exact clack glyph placement
- ANSI escape sequences
