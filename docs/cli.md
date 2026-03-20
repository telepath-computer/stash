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

### `stash connect <provider> [name]`

Initializes the current directory as a stash if needed, writes per-directory named connection config, and registers the stash for background sync.

Example:

```bash
stash connect github --repo user/repo
stash connect github origin --repo user/repo
```

If `name` is omitted, stash uses the provider name as the connection name.

If global setup fields are missing, `connect` collects and writes them before storing connection fields.

Example output:

```text
Connected origin.
```

If background sync is already running:

```text
Connected origin.
Background sync is on · This stash is now syncing automatically
```

**TTY colors (stdout):** `Connected origin.` is default foreground. On the second line, `Background sync is on` is **green**; the middle dot `·` and `This stash is now syncing automatically` are **dim**. **Non-TTY:** same characters, no ANSI codes.

Connection names are unique within a stash, and **only one connection per stash** is allowed (see [Output examples and TTY colors](#output-examples-and-tty-colors)).

If the directory contains `.git/` and per-stash config does not have `allow-git: true`, `connect` still succeeds but prints a warning — see [Git safety warning on `connect`](#git-safety-warning-on-connect).

### `stash disconnect <name>`

Disconnects one named connection from the current stash.

If that was the last remaining connection, the CLI also removes the stash from the global background registry and deletes `.stash/`.

Example **stdout** (one connection removed, others remain):

```text
Disconnected origin.
```

Example **stdout** (last connection — same message as `--all` after teardown):

```text
Disconnected stash.
```

Unknown name exits with code `1` and **stderr**:

```text
Connection not found: backup
```

**TTY:** default foreground (no color) for these disconnect messages.

### `stash disconnect --all`

Disconnects the current stash completely.

The CLI removes all named connections, unregisters the stash from background sync, and removes `.stash/`.

### `stash disconnect --path <path>`

Disconnects a stash by path from anywhere.

If the directory still exists, stash also removes `.stash/`. If the path is not registered, the command prints `No stash registered at that path.` and leaves global state unchanged.

### `stash disconnect` with no arguments

Fails with:

```text
argument required — run `stash disconnect <name>`, `stash disconnect --all`, or `stash disconnect --path <path>`
```

### `stash config set <key> <value>`

Writes one per-stash config value into `.stash/config.json`.

Current supported keys:

- `allow-git`

Rules:

- unknown keys fail
- `true` and `false` are stored as JSON booleans
- the current directory must already be a stash

Example **stdout**:

```text
allow-git=true
```

**TTY:** default foreground.

### `stash config get <key>`

Prints one per-stash config value from `.stash/config.json`.

Example **stdout** when set:

```text
true
```

When the key is unset, prints an empty line (still **stdout**). **TTY:** default foreground.

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

**TTY:** first line **green**; second line entirely **dim**.

If the service is already installed and running:

```text
Background sync is already running
```

**TTY:** entire line **green**.

On an unsupported platform, `stash start` prints to **stdout** and sets exit code `1`:

```text
Background sync is not supported on this platform
```

**TTY:** entire line **red**.

### `stash stop`

Stops and uninstalls the OS-managed background sync service for the current user.

Example output:

```text
Background sync is off
Run `stash start` to resume syncing 3 stashes
```

**TTY:** first line **red**; second line **dim**.

If the service is not installed and not running:

```text
Background sync is not running
```

**TTY:** entire line **red** (also used when the platform does not support background sync).

### `stash sync`

Runs one sync cycle.

On a **TTY**, a single live line is updated. Spinner frames are `◐`, `◓`, `◑`, `◒` in **yellow**, followed by the rest of the line (lowercase status text).

Example progression:

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

**TTY:** `✗` is **red**; `sync failed:` and the message use the default foreground.

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
no connection configured — run `stash connect <provider> <name>` first
```

(Exact casing matches the CLI.)

**TTY** watch mode (live line, examples):

```text
● up to date · checking in 8s
```

**TTY colors:** `●` **green**; `up to date`, the middle dot, and `checking in 8s` are **dim**.

After a sync that applied changes:

```text
● 2↑ 1↓ · checking in 10s
```

**TTY:** `●` **green**; the summary (`2↑ 1↓`) is **default** foreground; `·` and countdown are **dim**.

When a sync errors but watch keeps retrying:

```text
✗ sync failed: <message> · retrying in 10s
```

**TTY:** `✗` **red**; `sync failed:` and `<message>` default foreground; ` · retrying in …` **dim**.

**Non-TTY** (piped stdout), error status prints one line:

```text
✗ sync failed: <message>
```

**TTY:** `✗` **red**; remainder default.

### `stash status`

Prints **global** background sync state, then every stash path registered for background sync (from `~/.stash/config.json` or `$XDG_CONFIG_HOME/stash/config.json`). The current working directory does not matter.

It shows:

- whether background sync is running and how many stashes are registered
- a blank line, then for each registered path: basename, full path, and each connection’s provider label
- local pending changes and last sync time (from disk vs `snapshot.json`), or a background error when the daemon reported failure
- `Directory not found` / `Not a stash` when a registered path is missing or no longer a stash

Example output:

```text
Background sync is on · watching 2 stashes

● notes
  /Users/me/notes
  origin (github) · Up to date · synced 2m ago

● work
  /Users/me/work
  origin (github) · Local changes: 1 added, 2 modified · synced 5m ago

```

**TTY colors:** On the banner line, `Background sync is on` is **green**; `·` and `watching 2 stashes` are **dim**. For each healthy stash, `●` is **green**; the stash title (e.g. `notes`) is default; the path on the next line is **dim**. On connection lines, `origin (github)` is default; `·` and the status phrase (`Up to date · synced 2m ago`, etc.) are **dim**.

When background sync is off:

```text
Background sync is off
Run `stash start` to resume syncing 2 stashes

```

**TTY:** first line **red**; second line **dim**.

When the platform does not support background sync:

```text
Background sync is not supported on this platform

```

**TTY:** entire line **red**.

When no stashes are registered:

```text
No stashes connected yet — run `stash connect <provider> <name>` in a directory to get started
```

**TTY:** default foreground.

When the daemon reported an error for a stash (example):

```text
✗ notes
  /Users/me/notes
  origin (github) · rate limited
```

**TTY:** `✗` **red**; title default; path **dim**; `origin (github)` default; `·` **dim**; error text **red**.

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

## Output examples and TTY colors

This section is the **canonical reference** for exact user-visible text and **TTY** color. When stdout/stderr is **not** a TTY (pipe, file, CI), stash prints the **same words and punctuation** but **omits ANSI color codes**.

### How to read the examples

- **stdout** / **stderr** are called out per case. Most errors go to **stderr** (including all structured `stash connect` validation errors).
- **“Green / red / dim / yellow”** describe the ANSI foreground stash uses when the stream is a TTY (`createColors` in `src/ui/color.ts`).
- **“Default”** means the terminal’s normal text color (stash does not wrap that segment in a color code).

### Color roles (quick reference)

| Color       | Typical use                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Green**   | `✓`, healthy `●`, positive service lines (`Background sync is on`, `Background sync is already running`), synced summary in watch                 |
| **Red**     | `✗`, service “off / not running / unsupported”, daemon error text in `stash status`, **first line** of structured `stash connect` errors          |
| **Dim**     | Paths, hints, `·` separators, countdowns, **continuation lines** after a red `connect` error, git-warning bullets, second lines of `start`/`stop` |
| **Yellow**  | Spinner frame characters `◐ ◓ ◑ ◒`; the `Warning:` prefix on git safety                                                                           |
| **Default** | Plain sentences such as `Connected origin.`, `Disconnected origin.`, `stash sync`’s `sync failed:` tail                                           |

### `stash connect` — validation errors (stderr)

Emitted **before** any connect prompts when the command cannot succeed.

**Duplicate name** (name already in `.stash/config.json`):

```text
Connection already exists: origin
```

**TTY:** entire line **red** (via `CliDisplayError`). **Non-TTY:** same text, no codes.

**Second connection name** (e.g. `stash connect github new` while `origin` already exists):

```text
This stash already has connection "origin" (only one is supported).
Disconnect it before adding "new":
  stash disconnect origin
```

**TTY:** line 1 **red**; lines 2–3 **dim**. No blank line between line 1 and line 2.

**Invalid multi-connection config** (more than one key under `connections` in `.stash/config.json`):

```text
This stash has more than one connection in .stash/config.json (only one is supported).
Remove extra entries or run:
  stash disconnect --all
Then connect again.
```

**TTY:** line 1 **red**; lines 2–4 **dim**.

### Git safety warning on `connect` (stdout)

After `Connected <name>.` when `.git` exists and `allow-git` is not `true`:

```text
Warning: This directory contains .git. Stash will not sync until you either:
  - remove .git, or
  - run `stash config set allow-git true` (see "Using stash with git" in the README)
```

**TTY:** `Warning:` **yellow**; the rest of each line **dim**.

### `stash setup` (stdout)

```text
Configured github.
```

**TTY:** default foreground (no color codes for this line).

### Other commands

Success paths, `disconnect`, `config`, `sync`, `watch`, `status`, and `start`/`stop` edge cases are documented **with the same level of detail** under each command above; the **palette rules** here apply consistently.

## UI Style

The CLI output intentionally uses a compact, app-like style:

- primary state lines use sentence case, for example `Background sync is on`
- secondary context lines are short and actionable, for example `Run \`stash start\` to resume syncing 3 stashes`
- transient spinner/live lines use **lowercase** status words in the spinner body, for example `checking...` and `syncing...` (spinner frames remain `◐◓◑◒`)
- local and global status phrases are capitalized consistently: `Up to date`, `Local changes`, `Waiting for first sync`, `Directory not found`
- counts should pluralize naturally, for example `Watching 1 stash` and `Watching 3 stashes`
- color is part of the UI contract in TTY mode — see [Output examples and TTY colors](#output-examples-and-tty-colors) for exact strings and segment-by-segment color

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
