# Stash

Conflict-free synced folders. Multiple people and machines edit the same files — changes merge automatically, conflict-free.

## Quick start

```
npm install -g @telepath-computer/stash
```

Set up a stash and connect it to a GitHub repo:

```
stash setup github          # one-time: provide your GitHub token
stash init                   # in the directory you want to sync
stash connect github --repo user/repo
```

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
stash status          # show connections and local changes
stash disconnect github
```

## How merging works

The merge algorithm is the same as the one used by Obsidian Sync.

Text files are merged automatically using three-way merge. Edits in different regions combine cleanly. Overlapping edits preserve both versions — no data is silently lost.

Binary files use last-modified-wins.

## File tracking

All files in the stash directory are tracked automatically. Dotfiles, dot-directories, and symlinks are ignored.

## FAQ

**Will stash delete or overwrite my existing files?**

No. If you point stash at a directory that already has files, or connect it to a repo that already has content, stash merges both sides on first sync. Nothing is deleted. If both local and remote have the same file with different content, the changes are merged automatically. The merged result becomes the baseline for future syncs.

**Can I use stash alongside normal git?**

Yes. Stash creates normal git commits (with the message `"stash: sync"`) via the GitHub API. They show up in `git log` like any other commit. Your colleagues can continue using `git push`, `git pull`, branches, and PRs on the same repo — stash will pick up their changes on the next sync and merge them in. If a git push and a stash sync happen at the same time, stash detects the conflict, re-fetches, re-merges, and retries automatically.

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
