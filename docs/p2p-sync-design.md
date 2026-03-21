# P2P / Isomorphic Sync Design

This document explores what it would take to make any computer a sync target — not just GitHub or another cloud provider — and the snapshot restructuring that enables it.

## The Core Tension

The current design has a hidden asymmetry. A provider's remote holds a `snapshot.json` that represents *"what this remote currently has."* Locally, `.stash/snapshot.json` represents *"what was agreed on the last time I synced."* After a successful sync these two files converge to the same content — but they play different conceptual roles.

For a single connection to a neutral third party like GitHub, this works fine. The remote snapshot is always the authoritative "current state of the remote," and the local snapshot is always "what I last agreed to." They collapse into one name because there's only one relationship to track.

When any computer can be a sync target, this breaks. Machine A might sync with both B and C. After syncing with B, A's local snapshot reflects the A↔B agreed state. When A then syncs with C, it needs a *different* merge base — the last A↔C agreed state — not the A↔B result. A single `snapshot.json` cannot serve both relationships simultaneously.

## The Two-Tier Snapshot Model

The fix is to make the two roles explicit:

| Name | Role | Who reads it |
|---|---|---|
| `.stash/snapshot.json` | **Generic snapshot** — the current state of this machine after any sync | Remote peers read this to learn what you have |
| `.stash/sync/<connection>/snapshot.json` | **Last-sync snapshot** — the merge base for a specific connection | *You* read this to compute local changes since the last sync with that peer |

This is isomorphic: every machine (local or "remote") holds the same structure. The current system is just the degenerate single-connection case where both snapshots are always identical.

### Analogy to Git

- **Generic snapshot** ≈ `HEAD` — the current committed state of this working tree
- **Last-sync snapshot** ≈ `refs/remotes/origin/main` — what was agreed with a specific remote

A machine acting as a sync target exposes its generic snapshot (`HEAD`) for peers to diff against. Each peer tracks its own per-connection snapshot (`refs/remotes/...`) as the merge base.

## Revised `.stash/` Layout

```
.stash/
├── config.json                    # unchanged — connections, allow-git
├── snapshot.json                  # GENERIC — this machine's post-sync state
├── sync/
│   └── <connection-name>/
│       ├── snapshot.json          # LAST-SYNC — agreed state with this peer
│       └── snapshot/              # text merge bases for three-way merging (per-connection)
├── status.json                    # local-only daemon status
├── sync.log                       # local-only capped log
└── sync.lock                      # local-only lock
```

The current `.stash/snapshot/` (text merge bases) moves to `.stash/sync/<connection>/snapshot/` because the merge base content is inherently per-connection — different peers may have last agreed on different versions of a file.

### Migration from current layout

| Old path | New path |
|---|---|
| `.stash/snapshot.json` | `.stash/sync/<connection-name>/snapshot.json` |
| `.stash/snapshot/<file>` | `.stash/sync/<connection-name>/snapshot/<file>` |

