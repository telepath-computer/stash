# Spec: Stash

- **[main.md](main.md)** — Core behavior, architecture, and data types. CLI commands, sync algorithm, merge table, file tracking, config system.
- **[github-provider.md](github-provider.md)** — GitHub provider implementation. Storage layout, auth, fetch/push/get API calls, error handling.
- **[tests.md](tests.md)** — Testing strategy and end-to-end test scenarios. Unit/integration tests are specified in their respective spec files.

## Environment

- **Runtime**: Node.js with native TypeScript support (no compile step, no `--experimental-strip-types`).
- **Package manager**: npm.
- **No build step.** TypeScript is executed directly.
- **Minimal dependencies.** Standard library where possible (`node:test`, `node:assert`, `node:crypto`). External deps only when they earn their keep (e.g. `mitt`, `diff-match-patch`).
