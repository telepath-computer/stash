# TODO

## Capabilities (user-facing)

In rough priority order:

1. **External sync target** (current branch: `spec/external-sync-target`) — see [`docs/plans/external-sync-target.md`](docs/plans/external-sync-target.md).
2. **Structured data syncing** — first-class support for syncing structured documents (JSON, YAML, TOML, etc.) with field-level merge semantics rather than whole-file last-writer-wins (granularity / merge behavior TBD).
3. **Direct p2p syncing** — sync between peers without a github intermediary; likely uses iroh and registers an `iroh:` URI scheme.

## Infrastructure

- **CLI↔daemon IPC** (Unix socket or SIGHUP) — replace the file-watch + poll fallback used in chunk #1 once we want synchronous "did the daemon pick this up?" confirmation, richer commands, or escape from `fs.watch` reliability quirks. Plumbing improvement, not a user-facing feature.
