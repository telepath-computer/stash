# Plan: GitHub HTML Error Dump Cleanup

## Problem

When GitHub returns an HTTP error page, `stash` can surface the entire HTML response body to the user.

This has been observed during `stash watch`, where the terminal ends up showing a large HTML blob instead of a concise error such as `503 Service Unavailable`.

## Current Behavior

`watch()` is not the source of the noisy output. It catches sync failures and renders the thrown `error.message`.

The message is currently constructed inside `GitHubProvider`:

- `watch()` calls `stash.sync()`
- `stash.sync()` calls `provider.fetch()` and `provider.push()`
- GitHub requests eventually pass through `GitHubProvider.ensureOk()`
- `ensureOk()` reads `await response.text()` for non-OK responses
- it throws an error in the form `<operation message> (<status>): <full response body>`

That means any HTML error page returned by GitHub becomes part of the thrown error message and is later printed by `watch()`.

Existing special cases already handled before `ensureOk()`:

- rate-limited responses produce a dedicated rate-limit message with reset time
- `401` responses produce a dedicated authentication failure message

## Goal

For GitHub HTTP errors, prefer concise status-based errors and never dump raw HTML response bodies.

Examples:

- `Failed to fetch GraphQL blobs (503 Service Unavailable)`
- `Failed to create tree (404 Not Found)`
- `Failed to fetch raw content for notes/todo.md (500 Internal Server Error)`

If a response has no useful status text, the fallback should still be concise, e.g. `Failed to fetch GraphQL blobs (503)`.

Network failures that occur before an HTTP response exists are out of scope for this change and should continue to surface their original fetch error.

## Proposed Change

Keep the fix contained to `src/providers/github-provider.ts`.

Change `GitHubProvider.ensureOk()` so that for any non-OK response it:

- does not read or append `response.text()`
- formats the error using `response.status`
- includes `response.statusText` when present
- preserves the existing caller-supplied operation message

Expected shape:

- with status text: `<message> (<status> <statusText>)`
- without status text: `<message> (<status>)`

This leaves the existing higher-priority cases unchanged:

- rate limiting logic in `rest()` and the GraphQL fetch path
- authentication failure handling for `401`
- `PushConflictError` behavior for write conflicts

Because many GitHub operations already funnel through `ensureOk()`, this should improve errors across:

- branch loading
- snapshot fetches
- tree fetches
- GraphQL blob fetches
- raw file downloads
- blob/tree/commit/ref writes during push

## Affected Code

- `src/providers/github-provider.ts`
  - update `ensureOk()`
  - keep `rest()` and GraphQL-specific special cases intact unless needed for consistency
- `src/watch.ts`
  - no behavior change expected
  - included here only because this is the user-visible path where the bug was observed

## Test Plan

Add or update unit tests in `tests/unit/github-provider.test.ts`.

Coverage to include:

- non-OK REST response with plain `status` and `statusText` throws a concise status-based message
- non-OK GraphQL response with HTML body does not include body contents in the thrown error
- existing `401` auth error behavior remains unchanged
- existing rate-limit error behavior remains unchanged
- network failure with no response still surfaces the original fetch error

Useful assertions:

- thrown message matches the operation-specific prefix
- thrown message includes `503 Service Unavailable` (or other status/statusText pair)
- thrown message does not include HTML markers such as `<!DOCTYPE html>` or `<html`

## Implementation Notes

This should be a minimal, low-risk change because it only alters error formatting after a response is already known to be non-OK.

The main trade-off is that some potentially useful non-HTML error bodies will no longer be shown. That is acceptable for now because the immediate goal is to stop unreadable HTML dumps and standardize GitHub HTTP errors around concise status information.
