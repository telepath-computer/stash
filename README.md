# Stash

Conflict-free synced folders. Multiple people, agents, and machines can edit the same directory, then converge with a single `stash sync`.

## Quick Start

```bash
npm install -g @telepath-computer/stash
```

Set up GitHub access and connect the current directory:

```bash
stash background install
stash init
stash setup github
stash connect github --repo user/repo --background
```

You can initialize a directory explicitly with `stash init`, or let `stash connect` create `.stash/` for you automatically.

You'll need a GitHub [personal access token](https://github.com/settings/tokens). A classic token needs the `repo` scope. A fine-grained token needs **Contents: Read and write** permission on the target repo.

## How It Works

- `stash sync` pushes local changes, pulls remote changes, and merges concurrent edits in one operation.
- Text files are merged automatically. Different-region edits combine cleanly; overlapping edits preserve both sides instead of silently dropping content.
- Binary files use last-modified-wins.
- All files in the stash directory are tracked automatically except dotfiles, dot-directories, symlinks, and local-only `.stash/` metadata.

## Commands

```bash
stash background install
stash background add
stash init
stash setup github
stash connect github --repo user/repo --background
stash sync
stash watch
stash background status
stash status
stash disconnect github
stash background remove
stash background uninstall
```

`stash watch` keeps the directory in sync continuously. Press `.` to trigger an immediate sync and `q` to quit.

`stash background install` plus `stash connect --background` gives you boot-time background syncing managed by `launchd` on macOS or `systemd` on Linux.

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
