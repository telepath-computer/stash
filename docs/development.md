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
npm test                        # unit + integration (local)
npm run test:e2e                # e2e against real GitHub (local)
npm run test:all                # unit + integration + e2e (local)
npm run test:vm                 # full suite on a Linux VM (DigitalOcean)
npm run test:vm -- unit         # just unit + integration on VM
npm run test:vm -- e2e          # just e2e on VM
npm run test:vm -- service      # just systemd service lifecycle on VM
```

When running e2e or vm tests, always capture full output to a file so failure details are available without re-running:

```bash
npm run test:e2e 2>&1 | tee /tmp/stash-e2e.log
npm run test:vm  2>&1 | tee /tmp/stash-vm.log
```

The e2e and vm suites hit the real GitHub API and are expensive. Re-running to see error details can trigger secondary rate limits. Always inspect the log file for `failureType` and `error:` lines before deciding whether to re-run.

`npm run test:e2e` loads `.env` automatically via Node's `--env-file-if-exists=.env`. The VM script loads `.env` from the project root at startup.

## Test Layers

- **Unit tests** cover core merge, snapshot, provider, and terminal-formatting behavior.
- **Integration tests** cover multi-step sync behavior with fake or mocked providers.
- **End-to-end tests** exercise real GitHub behavior and require `GITHUB_TOKEN`.
- **VM tests** run the full suite on a real Linux VM plus systemd service lifecycle tests. Requires `DO_TOKEN` (DigitalOcean API token).

If `GITHUB_TOKEN` is not set, end-to-end tests are skipped rather than treated as failures.

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

## VM Test Requirements

The VM test suite in `tests/vm/` provisions a DigitalOcean droplet, rsyncs the project (including `.env`), runs the full test suite on Linux, and optionally tests systemd service lifecycle.

- `DO_TOKEN` must be set (DigitalOcean API token with droplet create/read/delete and SSH key read permissions).
- An SSH key at `~/.ssh/id_ed25519` is required (uploaded to DO automatically on first run).
- The droplet is destroyed after tests unless `VM_KEEP=1` is set.
- The `service` mode tests `stash start`, `stash status`, and `stash stop` behavior against real systemd.

## Docs Maintenance

This repository keeps a small durable `docs/` set rather than a large spec or plans tree.

Update docs when:

- the exported developer API changes
- a user-visible CLI contract changes
- a sync or reconciliation invariant changes
- a provider contract changes
- an architectural boundary changes

Do not add temporary execution plans to the repository. Use disposable local notes instead, and only promote durable outcomes into docs or tests.
