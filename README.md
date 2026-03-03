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

## Development

Requires Node.js v22.6+. From the `code/` directory:

```
npm install
npm link
npm test
```
