# TODO

## Maybe

- **Move/rename detection**: Currently a move is just delete + create. Could detect renames by content similarity (like git's >50% match). Main benefit: if machine A moves `foo→bar` while machine B edits `foo`, edits would land in `bar` instead of producing both files. Skipped for now because the simpler approach is safer (no data loss, user sees both files) and the complexity isn't justified yet.

- **Sync history and undo**: Track history of changes across syncs in `.stash/history/`. For text files, store either reverse diffs (compact, uses diff-match-patch) or previous snapshots (simple, no reconstruction logic). For binary files, keep a copy at deletion time in case of restore — edits to binaries can rely on remote history (e.g. GitHub git commits). Open questions: right granularity for history entries (per-sync or per-file?), diff vs full snapshot tradeoff, garbage collection of old history.
