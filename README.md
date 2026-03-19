# Stash

Conflict-free synced folders. Multiple people, agents, and machines can edit the same directory, then converge with a single `stash sync`.

## Quick Start

```bash
npm install -g @telepath-computer/stash
cd dir-to-sync/ && stash connect <provider>
stash start
```

## Using the GitHub provider

Right now, the only sync endpoint for Stash is a GitHub repo. To get this running, you'll need a GitHub personal access token. We recommend a **fine-grained token** scoped to only the repos you use with stash.

[Create a new repo on GitHub](https://github.com/new) to use for sync.

Set up GitHub access and connect the current directory, following the prompts to enter your repo and token (you'll only need to enter the token once):

```bash
cd dir-to-sync/
stash connect github
```

Then you can choose how you want to sync it:

```bash
stash sync # Sync once
stash watch # Watch this stash & sync continuously in the foreground
stash start # Sync all stashes in the background (resumes on restart)
```

### Creating a GitHub Token

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Give it a name (e.g. `stash`)
3. Under **Repository access**, either allow all repos, or choose **Only select repositories** and pick the repo(s) you want to use for stash
4. Under **Repository permissions**, set **Contents** to **Read and write**
5. Click **Generate token** and copy it

Use this token when running `stash setup github`.

A classic token with the `repo` scope also works.

## How It Works

- `stash sync` pushes local changes, pulls remote changes, and merges concurrent edits in one operation.
- Text files are merged automatically. Different-region edits combine cleanly; overlapping edits preserve both sides instead of silently dropping content.
- Binary files use last-modified-wins.
- All files in the stash directory are tracked automatically except dotfiles, dot-directories, symlinks, and local-only `.stash/` metadata.

## All commands

```bash
stash connect <provider> <options> # Initializes a stash with a provider
stash start # Starts the background process, and resumes on startup
stash stop # Stops & uninstalls the background process
stash sync # Syncs the directory once
stash watch # Keeps directory in sync continously, in the foreground
stash setup <provider> # Modifies the provider setup (e.g. auth token)
stash status # Prints the status of the stash you are in
stash status --all # Prints the status of all stashes
stash disconnect # Disconnects the stash from providers, stops syncing
stash config set <key> <value> # Set a per-stash config value (e.g. allow-git)
stash config get <key> # Get a per-stash config value
```

## Using Stash With Git

By default, stash refuses to sync a directory that contains `.git/`. Branch switches look like mass file edits to stash, so syncing inside a git working tree can push destructive changes to the remote.

If you do not need git in that directory, remove `.git/`. If you intentionally want both, run `stash config set allow-git true` first, then keep stash pinned to one branch and do not switch branches while stash is active. Behaviour in that configuration is undefined — make a backup.

## FAQ

**Will stash delete or overwrite my existing files?**

Not blindly. On first sync, local and remote content are reconciled rather than replaced wholesale. The result becomes the baseline for future syncs.

**Can I use the same repo with both stash and git?**

Yes, but not on the same machine and directory. Stash syncs the working tree directly to `main` through the GitHub API and does not understand local git state.

**Does stash use branches or PRs?**

No. Stash reads and writes the `main` branch directly.
