# Stash

Conflict-free synced folders. Multiple people, agents, and machines can edit the same directory, then converge with a single `stash sync`.

## Quick Start

```bash
npm install -g @telepath-computer/stash
```

Set up GitHub access and connect the current directory:

```bash
stash setup github
stash connect github --repo user/repo
stash start
```

You'll need a GitHub personal access token. We recommend a **fine-grained token** scoped to only the repos you use with stash.

### Creating a GitHub Token

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Give it a name (e.g. `stash`)
3. Under **Repository access**, select **Only select repositories** and pick the repo(s) you'll sync
4. Under **Repository permissions**, set **Contents** to **Read and write**
5. Click **Generate token** and copy it

Use this token when running `stash setup github`.

> A classic token with the `repo` scope also works, but grants broader access than necessary.

## How It Works

- `stash sync` pushes local changes, pulls remote changes, and merges concurrent edits in one operation.
- Text files are merged automatically. Different-region edits combine cleanly; overlapping edits preserve both sides instead of silently dropping content.
- Binary files use last-modified-wins.
- All files in the stash directory are tracked automatically except dotfiles, dot-directories, symlinks, and local-only `.stash/` metadata.

## Commands

```bash
stash setup github
stash connect github --repo user/repo
stash start
stash stop
stash sync
stash watch
stash status
stash status --all
stash disconnect
stash disconnect github
```

`stash watch` keeps the directory in sync continuously. Press `.` to trigger an immediate sync and `q` to quit.

`stash start` enables boot-time background syncing managed by `launchd` on macOS or `systemd` on Linux. Connected stashes are registered automatically.

`stash disconnect` removes the current stash completely. `stash disconnect <provider>` removes one provider connection and removes `.stash/` too if that was the last one.

Typical `stash start` output:

```text
Background sync is on
Watching 1 stash · starts on startup
```

## Config

- Global config lives at `~/.stash/config.json` or `$XDG_CONFIG_HOME/stash/config.json`.
- Per-stash connection config lives at `.stash/config.local.json` inside the synced directory.

Example global config:

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

## Docs

- `docs/api.md` - developer-facing `Stash` and provider contracts
- `docs/architecture.md` - core components and repo boundaries
- `docs/sync.md` - sync lifecycle, locking, drift, and snapshot semantics
- `docs/reconciliation.md` - merge and file-resolution rules
- `docs/cli.md` - user-facing CLI behavior
- `docs/providers/github.md` - GitHub remote contract
- `docs/development.md` - local development and testing

## FAQ

**Will stash delete or overwrite my existing files?**

Not blindly. On first sync, local and remote content are reconciled rather than replaced wholesale. The result becomes the baseline for future syncs.

**Can I use the same repo with both stash and git?**

Yes, but not on the same machine and directory. Stash syncs the working tree directly to `main` through the GitHub API and does not understand local git state.

**Does stash use branches or PRs?**

No. Stash reads and writes the `main` branch directly.

## Development

Requires Node.js v22.6+.

```bash
npm install
npm link
npm test
```
