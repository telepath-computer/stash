# Reconcile: skip writes when content is identical

## Why

When both sides have the same file with the same content — most commonly on first sync when connecting to a repo that already has the same files — reconcile produces `disk: "write", remote: "write"` mutations even though neither side needs updating. This causes unnecessary disk writes, a redundant push to the remote, and a misleading `✓ synced (2↑↓)` summary when the correct output is `✓ up to date`.

The root cause is that `reconcile` always emits `write/write` for the "both modified" and "both added" cases, without checking whether the merged result actually differs from what each side already has.

## Behavior

After computing the merged result in `reconcile`, compare it against the inputs before deciding `disk` and `remote`:

**Text files (both added or both modified):**

After calling `mergeText()`, the merged result is compared against each side:

- If `merged === localState.content` → `disk: "skip"` (disk already has the right content)
- If `merged === remoteState.content` → `remote: "skip"` (remote already has the right content)
- If both → `disk: "skip", remote: "skip"` (nothing to do)

The most common case is `local === remote` (identical content on both sides), where `mergeText` short-circuits and returns either input. Both comparisons pass, producing `skip/skip`.

When edits are in different regions: merged differs from both inputs → `write/write` (unchanged behavior). When only one side edited: merged equals that side → one `skip`, one `write` (unchanged behavior, but now this is explicit rather than relying on the earlier "only one side changed" branches).

**Binary files (both added or both modified):**

After determining the winner via last-modified-wins, compare the winner's hash against the loser's hash:

- If hashes are equal → `disk: "skip", remote: "skip"` (same binary on both sides)
- If hashes differ → `write/write` with `source` pointing to the winner (unchanged behavior)

## Downstream handling

All downstream code already handles `skip` correctly:

- **`buildPushPayload`**: only includes mutations where `remote === "write"`. Skip means nothing pushed for that file.
- **`apply`**: only writes to disk when `disk === "write"`. Skip means no disk write.
- **`computeSnapshot`**: a `skip/skip` mutation with `content` set hits the `content !== undefined` branch, correctly recording the file hash. It does not fall into the delete detection path (which requires `content === undefined && source === undefined`).
- **`saveSnapshot`**: checks `content !== undefined` first, so `skip/skip` with content still gets its `snapshot.local/` entry written.
- **`formatSummary`**: already filters out `skip/skip` mutations from the count. When all mutations are `skip/skip`, the summary is empty and the CLI prints `✓ up to date`.

**Push-skip check updated.** The existing check skips the push when `payload.files.size === 0 && payload.deletions.length === 0`. With the reconcile optimization, this triggers more often — any time all mutations are `skip/skip`. But the push payload always includes `snapshot.json`, and on first sync (or any sync where the snapshot changed), that snapshot needs to reach the remote even if no files changed.

The fix: also compare `nextSnapshot` against `localSnapshot`. If the snapshot changed, push even with an empty file payload. The commit will contain only the updated `.stash/snapshot.json`.

```
const snapshotChanged = JSON.stringify(nextSnapshot) !== JSON.stringify(localSnapshot);
if (payload.files.size === 0 && payload.deletions.length === 0 && !snapshotChanged) {
  break;
}
```

This handles the common case of first sync to a repo with no `.stash/snapshot.json` — reconcile produces `skip/skip` (no redundant file writes), but the snapshot is new, so it gets pushed. On subsequent syncs where nothing changed, both the payload and snapshot are unchanged, so the push is correctly skipped.

## Targets

### `spec/stash.md`

1. Update the FileMutation merge table to note the skip optimization:

| Local | Remote | disk | remote | content / source |
|-------|--------|------|--------|------------------|
| modified | modified (text) | write or skip | write or skip | merged via `mergeText()` — skip if merged equals that side's content |
| modified | modified (binary) | write or skip | write or skip | source: last-modified wins — skip if hashes equal |
| added | added (text) | write or skip | write or skip | merged via `mergeText()` — skip if merged equals that side's content |
| added | added (binary) | write or skip | write or skip | source: last-modified wins — skip if hashes equal |

