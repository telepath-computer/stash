# Reconciliation

This document defines how Stash resolves local and remote file changes once both sides have been scanned.

## Guarantees

- Unchanged files are never touched.
- Concurrent text edits are merged rather than resolved by choosing one side.
- Overlapping text edits preserve both sides; content is not silently dropped.
- Binary files are never text-merged.
- Delete-vs-content conflicts resolve in favor of content.

## File Tracking

Tracked paths are all regular files in the stash directory except:

- dotfiles
- files inside dot-directories
- anything under `.stash/`
- symlinks

These rules are shared between scanning and watching through `src/utils/is-tracked-path.ts`.

## Change Model

Both local scan and provider fetch produce a `ChangeSet`:

```ts
interface ChangeSet {
  added: Map<string, FileState>
  modified: Map<string, FileState>
  deleted: string[]
}
```

`FileState` is either:

```ts
type FileState =
  | { type: "text"; content: string }
  | { type: "binary"; hash: string; modified: number }
```

## Merge Table

| Local | Remote | Disk | Remote | Result |
|-------|--------|------|--------|--------|
| unchanged | unchanged | skip | skip | no action |
| edited | unchanged | skip | write | push local content |
| unchanged | edited | write | skip | write remote content locally |
| edited | edited (text) | write or skip | write or skip | merge text, skip on a side if already identical |
| edited | edited (binary) | write or skip | write or skip | last-modified wins |
| created | absent | skip | write | push local file |
| absent | created | write | skip | pull remote file |
| created | created (text) | write or skip | write or skip | merge like concurrent text edits |
| created | created (binary) | write or skip | write or skip | last-modified wins |
| deleted | unchanged | skip | delete | delete remote file |
| unchanged | deleted | delete | skip | delete local file |
| deleted | edited | write | skip | restore remote content locally |
| edited | deleted | skip | write | preserve local content remotely |
| deleted | deleted | skip | skip | stay deleted |

## Text Merge Rules

Text merge uses `diff-match-patch`.

- If a snapshot base exists in `.stash/snapshot.local/`, Stash performs a three-way merge.
- If there is no snapshot base yet, Stash performs a two-way merge for first-sync behavior.
- If the merged content already matches one side exactly, that side's write is skipped.

This is why first sync can safely reconcile a populated local directory with a populated remote repo without blindly overwriting either side.

## Binary Rules

Anything that is not valid UTF-8 is treated as binary.

- Binary files are compared by content hash plus a `modified` timestamp stored in `snapshot.json`.
- When both sides changed the same binary path, the file with the later `modified` timestamp wins.
- The winning bytes are copied from the winning side; there is no merge attempt.

## Case Sensitivity

Stash treats path casing carefully so case-only renames converge correctly on case-insensitive filesystems.

- Drift checks require exact path casing for each segment.
- Deletes happen before writes during apply.
- Directory casing is corrected before writes when the mutation path differs only by case from what is on disk.

These rules prevent case-only renames from looking like spurious drift or from deleting newly written files during apply.
