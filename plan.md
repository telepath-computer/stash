# Plan: Background Sync Service

## Summary

Add a background service that continuously syncs registered stashes without user interaction. The OS manages the service lifecycle (launchd on macOS, systemd on Linux). Users register stashes explicitly, and each stash logs and reports its own status.

## Key Decisions

- **Command group:** `stash background` (install, uninstall, add, remove, status, watch).
- **OS-managed service:** launchd plist on macOS, systemd unit on Linux. The service runs `stash background watch`. On unsupported platforms, `install` fails with a clear error.
- **Single process:** One daemon process watches all registered stashes. Each stash runs its own independent watch loop. Sync errors are isolated per stash; OS handles process-level crashes via restart.
- **Explicit registration:** Users register stashes via `stash background add [dir]` or `stash connect --background`. Stored in global config under a `background` key. `[dir]` defaults to cwd, stored as an absolute path.
- **Status:** Each stash writes `.stash/status.json` after every sync cycle. `stash background status` queries OS service status via the service module, then reads each status file. Socket-based live status deferred (#15).
- **Per-stash logging:** `.stash/sync.log`, capped at 1MB, truncate oldest lines.
- **Hot reload:** The daemon watches `config.json` via `@parcel/watcher`. When stashes are added/removed, it starts/stops watchers without restarting.
- **Global config format change:** Move provider config under a `providers` key. No migration code — internal team only, re-run `stash setup` to regenerate.
- **Drop `*.local.*` naming convention:** Only `snapshot.json` is pushed to remote; everything else in `.stash/` is local. Don't rename existing files, just don't extend the convention.
- **`install` resolves the absolute path** to the `stash` binary and bakes it into the service file. Fails with a clear error if the binary cannot be found.

## Service Module Interface (`src/service/`)

Standalone module with no stash imports. Publishable as a separate package later.

```typescript
install(options: {
  name: string
  description: string
  command: string
  args: string[]
}): Promise<void>

uninstall(options: { name: string }): Promise<void>

status(options: { name: string }): Promise<{
  installed: boolean
  running: boolean
}>
```

## Global Config Shape

```json
{
  "providers": {
    "github": { "token": "ghp_..." }
  },
  "background": {
    "stashes": ["/Users/me/notes", "/Users/me/work"]
  }
}
```

## Per-Stash Status File (`.stash/status.json`)

```json
{
  "kind": "synced",
  "lastSync": "2026-03-11T14:30:00.000Z",
  "summary": "1↑ 2↓",
  "error": null
}
```

`kind` aligns with existing `WatchStatus` in `watch.ts`: `"synced"`, `"checked"`, `"error"`.

## Commands

```
stash background install       # install OS service (one-time)
stash background uninstall     # remove OS service
stash background add [dir]     # register stash for background syncing
stash background remove [dir]  # unregister stash
stash background status        # show service state + per-stash status
stash background watch         # daemon entry point (hidden from help, run by the OS service). Prints a startup line then runs headless.
stash connect <provider> --background  # connect + background add in one step
```

## New Files

- `src/service/` — cross-platform service module (launchd, systemd; platform detection; install/uninstall/status). No stash imports.
- `src/daemon.ts` — loads config, manages Watch instances per stash, writes status.json and sync.log, watches config for hot reload.
- `src/ui/watch-renderer.ts` — interactive TTY layer for `stash watch`. Keyboard input, spinner, live line, countdown. Wraps a Watch instance.

## Changes to Existing Files

- `src/cli.ts` — add `stash background` command group and `--background` flag on `connect`
- `src/watch.ts` — extract core watch loop into a `Watch` class (fs events, debounce, poll, sync, event callbacks). No TTY, no stdin, no rendering. The current interactive presentation code moves to `src/ui/watch-renderer.ts`.
- `src/global-config.ts` — update to new config shape, add background stash list read/write helpers
- `src/types.ts` — update GlobalConfig type to structured format with `providers` and `background` keys

## Edge Cases

- Missing/moved stash directory: log error in status, keep it registered. User must `remove` explicitly.
- `background add` with no provider connected: allow, warn that syncs won't start until a provider is connected.
- `disconnect` while daemon is watching: leave registered, daemon does no-op syncs.
- Manual `stash watch` while daemon is watching same stash: existing `sync.lock` mechanism handles contention.
- Service installed but no stashes registered: daemon sits idle.
- `background add` without service installed: warn that the service isn't installed.

## Acceptance Criteria

- `stash background install` creates the correct service file for the current OS and enables it
- `stash background uninstall` removes the service file and stops the service
- `stash background add/remove` updates the background stash list in global config
- `stash background watch` loads the registry and runs Watch instances for all registered stashes
- Each stash writes `.stash/status.json` with kind, lastSync, summary, and error
- Each stash writes to `.stash/sync.log`, capped at 1MB
- `stash background status` queries OS service status, reads config, reads each status.json, prints summary
- `stash connect --background` connects and registers in one step
- `src/service/` has zero imports from stash code
- Watch class is reusable by both interactive watch and daemon
- Interactive `stash watch` behavior is unchanged
- All existing tests still pass

## Docs to Update

- `docs/architecture.md` — new modules, UI separation boundary rule, updated `.stash/` file list, drop `*.local.*` convention language
- `docs/cli.md` — new commands
- `docs/api.md` — updated GlobalConfig type, new exports if any
- `README.md` — mention background syncing in commands section

## Out of Scope

- Windows service support (#16)
- Socket-based IPC replacing state files and OS service queries (#15)
- Log rotation beyond simple size cap

## Platform Behavior

- `install`, `uninstall`: macOS and Linux only. Fail with "not supported on this platform yet" on other platforms.
- `status`: shows "service status: unsupported platform" on unsupported platforms, but still lists registered stashes and their status.json.
- `add`, `remove`, `watch`: work on all platforms. Windows users can run `stash background watch` manually as a degraded experience (no auto-start on boot).
