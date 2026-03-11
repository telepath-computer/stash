# Architecture

Stash has three main pieces:

- `src/cli.ts` and `src/watch.ts` handle command-line behavior, prompting, terminal output, and watch orchestration.
- `src/stash.ts` owns file scanning, reconciliation, snapshots, local metadata, and the sync lifecycle.
- `src/providers/` implements remote transports. Providers fetch and push state, but do not merge files or mutate local disk directly.

## Repository Layout

```text
src/
  cli.ts
  watch.ts
  stash.ts
  providers/
  ui/
  utils/
tests/
docs/
```

The repo is intentionally shaped like a normal package. Durable behavior and architecture knowledge lives in `docs/`; temporary planning does not.

## Boundary Rules

- The CLI is a thin layer over `Stash` and provider setup.
- `Stash` is the core engine. It decides what changed, how local and remote changes reconcile, when to push, and what to write locally.
- Providers are transport-only. They expose `fetch()`, `get()`, and `push()` and should stay unaware of local file semantics.
- UI helpers in `src/ui/` are presentation code for sync and watch output; they should not carry sync logic.

## `.stash/` Directory

Local metadata lives in `.stash/` inside the synced directory:

```text
.stash/
  config.local.json
  snapshot.json
  sync.lock
  snapshot.local/
```

- `config.local.json` stores per-directory provider connection settings.
- `snapshot.json` stores the last synchronized hash state and is the only `.stash/` file pushed to the remote.
- `sync.lock` is local-only and exists only while a sync is active.
- `snapshot.local/` stores text merge bases for later three-way merges.

By convention, `*.local.*`, `*.local/`, and `sync.lock` are never pushed to the remote.

## Source Of Truth

- `docs/api.md` defines the exported `Stash` and provider interfaces.
- `docs/sync.md` defines the sync lifecycle and the rules around locks, retries, and snapshots.
- `docs/reconciliation.md` defines how file changes combine.
- Code and tests define lower-level implementation details that are not important enough to freeze as repository contracts.
