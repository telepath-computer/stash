# Architecture

Stash has four main pieces:

- `src/cli.ts` and `src/cli-main.ts` handle command-line behavior, prompting, global config updates, and OS service commands.
- `src/watch.ts` owns the reusable watch loop for polling, filesystem events, debounce, and sync scheduling.
- `src/daemon.ts` manages one headless `Watch` instance per registered stash and persists background status/log files.
- `src/stash.ts` owns file scanning, reconciliation, snapshots, local metadata, and the sync lifecycle.
- `src/providers/` implements remote transports. Providers fetch and push state, but do not merge files or mutate local disk directly.

## Repository Layout

```text
src/
  cli.ts
  cli-main.ts
  watch.ts
  daemon.ts
  stash.ts
  service/
  providers/
  ui/
  utils/
tests/
docs/
```

The repo is intentionally shaped like a normal package. Durable behavior and architecture knowledge lives in `docs/`; temporary planning does not.

## Boundary Rules

- The CLI is a thin layer over `Stash`, provider setup, and background-service registration.
- `Stash` is the core engine. It decides what changed, how local and remote changes reconcile, when to push, and what to write locally.
- `Watch` is reusable scheduling/orchestration logic. It must stay headless: no stdin handling, no TTY rendering, no service-specific behavior.
- Providers are transport-only. They expose `fetch()`, `get()`, and `push()` and should stay unaware of local file semantics.
- `src/service/` is intentionally isolated from stash internals. It may not import `Stash` or other stash-specific modules.
- UI helpers in `src/ui/` are presentation code for sync and watch output; they should not carry sync logic.

## `.stash/` Directory

Local metadata lives in `.stash/` inside the synced directory:

```text
.stash/
  config.local.json
  snapshot.json
  status.json
  sync.log
  sync.lock
  snapshot.local/
```

- `config.local.json` stores per-directory provider connection settings.
- `snapshot.json` stores the last synchronized hash state and is the only `.stash/` file pushed to the remote.
- `status.json` stores the latest background watch result for `stash background status`.
- `sync.log` stores capped per-stash background sync logs.
- `sync.lock` is local-only and exists only while a sync is active.
- `snapshot.local/` stores text merge bases for later three-way merges.

Everything in `.stash/` is local-only except `snapshot.json`.

## Source Of Truth

- `docs/api.md` defines the exported `Stash` and provider interfaces.
- `docs/sync.md` defines the sync lifecycle and the rules around locks, retries, and snapshots.
- `docs/reconciliation.md` defines how file changes combine.
- Code and tests define lower-level implementation details that are not important enough to freeze as repository contracts.
