# Tests

## Strategy

Three layers of testing:

- **Unit & integration tests** — specified in the relevant spec files (`stash.md`, `github-provider.md`). Cover internal functions (`scan()`, `reconcile()`, `mergeText()`, `computeSnapshot()`, etc.) and `Stash.sync()` with mock/fake providers.
- **End-to-end tests** — specified here. Cover all user-facing behavior from `stash.md`. Real filesystem, real GitHub API, real repos.

The rest of the codebase should have thorough unit and integration test coverage. Each spec file is responsible for defining the tests relevant to its domain.

## Commands

```
npm test          # unit & integration tests only (fast, no network)
npm run test:e2e  # end-to-end tests only (requires GITHUB_TOKEN)
npm run test:all  # everything
```

## Framework

`node:test` with `node:assert/strict`. No external test dependencies.

TypeScript executed natively by Node (no compile step).

---

## End-to-End Setup

### Environment

Tests require a `GITHUB_TOKEN` environment variable with `repo` scope (read, write, delete). If not set, all e2e tests skip (not fail).

The authenticated user is discovered via `GET /user` — no account name configuration needed.

### Repo lifecycle

Each test creates a fresh private repo and deletes it when done:

```ts
let repo: string

beforeEach(async () => {
  const name = `stash-test-${crypto.randomUUID().slice(0, 8)}`
  // POST /user/repos → { name, private: true, auto_init: false }
  repo = `${username}/${name}`
})

afterEach(async () => {
  // DELETE /repos/{repo}
})
```

Repos are private, empty (no auto-init), and named `stash-test-{random}`.

### Simulating two machines

Tests that involve two-machine scenarios use two separate local directories pointing at the same GitHub repo:

```ts
const machineA = tmp("machine-a")  // temp dir
const machineB = tmp("machine-b")  // temp dir
// both connect to the same repo
```

Each directory is an independent stash with its own `.stash/`, snapshots, and local state. They interact only through the shared remote repo — exactly like two real machines.

### Temp directories

All stash directories are created in the system temp directory and cleaned up after each test.

---

## Scenarios

### Init

#### 1. Init creates a stash

```
- Create a temp directory with a file `hello.md` ("hello")
- Run stash init
- .stash/ directory exists
- hello.md is untouched ("hello")
```

#### 2. Init on existing stash is a no-op

```
- Init a stash
- Init again in the same directory
- No error, no changes to .stash/
- Inform the user (return value or event indicates already initialized)
```

### Setup & Connect

#### 3. Setup stores provider credentials

```
- Run stash setup github with --token flag
- Global config at ~/.stash/config.json contains { github: { token: "..." } }
```

Use a temporary home directory to avoid polluting the real config.

#### 4. Connect stores connection config

```
- Init a stash
- Setup github (token)
- Connect github with --repo flag
- .stash/config.local.json contains { connections: { github: { repo: "..." } } }
```

#### 5. Connect auto-prompts for setup if missing

```
- Init a stash (no prior setup)
- Connect github with --repo and --token flags
- Both global config (token) and local config (repo) are written
```

#### 6. Disconnect removes connection

```
- Init, setup, connect
- Disconnect github
- .stash/config.local.json has no github connection
- Subsequent sync is a no-op
```

### Sync — First Sync

#### 7. First sync pushes local files to empty remote

```
- Init stash with files: hello.md ("hello"), notes/todo.md ("buy milk")
- Connect to empty repo
- Sync
- Verify remote has hello.md, notes/todo.md, and .stash/snapshot.json
- Verify snapshot.json contains correct hashes for both files
```

Verify remote contents via the GitHub API (fetch tree + file contents).

#### 8. First sync pulls remote files to empty local stash

```
- Push files to repo manually via API: readme.md ("welcome"), data/config.json ("{}")
  Include a valid .stash/snapshot.json alongside the files
- Init empty stash, connect to repo
- Sync
- Verify readme.md ("welcome") and data/config.json ("{}") exist on disk
- Verify .stash/snapshot.json and .stash/snapshot.local/ are written
```

#### 9. First sync merges when both sides have files

No snapshot exists on either side yet, so this is a two-way merge.

```
- Push files to repo via API (without .stash/snapshot.json): shared.md ("remote content")
  This simulates a repo initialized outside of stash (e.g. via GitHub UI)
- Init stash with local file: local.md ("local content")
- Connect and sync
- Both shared.md and local.md exist locally
- Both shared.md and local.md exist on remote
- snapshot.json covers both files
```

### Sync — Merge Table

Each test below starts from a synced baseline: Machine A and Machine B both connected to the same repo, initial sync done, both have the same files and snapshot.

Setup helper:

