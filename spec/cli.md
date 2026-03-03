# CLI

Command-line interface for Stash. Parses commands, handles prompting, and manages global config. Delegates all stash operations to the [Stash class](stash.md).

---

## Commands

### `stash init`

Initializes the current directory as a stash. Delegates to `Stash.init()`.

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

Delegates to `stash.connect()`. One connection per provider per stash.

### `stash disconnect <provider>`

Removes the connection for the given provider.

```
stash disconnect github
```

Delegates to `stash.disconnect()`.

### `stash sync`

Syncs local files with configured connections. See [stash.md](stash.md) for the sync algorithm.

```
stash sync
```

Uses the shared [Sync Output](#sync-output) renderer:

```ts
const line = new LiveLine(process.stdout)
const renderer = new SyncRenderer(line)
const subscription = stash.on("mutation", (mutation) => renderer.onMutation(mutation))

line.startSpinner("checking...")

try {
  await stash.sync()
  const summary = renderer.done()
  line.print(summary ? `✓ synced (${summary})` : "✓ up to date")
} catch (error) {
  renderer.error(error as Error)
  line.print(`✗ sync failed: ${(error as Error).message}`)
  throw error
} finally {
  subscription.dispose()
  renderer.dispose()
  line.dispose()
}
```

Output:

```
$ stash sync
◐ checking...
◐ syncing... ↑ hello.md
◐ syncing... ↓ photo.jpg
✓ synced (2↑ 1↓)
```

No changes:

```
$ stash sync
◐ checking...
✓ up to date
```

Error:

```
$ stash sync
✗ sync failed: network error
```

```
$ stash sync
✗ sync failed: sync already in progress
```

### `stash watch`

Watches the current directory and syncs continuously until interrupted. See [Watch](#watch).

```
stash watch
```

Requires a configured connection. If none exists, exits immediately:

```
no connection configured — run `stash connect <provider>` first
```

### `stash status`

Shows configured connections and files changed since last sync.

```
stash status
```

Delegates to `stash.connections` and `stash.status()`.

---

## Sync Output

`stash sync` and `stash watch` share the same visual language for sync progress. A sync cycle has two visible phases:

1. **Checking** — fetching remote state. No mutations yet:

```
◐ checking...
```

2. **Syncing** — mutations are being applied. Each file is shown with a direction arrow:

```
◐ syncing... ↑ hello.md
◐ syncing... ↓ photo.jpg
◐ syncing... ↑↓ notes/todo.md
```

If there are no changes, the spinner goes straight from "checking..." to the final line.

Direction arrows map from `FileMutation`:
- **↑** pushed to remote — `disk: "skip"` with `remote: "write" | "delete"`
- **↓** pulled from remote — `remote: "skip"` with `disk: "write" | "delete"`
- **↑↓** both (merged) — `disk: "write", remote: "write"`

`disk: "skip", remote: "skip"` mutations are no-ops and are omitted from display.

**Color (TTY only):** dim for muted/header text, yellow for checking/syncing spinner, green for `✓`, red for `✗`. Arrows and file paths use default color. Non-TTY: no color.

When stdout is not a TTY, sync output is line-based: no spinner, no color, and no in-place overwrite.

### `src/ui/color.ts`

TTY-aware ANSI color helpers, no dependency:

```ts
function createColors(stream: NodeJS.WriteStream): {
  dim: (s: string) => string
  yellow: (s: string) => string
  green: (s: string) => string
  red: (s: string) => string
}
```

When `stream.isTTY` is false, all functions return the input unchanged.

### `src/ui/format.ts`

Pure helpers for arrow mapping, summary strings, elapsed time, and countdown:

```ts
type Direction = "up" | "down" | "both"

function mutationDirection(m: FileMutation): Direction
function directionArrow(d: Direction): string
function formatSummary(mutations: FileMutation[]): string
function formatTimeAgo(date: Date): string
function formatCountdown(targetDate: Date): string
```

`formatSummary()` returns strings like `"2↑ 1↓ 1↑↓"` or `""`.
`formatTimeAgo()` returns compact labels like `"just now"`, `"3s ago"`, `"2m ago"`.
`formatCountdown()` returns the remaining time until the target: `"27s"`, `"1m"`. Returns `"0s"` if the target is in the past.

### `src/ui/live-line.ts`

Terminal line primitive used by both `stash sync` and `stash watch`:

```ts
class LiveLine implements Disposable {
  constructor(stream: NodeJS.WriteStream)

  update(text: string): void
  print(text: string): void
  startSpinner(text: string): void
  spinnerText(text: string): void
  stopSpinner(): void
  dispose(): void
}
```

TTY behavior:
- `update()` rewrites the current line via carriage return + clear.
- Spinner frames are `["◐", "◓", "◑", "◒"]` at roughly 80ms.

Non-TTY behavior:
- `update()` is a no-op.
- `print()` writes a full line.

### `src/ui/sync-renderer.ts`

Per-sync renderer that consumes mutation events and produces a final summary:

```ts
class SyncRenderer implements Disposable {
  constructor(line: LiveLine)

  onMutation(mutation: FileMutation): void
  done(): string
  error(err: Error): void
  dispose(): void
}
```

Created fresh for each sync cycle. `onMutation()` updates spinner text (`syncing... <arrow> <path>`). `done()` stops spinner and returns the summary string for the final line.

Both `stash sync` and `stash watch` wire:
- `stash.on("mutation")` → `renderer.onMutation()`
- `renderer.done()` on success
- `renderer.error(err)` on failure

---

## Watch

Watch orchestration lives in `src/watch.ts` (CLI layer). Stash core remains unaware of watchers, timers, and terminal UI.

### Sync triggers

Two events can trigger a sync:

1. **Filesystem changes** in the stash directory — create/edit/delete. Debounced: waits for 1 second of quiet before running sync.
2. **Periodic poll** every 30 seconds — runs even with no local changes, so remote updates are picked up.

Filesystem filtering uses the same rules as `scan()`:
- Dotfiles and dot-directories ignored
- `.stash/` ignored
- Symlinks ignored

After any sync completes, the poll timer resets to a full 30 seconds.

If a poll fires during a debounce window, the poll is skipped (the debounced sync will cover both local and remote).

If filesystem events arrive while a sync is running, they are queued. After that sync completes, watch starts a new debounce cycle from the queued events.

An initial sync runs immediately on startup.

### Output

A static header is printed once (dim):

```
watching /Users/me/notes (. to sync, q to quit)
```

Below it, one live-updating status line:

**Idle after sync with changes:**
```
● 2↑ 1↓ 1↑↓ · checking in 27s
```

**Idle after check with no changes:**
```
● up to date · checking in 14s
```

**Checking/syncing:** shared Sync Output (checking → syncing phases).

**Error:**
```
✗ sync failed: network error · retrying in 27s
```

The countdown ticks down live so the user knows when the next check fires. On first launch, the watcher goes straight to `◐ checking...` with no idle state. Errors are shown but watch keeps running and retries every 30 seconds (no backoff).

### Keyboard

TTY only: stdin enters raw mode.

- **`.`** — triggers an immediate sync. If filesystem changes are actively arriving, debounce behavior still applies.
- **`q`** or **Ctrl-C** — graceful shutdown.

In non-TTY mode, no raw mode and no keyboard input handling.

### Shutdown

On `q` or Ctrl-C:

1. Stop filesystem watcher and poll timer.
2. If a sync is in progress, wait for it to finish.
3. Restore terminal from raw mode.
4. Print: `stopped watching /path/to/stash`
5. Exit 0.

A second Ctrl-C while waiting force-exits immediately.

### Non-TTY fallback

When stdout is not a terminal, watch logs one line per sync cycle (no spinner, no overwrite) and does not enable raw mode keyboard input.

### State machine

```ts
type WatchState = "idle" | "debouncing" | "syncing"
```

| From | Event | To | Action |
|------|-------|----|--------|
| `idle` | fs event | `debouncing` | start debounce timer (1s) |
| `idle` | poll timer fires | `syncing` | run sync |
| `idle` | `.` keypress | `syncing` | run sync |
| `debouncing` | fs event | `debouncing` | reset debounce timer |
| `debouncing` | debounce timer fires | `syncing` | run sync |
| `debouncing` | poll timer fires | `debouncing` | skip poll |
| `debouncing` | `.` keypress | `syncing` | cancel debounce, run sync |
| `syncing` | fs event | `syncing` | set pendingEvents flag |
| `syncing` | poll timer fires | `syncing` | skip poll |
| `syncing` → done | pendingEvents set | `debouncing` | start debounce timer |
| `syncing` → done | no pending events | `idle` | reset poll timer, update status line |
| `syncing` → error | — | `idle` | show error, reset poll timer |

All watch resources (watch subscription, timers, stdin listener, live line) are tracked in a `DisposableGroup`.

---

## Global Config

Location: `~/.stash/config.json`. Respects `$XDG_CONFIG_HOME` if set (`$XDG_CONFIG_HOME/stash/config.json`). Directory (`~/.stash/`) allows room for future global state (cache, logs).

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

## Tests

Unit tests for CLI presentation and watch orchestration modules.

### Unit Tests

#### format.ts

```
1. mutationDirection — push to remote
   - { disk: "skip", remote: "write" } → "up"
   - { disk: "skip", remote: "delete" } → "up"

2. mutationDirection — pull from remote
   - { disk: "write", remote: "skip" } → "down"
   - { disk: "delete", remote: "skip" } → "down"

3. mutationDirection — both (merged)
   - { disk: "write", remote: "write" } → "both"

4. directionArrow
   - "up" → "↑", "down" → "↓", "both" → "↑↓"

5. formatSummary — mixed directions
   - 2 up, 1 down, 1 both → "2↑ 1↓ 1↑↓"

6. formatSummary — single direction
   - 3 up → "3↑"

7. formatSummary — empty list
   - [] → ""

8. formatSummary — skip/skip mutations omitted
   - [{ disk: "skip", remote: "skip" }] → ""

9. formatTimeAgo
   - < 5s → "just now"
   - 30s → "30s ago"
   - 90s → "1m ago"
   - 3600s → "1h ago"

10. formatCountdown
   - target 27s in future → "27s"
   - target 90s in future → "1m"
   - target in past → "0s"
```

#### sync-renderer.ts

```
1. Accumulates mutations and returns summary
   - Create renderer, call onMutation() with several mutations
   - done() → returns correct summary string

2. No mutations — empty summary
   - Create renderer, call done() immediately
   - done() → ""

3. error() stops spinner without printing
   - Create renderer with a LiveLine mock
   - Call error()
   - Verify stopSpinner called, no print
```

