# 2026-03-03: In-Flight Sync Drift Handling (Retroactive)

## Summary

This change set documents and formalizes a race condition in `sync()` where local edits made during an in-flight sync could be overwritten.

The fix introduces bounded restart behavior for drift detection at two points in the sync pipeline:

1. After scan/reconcile but before remote push (pre-push drift window)
2. After remote push but before local apply (post-push drift window)

## Problem

Local state was scanned once and then reused through reconcile/push/apply. If files changed while sync was running, stale mutations could be applied and overwrite newer local edits.

## Solution

- Added shared retry bound of `3` attempts for restart-worthy races.
- Added pre-push drift check:
  - If local files drift from the scanned state, restart sync cycle.
- Added pre-apply drift check:
  - If local files drift before local writes, restart sync cycle.
- Added terminal failure contract:
  - When retry bound is exceeded, throw and stop failed cycle.
  - Do not continue with apply/save in terminal failed attempt.

## Tests Added/Updated

Integration (`code/tests/integration/stash-sync.test.ts`):

- `sync: preserves local edits made after scan but before push (pre-push race window)`
- `sync: preserves local edits made after push but before apply (post-push race window)`
- `sync: drift retries are bounded and failed cycle does not apply/save`

These tests verify:

- Latest local in-flight edit is preserved
- Remote edit is preserved
- Drift retry loop is bounded to exactly 3 attempts
- Terminal failure does not proceed to apply/save

## Spec Updates

- `spec/stash.md`
  - Added explicit retry bound (`3`) and failure contract.
  - Updated `sync()` flow to include pre-push and pre-apply drift checks with restarts.
  - Clarified snapshot guarantee: snapshot reflects synchronized cycle state; later disk edits are picked up next sync.
  - Added integration test requirements for race windows and bounded drift retries.

- `spec/tests.md`
  - Added race scenarios:
    - `32. Preserve local edits made after scan but before push`
    - `33. Preserve local edits made after push but before apply`
  - Added bounded retry scenarios:
    - `34. Push conflict retries are bounded`
    - `35. Drift-restart retries are bounded`

- `spec/cli.md`
  - Added retry-ownership policy:
    - `sync()` owns retries/restarts.
    - `watch` only schedules the next `sync()` via debounce/poll.

## Additional Notes

- This change set folds in the analysis from `SYNC_RACE_BRIEF.md`.
- The behavior remains eventually consistent for edits that occur immediately after a completed sync cycle.
