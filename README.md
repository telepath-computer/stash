# Stash

Conflict-free synced folders. Multiple people and machines edit the same files — changes merge automatically, conflict-free.

## Quick start

```
npm install -g @telepath-computer/stash
```

Set up a stash and connect it to a GitHub repo:

```
stash setup github          # one-time: provide your GitHub token
stash connect github --repo user/repo
```

You'll need a GitHub [personal access token](https://github.com/settings/tokens). A classic token needs the `repo` scope. A fine-grained token needs **Contents: Read and write** permission on the target repo.

Now sync:

```
stash sync
```

Local changes are pushed, remote changes are pulled, concurrent edits are merged. There's no separate push or pull — sync does both.

### Watch

```
stash watch
```

Keeps your stash in sync continuously. Local edits are pushed, remote changes are pulled, and merges happen automatically in the background. Press `.` to sync immediately, `q` to quit.

### Other commands

```
stash setup github    # update your GitHub token
stash status          # show connections and local changes
stash disconnect github
```

### Config

Global config (GitHub token) is stored at `~/.stash/config.json` (or `$XDG_CONFIG_HOME/stash/config.json`). Per-stash config (which repo) is in `.stash/config.local.json` inside the synced directory.

## How merging works

The merge algorithm is the same as the one used by Obsidian Sync.

Text files are merged automatically using three-way merge. Edits in different regions combine cleanly. Overlapping edits preserve both versions — no data is silently lost.

Binary files use last-modified-wins.

## File tracking

All files in the stash directory are tracked automatically. Dotfiles, dot-directories, and symlinks are ignored.

## FAQ

**Will stash delete or overwrite my existing files?**

No. If you point stash at a directory that already has files, or connect it to a repo that already has content, stash merges both sides on first sync. Nothing is deleted. If both local and remote have the same file with different content, the changes are merged automatically. The merged result becomes the baseline for future syncs.

**Can I use the same repo with both stash and git?**

Yes, but not on the same machine. Stash syncs the working tree directly to `main` via the GitHub API — it doesn't use or know about local git state. If you also have a `.git` directory locally, switching branches will cause stash to see all the changed files and sync them to `main`. Don't use both in the same directory.

On the remote side, the repo is a normal git repo. Other people can clone it, push to it, make branches, open PRs — all the usual git workflows. Stash commits are regular git commits, so they interleave cleanly. If a git push and a stash sync happen at the same time, stash detects the conflict, re-fetches, re-merges, and retries automatically.

In short: each machine should be either a stash or a git checkout, not both.

**Does stash use branches or PRs?**

No. Stash only reads and writes the `main` branch. It doesn't create feature branches, pull requests, or tags.

**How is this different from git?**

Stash is designed for continuous, automatic syncing — like Dropbox or Obsidian Sync, but backed by a git repo. There's no staging, no commit messages to write, and no merge conflicts to resolve manually. Under the hood it uses its own three-way merge algorithm (diff-match-patch) instead of git's merge, so concurrent edits are combined automatically without conflict markers.

## Development

Requires Node.js v22.6+. From the `code/` directory:

```
npm install
npm link
npm test
```
