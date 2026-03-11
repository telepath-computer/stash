# Development

## Setup

Requires Node.js v22.6+.

```bash
npm install
npm link
```

Run the CLI locally with:

```bash
npm run stash -- sync
```

## Test Commands

```bash
npm test
npm run test:e2e
npm run test:all
```

`npm run test:e2e` loads `.env` automatically if it exists by using Node's `--env-file-if-exists=.env` support. This is convenient for local `GITHUB_TOKEN` setup without exporting the variable in your shell first.

## Test Layers

- Unit tests cover core merge, snapshot, provider, and terminal-formatting behavior.
- Integration tests cover multi-step sync behavior with fake or mocked providers.
- End-to-end tests exercise real GitHub behavior and require `GITHUB_TOKEN`.

If `GITHUB_TOKEN` is not set, end-to-end tests should be skipped rather than treated as local development failures.

## End-To-End Requirements

The e2e suite in `tests/e2e/` uses the real GitHub API and creates disposable repositories. To run it successfully, all of the following need to be true:

- `GITHUB_TOKEN` must be set in the environment.
- A local `.env` file with `GITHUB_TOKEN=...` is sufficient when running `npm run test:e2e`, because the script loads `.env` automatically if present.
- The token must be able to:
  - read the authenticated user via `GET /user`
  - create private repositories via `POST /user/repos`
  - read and write repository contents on `main`
  - delete the temporary repositories afterward
- Network access to `api.github.com` must be available.
- The local machine must allow temp-directory creation under the system temp directory.
- The test runner must be allowed to write local config under temporary directories when CLI scenarios override `XDG_CONFIG_HOME`.

In practice, a classic token with `repo` scope is sufficient. For fine-grained tokens, the suite needs permissions broad enough to create and delete repositories plus read and write contents.

The e2e suite also assumes:

- repositories start empty and are disposable
- temporary local machine directories are created for one- and two-machine sync scenarios
- some flows may hit GitHub secondary rate limits, so the suite includes pacing and retry behavior around repo creation and sync

If these requirements are not met, `npm run test:e2e` may succeed with all tests skipped rather than actually validating GitHub-backed behavior.

## Docs Maintenance

This repository keeps a small durable `docs/` set rather than a large spec or plans tree.

Update docs when:

- the exported developer API changes
- a user-visible CLI contract changes
- a sync or reconciliation invariant changes
- a provider contract changes
- an architectural boundary changes

Do not add temporary execution plans to the repository. Use disposable local notes instead, and only promote durable outcomes into docs or tests.
