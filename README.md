# Stash

Conflict-free synced folders.

## How it works

Stash tracks a directory of files and syncs them to a remote provider (currently only GitHub implemented). When you run `stash sync`:

1. Local changes since the last sync are detected.
2. Remote changes are fetched.
3. Both sides are merged (concurrent text edits in different regions combine cleanly, and overlapping edits preserve both versions)
4. The merged result is written to disk and pushed to the remote.

Binary files use a last-modified-wins strategy.

## Getting started

You'll need Node.js with native TypeScript support (v22.6+).

### Install

```
cd code
npm install
npm link
```

This makes the `stash` command available globally.

### Set up GitHub

For GitHub sync, you'll need a GitHub personal access token, with read/write access to your repos. Simply run this from anywhere & follow the prompts:

```
stash setup github
```

### Initialize a stash

In the directory you want to sync, run:

```
stash init
```

### Connect to a GitHub repo

```
stash connect github --repo user/repo
```

The repo is used as the remote storage backend.

### Sync

```
stash sync
```

That's it. Run this whenever you want to push local changes and pull remote changes. There's no separate push or pull — sync does both.

### Check status

```
stash status
```

Shows configured connections and files changed since the last sync.

### Disconnect

```
stash disconnect github
```

## File tracking

- All files in the stash directory are tracked automatically.
- Dotfiles (files/directories starting with `.`) are ignored.
- Symlinks are ignored.

## Commands

| Command | Description |
|---|---|
| `stash init` | Initialize current directory as a stash |
| `stash setup <provider>` | Configure global provider settings (e.g. auth) |
| `stash connect <provider>` | Connect this stash to a provider |
| `stash disconnect <provider>` | Remove a provider connection |
| `stash sync` | Sync local files with the remote |
| `stash status` | Show connections and local changes |
