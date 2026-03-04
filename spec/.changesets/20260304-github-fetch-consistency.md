# GitHub fetch consistency + first-sync safeguard

## Why

Some end-to-end scenarios intermittently miss remote changes immediately after another machine syncs:

- **Scenario 11 (remote edit, local unchanged)** can report no-op on the first pull attempt, then succeed on the next sync.
- **Scenario 9 (first sync, both sides populated, no remote snapshot)** can occasionally build an incomplete first baseline if the remote view is briefly stale.

These are both "read-after-write visibility" problems around fetch-time remote reads. The result is flaky behavior and, in the first-sync case, potential baseline drift.

## What changes

### 1) Commit-pinned remote reads in `GitHubProvider.fetch()`

`fetch()` already starts by loading `branches/main` and storing `headSha`.

Use that exact SHA as the read ref for all subsequent read operations in the same fetch pass:

- `.stash/snapshot.json` read: `GET /contents/.stash/snapshot.json?ref=<headSha>`
- GraphQL blob reads: `object(expression: "<headSha>:<path>")`
- Raw byte reads: `GET /contents/<path>?ref=<headSha>`
- Tree reads remain commit-pinned via `baseTreeSha` from the same branch response

This guarantees one coherent remote snapshot per fetch pass (no mixed commit views inside a single fetch).

### 2) Empty-fetch head revalidation (targeted)

Add a targeted revalidation path before returning an empty `ChangeSet`:

- If computed `added`, `modified`, and `deleted` are all empty, do one short delayed **head revalidation**:
  - re-read `branches/main` once
  - if head SHA is unchanged, return empty
  - if head SHA changed, rerun fetch logic once pinned to the new head SHA

This avoids doubling normal no-op sync cost. Most no-op syncs add at most one extra branch read; a full second fetch pass only happens when head moved between reads.

### 3) First-sync safeguard for baseline creation

When local snapshot is empty (initial baseline path), treat an empty remote fetch as unconfirmed until one extra confirmation pass completes.

Specifically for the first-sync/no-remote-snapshot branch:

- if tree listing at the chosen head is empty, run one delayed fresh-head confirmation pass before accepting "remote empty"
- only after confirmation may stash finalize and push the first baseline snapshot

Goal: avoid writing/pushing a first `.stash/snapshot.json` baseline from a transiently stale remote view.

This does not change merge semantics. It only prevents false "remote is empty/unchanged" conclusions on first baseline establishment.

## Target updates

### `spec/github-provider.md`

1. Update fetch step details to explicitly pin all reads to the `headSha` captured at fetch start.
2. Add "empty-fetch head revalidation" behavior and API budget note:
   - at most one extra branch read on empty results
   - full second pass only when head changed (or first-sync empty-tree confirmation case)
3. Clarify that first-sync no-snapshot path also participates in the recheck.

### `spec/stash.md`

1. Clarify first-baseline safety: empty remote detection is confirmed before baseline snapshot is finalized.
2. State that this is a fetch consistency safeguard, not a merge-table change.

### `spec/tests.md`

1. Add a scenario note for eventual consistency hardening expectations:
   - single sync should reliably observe immediately preceding remote sync commits
   - first-sync baseline should not omit existing remote files due to transient stale reads

## Tests

### Unit tests (`github-provider.test.ts`)

1. `fetch` pins snapshot/GraphQL/raw reads to `headSha` (not `main`).
2. Empty fetch with unchanged head returns empty without full second fetch pass.
3. Empty fetch where head changes triggers one rerun and returns the rerun `ChangeSet`.
4. First-sync/no-remote-snapshot path: stale-empty tree on first pass, populated tree on confirmation pass -> returns added remote files.

### Integration tests (`stash-sync.test.ts` with Fake/Mock provider)

5. First baseline with local files + transient empty remote fetch on first attempt should not finalize incomplete baseline.
6. Second fetch pass finding remote files produces merged first baseline covering both sides.

### E2E tests

No new long-running timing tests required beyond existing scenarios; the target is to make existing Scenario 9 and Scenario 11 stable under normal CI timing variance.