All other rows are unchanged.

2. Update `sync()` step 5 — push is skipped when the payload has no file writes or deletions **and** the snapshot hasn't changed. If the snapshot changed (e.g. first sync establishing the baseline), a snapshot-only commit is pushed even with no file changes.

### `code/src/stash.ts`

1. In `reconcile`, after computing the merged result for text and binary "both changed" cases, compare against inputs to determine skip/write for each side.
2. In `sync()`, update the push-skip check to also consider whether the snapshot changed.

## Tests

### Unit tests (`stash-reconcile.test.ts`)

```
1. reconcile: both added text with identical content produces skip/skip
   - Both sides add "notes.md" with content "hello"
   - Result: { path: "notes.md", disk: "skip", remote: "skip", content: "hello" }

2. reconcile: both modified text with identical content produces skip/skip
   - Both sides modify "a.md" to "updated"
   - Result: { path: "a.md", disk: "skip", remote: "skip", content: "updated" }

3. reconcile: both added text with different content (existing test, updated assertion)
   - Local adds "notes.md" with "from A", remote adds "notes.md" with "from B"
   - Two-way merge produces "from B" (remote wins in diff-match-patch)
   - merged === remoteState.content → remote: "skip"
   - merged !== localState.content → disk: "write"
   - Result: { disk: "write", remote: "skip", content: "from B" }
   - Previously asserted disk: "write", remote: "write" — remote changes to "skip"

4. reconcile: both added binary with identical hash produces skip/skip
   - Both sides add "img.png" with hash "same-hash", different mtimes
   - Result: { path: "img.png", disk: "skip", remote: "skip", source: "local", hash: "same-hash", modified: (winner mtime) }
   - source is retained so computeSnapshot doesn't misidentify the mutation as a delete

5. reconcile: both modified binary with identical hash produces skip/skip
   - Both sides modify "img.png", same hash, different mtimes
   - Result: { path: "img.png", disk: "skip", remote: "skip", source: "local", hash: "same-hash", modified: (winner mtime) }
   - source is retained so computeSnapshot doesn't misidentify the mutation as a delete

6. reconcile: both modified binary with different hashes still produces write/write
   - Existing tests (lines 44-66, 68-90) use different hashes → winner differs from loser → write/write. Unchanged.
```

### Integration tests (`stash-sync.test.ts`)

```
7. sync: first sync with identical content on both sides skips file writes
   - makeStash with files: hello.md ("hello"), notes/todo.md ("buy milk")
   - FakeProvider initialized with same files and matching snapshot
   - sync()
   - No file content in push payload (pushLog last entry has empty files map)
   - Push still happens (snapshot needs to reach remote)
   - Files on disk unchanged
   - Local snapshot.json written with correct hashes
   - snapshot.local/ entries written

8. sync: skip/skip mutations with changed snapshot still pushes snapshot
   - makeStash with hello.md ("hello"), sync once to establish baseline
   - Both sides change hello.md to "updated" (local on disk, remote in FakeProvider)
   - sync()
   - Push happens (snapshot hash changed)
   - Push payload has no file content (files map empty)
   - Local snapshot.json updated with new hash
```

### E2E tests (`stash-github-scenarios.e2e.test.ts`)

```
scenario 32: first sync with identical local and remote content skips redundant writes
   - Create repo, push hello.md ("hello") directly via API (no .stash/snapshot.json)
   - Init local stash with hello.md ("hello"), connect to repo
   - sync()
   - Verify hello.md on disk still reads "hello"
   - Verify remote .stash/snapshot.json now exists (snapshot was pushed)
   - Verify remote hello.md still reads "hello" (content unchanged)
   - Verify local .stash/snapshot.json written with correct hash
   - Second sync() is a clean no-op (no errors, no changes)
```
