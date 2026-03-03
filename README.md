# Stash

Conflict-free synced folders. Multiple people and machines edit the same files — changes merge automatically, conflict-free.

## Quick start

You'll need Node.js v22.6+ (native TypeScript support). From the `code/` directory:

```
npm install && npm link
```

Then set up a stash and connect it to a GitHub repo:

```
stash setup github          # one-time: provide your GitHub token
stash init                   # in the directory you want to sync
stash connect github --repo user/repo
```

Now sync:

```
stash sync
```

That's it. Local changes are pushed, remote changes are pulled, concurrent edits are merged. There's no separate push or pull — sync does both.

Run `stash status` to see what's changed since the last sync, and `stash disconnect github` to remove the connection.

## How merging works

The merge algorithm is the same as the one used by Obsidian Sync.

Text files are merged automatically using three-way merge. Edits in different regions combine cleanly. Overlapping edits preserve both versions — no data is silently lost.

Binary files use last-modified-wins.

## File tracking

All files in the stash directory are tracked automatically.

Dotfiles, dot-directories, and symlinks are ignored.
