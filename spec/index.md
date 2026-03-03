# Spec: Stash

- **[stash.md](stash.md)** — Core engine. Sync algorithm, merge table, file tracking, architecture, data types, per-stash config.
- **[cli.md](cli.md)** — CLI commands, global config, stash registry, and the `stash watch` auto-sync feature.
- **[github-provider.md](github-provider.md)** — GitHub provider implementation. Storage layout, auth, fetch/push/get API calls, error handling.
- **[tests.md](tests.md)** — Testing strategy and end-to-end test scenarios. Unit/integration tests are specified in their respective spec files.

## Environment

- **Runtime**: Node.js with native TypeScript support (no compile step, no `--experimental-strip-types`).
- **Package manager**: npm.
- **No build step.** TypeScript is executed directly.
- **Minimal dependencies.** Standard library where possible (`node:test`, `node:assert`, `node:crypto`). External deps only when they earn their keep (e.g. `mitt`, `diff-match-patch`).

## Installation

From the `code/` directory:

```
npm install
npm link
```

This makes the `stash` command available globally. No build step required.