```ts
// Create machineA and machineB temp dirs
// Init and connect both to the same repo
// Write initial files in machineA, sync
// Sync machineB (pulls files down)
// Now both machines have identical state
```

#### 10. Local edit, remote unchanged — pushes local

```
- Baseline: hello.md ("hello")
- Machine A: edit hello.md → "hello world"
- Machine A: sync
- Verify remote hello.md is "hello world"
- Machine B: sync
- Verify Machine B hello.md is "hello world"
```

#### 11. Remote edit, local unchanged — pulls remote

```
- Baseline: hello.md ("hello")
- Machine A: edit hello.md → "hello world", sync
- Machine B: sync (no local changes)
- Verify Machine B hello.md is "hello world"
```

#### 12. Both edit (text, different regions) — three-way merge

```
- Baseline: hello.md ("line1\nline2\nline3")
- Machine A: edit → "LINE1\nline2\nline3", sync
- Machine B: edit → "line1\nline2\nLINE3", sync
- Verify Machine B hello.md is "LINE1\nline2\nLINE3"
- Machine A: sync
- Verify Machine A hello.md is "LINE1\nline2\nLINE3"
```

Both edits preserved. No data lost.

#### 13. Both edit (text, overlapping region) — both versions preserved

```
- Baseline: hello.md ("hello world")
- Machine A: edit → "hello brave world", sync
- Machine B: edit → "hello cruel world", sync
- Verify Machine B hello.md contains both "brave" and "cruel"
- No content silently lost
```

The exact merged output depends on diff-match-patch behavior. The assertion is that both edits appear in the result — the spec guarantees no silent data loss.

#### 14. One side creates file — pushes and pulls

```
- Machine A: create new.md ("draft"), sync
- Verify remote has new.md ("draft")
- Machine B: sync
- Verify Machine B has new.md ("draft")
```

#### 15. Both create same path (text) — merged

```
- Machine A: create notes.md ("from A"), sync
- Machine B: create notes.md ("from B"), sync
- Verify Machine B notes.md contains both "from A" and "from B"
- Machine A: sync
- Verify Machine A matches Machine B
```

#### 16. One side deletes, other unchanged — deletes everywhere

```
- Baseline: hello.md ("hello")
- Machine A: delete hello.md, sync
- Verify remote does not have hello.md
- Machine B: sync
- Verify Machine B does not have hello.md
```

#### 17. Local deletes, remote edits — content wins

```
- Baseline: hello.md ("hello")
- Machine A: delete hello.md (don't sync yet)
- Machine B: edit hello.md → "hello world", sync (pushes edit to remote)
- Machine A: sync (local=deleted, remote=edited)
- Verify Machine A hello.md is "hello world" (content wins, file restored)
- Verify remote hello.md is "hello world"
```

#### 18. Local edits, remote deletes — content wins

```
- Baseline: hello.md ("hello")
- Machine A: edit hello.md → "hello world" (don't sync yet)
- Machine B: delete hello.md, sync (pushes deletion to remote)
- Machine A: sync (local=edited, remote=deleted)
- Verify Machine A hello.md is "hello world" (content wins, kept)
- Verify remote hello.md is "hello world" (re-created)
```

#### 19. Both delete — stays deleted

```
- Baseline: hello.md ("hello")
- Machine A: delete hello.md, sync
- Machine B: delete hello.md, sync
- Verify hello.md gone from both sides
- No errors
```

### Sync — Binary Files

#### 20. Binary file round-trip

```
- Machine A: create image.png (random bytes, not valid UTF-8), sync
- Machine B: sync
- Verify Machine B image.png is byte-identical to Machine A's
```

#### 21. Binary concurrent edit — last-writer-wins

The `modified` timestamp in `snapshot.json` is set at push time. The last machine to sync wins because its push timestamp is later.

```
- Baseline: image.png (some bytes, both machines synced)
- Machine A: overwrite image.png with bytes-A, sync (pushes, modified=T1)
- Machine B: overwrite image.png with bytes-B, sync (pushes, modified=T2, T2 > T1)
- Machine B has bytes-B (its own version, last writer)
- Machine A: sync
- Verify Machine A has bytes-B (Machine B's version wins, T2 > T1)
```

### Sync — Edge Cases

#### 22. Sync with no connection is a no-op

```
- Init stash, do NOT connect
- Create files
- Sync
- No error, no network calls, files unchanged
```

#### 23. Nested directory structure

```
- Machine A: create a/b/c.md ("deep"), sync
- Machine B: sync
- Verify Machine B has a/b/c.md ("deep")
- Verify path is preserved exactly
```

#### 24. Empty file

```
- Machine A: create empty.md (""), sync
- Machine B: sync
- Verify Machine B has empty.md with empty content
```

