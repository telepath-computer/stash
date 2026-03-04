# Validate repo accessibility and surface accurate push errors

## Why

Two GitHub API responses are being misinterpreted:

**1. Branch 404 treated as empty repo.** When `GitHubProvider.fetch()` calls `GET /repos/{owner}/{repo}/branches/main` and gets a 404, it assumes the repo is empty and returns an empty changeset. But GitHub also returns 404 when the token lacks permission to see the repo (especially fine-grained PATs without `Contents: Read`). The result: sync silently reports "up to date" while pulling nothing.

**2. Any ref update 422 treated as push conflict.** `push()` treats any 422 on `PATCH /git/refs/heads/main` as a `PushConflictError` ("Remote main moved during push") and retries. But 422 can also mean repository rulesets blocking the update, insufficient permissions, or invalid objects. These are not transient — retrying wastes all 5 attempts and surfaces a misleading error.

Hit in practice: a new user's push was blocked by a repository ruleset. Stash reported "Remote main moved during push" after exhausting retries, when the actual cause was a branch update rule that their account couldn't bypass.

## Behavior

Before checking the branch, `fetch()` makes a lightweight `GET /repos/{owner}/{repo}` call. Both requests fire in parallel so there is no added latency.

| Repo endpoint | Branch endpoint | Meaning |
|---|---|---|
| 200 | 200 | Normal repo with main branch |
| 200 | 404 | Empty repo (no main branch yet) — proceed as before |
| 404 | 404 | Token can't see the repo — throw |

If the repo endpoint returns 404, throw an error:

```
Cannot access repository {owner}/{repo}. Check that the repo exists and your token has Contents: Read permission.
```

## Targets

### `code/src/providers/github-provider.ts`

**In `fetch()`**, fire `GET /repos/{owner}/{repo}` and `GET /branches/main` in parallel:

```typescript
const [repoRes, branchRes] = await Promise.all([
  this.rest("GET", this.repoPath("")),
  this.rest("GET", this.repoPath("/branches/main")),
]);
if (repoRes.status === 404) {
  throw new Error(
    `Cannot access repository ${this.owner}/${this.name}. Check that the repo exists and your token has Contents: Read permission.`
  );
}
await this.ensureOk(repoRes, "Failed to check repository access");
// use branchRes as before
```

The existing branch 404 handling is unchanged — it now only triggers for genuinely empty repos.

**In `push()`**, replace the blanket 422 → PushConflictError with response-body-aware handling:

```typescript
if (refRes.status === 422) {
  const body = await refRes.json();
  const message = body.message ?? "";
  if (message === "Update is not a fast forward") {
    throw new PushConflictError("Remote main moved during push");
  }
  throw new Error(`Push failed: ${message}`);
}
```

Only `"Update is not a fast forward"` is a genuine push conflict (retryable). All other 422s — rulesets, permissions, invalid objects — throw a non-retryable error with the actual GitHub message.

All error messages originate within `GitHubProvider`. The provider boundary owns all git/GitHub-specific language. `Stash` and the CLI just propagate `error.message` without adding git terminology.

### `spec/stash.md`

1. In the `GitHubProvider.fetch(localSnapshot)` section, add a note: fetch first verifies the repo is accessible. If the repo returns 404, sync fails with a clear error rather than silently returning no changes.
2. In the `push()` section, note that only fast-forward failures are retried as push conflicts. Other 422 errors (rulesets, permissions) are surfaced directly.

## Tests

### E2E test (`code/tests/e2e/stash-github-scenarios.e2e.test.ts`)

```
scenario: sync fails with clear error when token cannot access repo
  - Create a GitHubProvider with a valid token but a repo name that doesn't exist
    (e.g. "telepath-computer/this-repo-does-not-exist-{random}")
  - Call fetch()
  - Expect it to throw with message matching /Cannot access repository/
  - Confirm it does NOT silently return an empty changeset
```

### Unit test (`code/tests/unit/github-provider.test.ts`)

If a unit-level test with a mock/fake HTTP layer exists or is practical:

```
1. fetch: repo 404 throws access error
   - Mock GET /repos/{owner}/{repo} → 404
   - fetch() throws "Cannot access repository"

2. fetch: repo 200, branch 404 returns empty changeset (existing behavior preserved)
   - Mock GET /repos/{owner}/{repo} → 200
   - Mock GET /branches/main → 404
   - fetch() returns empty added/modified/deleted

3. fetch: repo 200, branch 200 proceeds normally (existing behavior preserved)
   - Mock both → 200
   - fetch() returns expected changeset

4. push: 422 "Update is not a fast forward" throws PushConflictError (retryable)
   - Mock PATCH /git/refs/heads/main → 422, body: { message: "Update is not a fast forward" }
   - push() throws PushConflictError

5. push: 422 with other message throws non-retryable Error
   - Mock ref update → 422, body: { message: "Required status check is expected" }
   - push() throws Error (not PushConflictError)
   - Error message: "Push failed: Required status check is expected"

6. push: 422 "Object does not exist" throws non-retryable Error
   - Mock ref update → 422, body: { message: "Object does not exist" }
   - push() throws Error (not PushConflictError)
   - Error message: "Push failed: Object does not exist"
```