The generic `.stash/snapshot.json` is initialized to the same content as the migrated per-connection snapshot (they are identical after any successful sync, so there's no information loss).

## How Sync Uses the Two Snapshots

Within one sync cycle with connection X:

1. **Scan local changes**: diff current disk state against `.stash/sync/x/snapshot.json` (the per-connection merge base). This correctly captures everything that changed since the last sync with X, including changes that came in from other connections.

2. **Fetch remote changes**: call `provider.fetch(lastSyncSnapshot)` where `lastSyncSnapshot` is `.stash/sync/x/snapshot.json`. The provider diffs the peer's generic `.stash/snapshot.json` against this to find what changed on the remote since the last sync with you.

3. **Reconcile**: unchanged from current behavior.

4. **Push**: the provider writes files to the peer and updates the peer's generic `.stash/snapshot.json`.

5. **Commit locally**:
   - Update `.stash/sync/x/snapshot.json` to the new agreed state.
   - Update `.stash/snapshot.json` (generic) to the same value.
   - Write text merge bases to `.stash/sync/x/snapshot/`.

After each sync, the generic snapshot advances to the latest agreed state across all connections. Per-connection snapshots advance independently per sync cycle.

## Provider Contract Changes

The `Provider` interface has a single clarification:

```ts
interface Provider {
  // localSnapshot is now sourced from sync/<connection>/snapshot.json,
  // NOT from the generic snapshot.json. Semantically the same — it's
  // still "what was agreed on last" — but explicitly per-connection.
  fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet>;

  get(path: string): Promise<Readable>;

  push(payload: PushPayload): Promise<void>;
}
```

The internal plumbing changes: `Stash` loads `sync/<connection>/snapshot.json` and passes it to `fetch()` instead of the root `snapshot.json`. Providers themselves don't change.

## What a Computer Provider Looks Like

A stash directory is already isomorphic with a GitHub repo in structure: files in the root, metadata in `.stash/`. A computer provider reads from both:

```
remote-machine/my-stash/
├── notes.md              ← actual files (stash root = the file store)
├── images/photo.png
└── .stash/
    └── snapshot.json     ← the manifest
```

This is identical to what a GitHub repo holds — the root is the file store, `.stash/snapshot.json` is the index. The computer provider reads the manifest from `.stash/` and actual file bytes from the stash root.

```ts
class ComputerProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [],
    connect: [
      { name: "host", label: "Host (user@hostname or IP)" },
      { name: "path", label: "Remote stash path" },
    ],
  };

  async fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet> {
    // 1. Read remote's .stash/snapshot.json (the generic snapshot).
    // 2. Diff against localSnapshot (our per-connection last-sync snapshot).
    // 3. Fetch text content from remote stash root for changed text files.
    // 4. Return ChangeSet.
  }

  async get(path: string): Promise<Readable> {
    // Stream the file directly from the remote stash root.
  }

  async push(payload: PushPayload): Promise<void> {
    // 1. Write payload.files into the remote stash root.
    // 2. Delete payload.deletions from the remote stash root.
    // 3. Atomically replace remote's .stash/snapshot.json with payload.snapshot.
    // 4. If the snapshot changed since fetch(), throw PushConflictError.
  }
}
```

### Atomicity

GitHub gives a consistent point-in-time view because a commit is a snapshot. When a peer reads a live stash directory, files can change mid-fetch — the manifest and the bytes may be momentarily out of sync.

Three options, in order of increasing complexity:

**Option 1 — Accept races, rely on hash verification.** The provider verifies each fetched file's hash against the snapshot. On mismatch it throws `PushConflictError`; stash retries. This is free and works well for most machines with moderate write rates.

**Option 2 — Content-addressed object store.** After each sync, hard-link (or copy) committed files into `.stash/objects/<hash>`. Peers fetch stable blobs from the object store, not the live filesystem. Atomicity guaranteed; no drift possible. Hard-linking makes this nearly free on the same filesystem.

```
.stash/
├── snapshot.json
├── objects/
│   ├── sha256-abc123     ← stable blob, hard-linked from stash root
│   └── sha256-def456
└── sync/
    └── <connection>/
        └── snapshot.json
```

**Option 3 — Atomic bundle.** Write a single immutable snapshot bundle into `.stash/` after each sync. Good for slow/unreliable links; wasteful for large stashes with small diffs.

**Recommendation:** Start with Option 1. The existing `PushConflictError` + retry loop already handles races. Add Option 2 if hash mismatches become a real problem in practice on busy machines.

## Multi-Connection Correctness

With two connections (B and C), A's sync state evolves like this:

```
Initial state:
  A/snapshot.json        = { ... }
  A/sync/b/snapshot.json = { ... }
  A/sync/c/snapshot.json = { ... }

A syncs with B (B has new files):
  A/snapshot.json        = agreed(A,B)   ← advances
  A/sync/b/snapshot.json = agreed(A,B)   ← advances
  A/sync/c/snapshot.json = { ... }       ← unchanged

A makes local edits (disk changes, not yet synced)

A syncs with C:
  scan uses A/sync/c/snapshot.json as base →
    correctly includes local edits AND B's changes (both are new to C)
  A/snapshot.json        = agreed(A,B,C) ← advances
  A/sync/b/snapshot.json = agreed(A,B)   ← unchanged
  A/sync/c/snapshot.json = agreed(A,B,C) ← advances

A syncs with B again:
  scan uses A/sync/b/snapshot.json →
    correctly shows only what changed since the last A↔B sync
    (C's content and A's local edits are "new" to B)
```

Each connection independently tracks its merge base. The generic snapshot always reflects the most recent agreed state with any peer.

## GitHub Provider Backward Compatibility

The GitHub provider maps cleanly onto this model:

| Two-tier concept | GitHub mapping |
|---|---|
| Generic snapshot | `.stash/snapshot.json` in the GitHub repo (unchanged) |
| Last-sync snapshot per connection | Local `.stash/sync/origin/snapshot.json` (was `.stash/snapshot.json`) |
| Text merge bases | `.stash/sync/origin/snapshot/` (was `.stash/snapshot/`) |

The provider code doesn't change at all — only where Stash saves/loads the local snapshot changes. The migration from the old single-snapshot layout to the per-connection layout is handled once.

## Unlocking Multiple Connections

The current `MultipleConnectionsError` exists because a single local `snapshot.json` can't serve multiple diverging sync relationships. With per-connection snapshots, this constraint is lifted. A stash can have connections to GitHub, a home server, and a colleague's machine simultaneously — each independently tracked, all converging toward the same content.

## Summary

The appropriate method is a **two-tier snapshot**:

1. **Generic snapshot** (`.stash/snapshot.json`) — the authoritative current state of this machine. Remote peers read it. Advances after any sync.

2. **Per-connection snapshot** (`.stash/sync/<connection>/snapshot.json`) — the merge base for one specific sync relationship. Used to compute local changes for that sync. Advances only when syncing with that connection.

This is isomorphic: every stash, regardless of whether it is "local" or "remote" in a given sync, holds the same structure. A cloud provider's repo and a laptop's stash directory differ only in transport, not in what they hold in `.stash/`.