#### 25. Convergence after multiple sync cycles

The end-to-end version of conflict resolution: after both sides make various changes and sync, they converge to identical state.

```
- Baseline: a.md ("a"), b.md ("b"), c.md ("c")
- Machine A: edit a.md → "a2", delete b.md, create d.md ("d")
- Machine B: edit b.md → "b2", edit c.md → "c2", create e.md ("e")
- Machine A: sync
- Machine B: sync
- Machine A: sync (picks up B's changes)
- Verify both machines have identical files:
    a.md  → "a2"
    b.md  → "b2" (content wins over delete)
    c.md  → "c2"
    d.md  → "d"
    e.md  → "e"
- Verify snapshot.json matches on both sides
```

### Status

#### 26. Status shows changes since last sync

```
- Init, connect, create hello.md, sync
- Create new.md, edit hello.md, delete some-other-file (if baseline has one)
- Call status()
- Result includes: added ["new.md"], modified ["hello.md"], deleted [...]
- Result includes lastSync date (not null)
- Connections include github
```

#### 27. Status with no prior sync

```
- Init, connect, create hello.md
- Call status()
- added: ["hello.md"], modified: [], deleted: []
- lastSync: null
```

### File Tracking

#### 28. Dotfiles are ignored

```
- Machine A: create .hidden ("secret") and visible.md ("public"), sync
- Verify remote has visible.md but NOT .hidden
- Machine B: sync
- Verify Machine B has visible.md but NOT .hidden
```

#### 29. Dot-directories are ignored

```
- Machine A: create .config/settings.json ("{}") and notes.md ("note"), sync
- Verify remote has notes.md but NOT .config/settings.json
```

#### 30. Symlinks are ignored

```
- Machine A: create real.md ("content"), create a symlink link.md → real.md, sync
- Verify remote has real.md but NOT link.md
```

#### 31. .stash/ directory is ignored

```
- Init, connect, create hello.md, sync
- Verify remote does not contain .stash/config.local.json
- Verify remote does not contain .stash/snapshot.local/
- Verify remote DOES contain .stash/snapshot.json (the one managed file)
```

### Sync — In-Flight Edit Races

#### 32. Preserve local edits made after scan but before push

```
- Baseline: doc.md ("line1\nline2\nline3\n")
- Remote (Bob): doc.md changed to append "BOB_END"
- Local (Alice): doc.md changed to prepend "ALICE_EARLY"
- Start sync and pause provider fetch so scan has completed
- While sync is paused, local changes again to prepend "ALICE_LATE"
- Resume sync
- Verify final local doc.md contains "ALICE_LATE" and "BOB_END"
```

This validates the pre-push race window (`scan()` → `push()`) and requires sync restart on drift.

#### 33. Preserve local edits made after push but before apply

```
- Baseline: doc.md ("line1\nline2\nline3\n")
- Remote (Bob): doc.md changed to append "BOB_END"
- Local (Alice): doc.md changed to prepend "ALICE_EARLY"
- Start sync and pause provider push after remote write succeeds, before local apply
- While sync is paused, local changes again to prepend "ALICE_LATE"
- Resume sync
- Verify final local doc.md contains "ALICE_LATE" (not overwritten)
- Run a subsequent sync cycle
- Verify final local doc.md contains both "ALICE_LATE" and "BOB_END"
```

This validates the post-push race window (`push()` → `apply()`) and requires skip-on-drift (no post-push restart), with convergence on a later sync.

#### 34. Push conflict retries are bounded

```
- Configure provider/test harness to force PushConflictError on every push attempt
- Run sync
- Verify sync fails after exactly 5 attempts (bounded retry)
- Verify no additional push attempts occur after failure
```

This validates retry bounds for remote-ref races and prevents infinite conflict loops.

#### 35. Drift-restart retries are bounded

```
- Configure provider/test harness to force drift detection on every cycle
  (pre-push drift)
- Run sync
- Verify sync fails after exactly 5 attempts
- Verify no unbounded restart loop occurs
- Verify the failed cycle does not proceed to apply/save after terminal failure
```

This validates retry bounds for local in-flight edits under sustained churn.

### Sync — Case-Insensitive Filesystems

#### 36. Case-only rename syncs to remote and back

```
- Machine A: sync "notes/Arabella.md" with content "hello"
- Machine A: rename to "notes/arabella.md" on disk (same content)
- Machine A: sync() — succeeds, no drift error
- Verify remote has "notes/arabella.md" and no "notes/Arabella.md"
- Machine B: sync()
- Verify Machine B has "notes/arabella.md" with content "hello"
```

This validates that case-only renames don't trigger false drift detection on case-insensitive filesystems (e.g. macOS APFS).
