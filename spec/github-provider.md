# GitHub Provider

Implementation of the `Provider` interface for GitHub. Uses a single GitHub repository as the remote store. All operations go through the GitHub API — no local git clone.

---

## Storage

All stash files live on the `main` branch. Stash file paths map directly to repository paths — `notes/todo.md` in the stash is `notes/todo.md` in the repo. No path translation, no namespacing.

`.stash/snapshot.json` is stored in the repo alongside user files. It is the only `.stash/` file on the remote. Convention from main.md: `*.local.*` and `*.local/` are never pushed.

Each `push()` creates exactly one commit. No branches, no PRs, no tags.

## Auth

Requires a GitHub personal access token with `repo` scope. Provided via `stash setup github --token ghp_...` and stored in global config. The provider receives it in its constructor config — it never reads config files.

REST base URL: `https://api.github.com`. Auth header: `Authorization: token ghp_...`.

GraphQL endpoint: `https://api.github.com/graphql`. Auth header: `Authorization: bearer ghp_...`.

```ts
interface GitHubConfig {
  token: string
  repo: string
}

class GitHubProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [{ name: "token", label: "Personal access token", secret: true }],
    connect: [{ name: "repo", label: "Repository (user/repo)" }]
  }

  constructor(config: GitHubConfig) { ... }
}
```

## Internal state

The provider is constructed once per `sync()` call. It holds mutable state that lives for one fetch/push cycle:

- `headSha`: the SHA of `refs/heads/main` at the time of `fetch()`. Used as the parent commit in `push()` and for conflict detection.
- `baseTreeSha`: the tree SHA of the HEAD commit. Used as the base tree when creating new trees in `push()`.

Both are set during `fetch()` and consumed by `push()`. If sync is interrupted, the provider instance is discarded — no cleanup needed.

---

## fetch()

```ts
fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet>
```

Returns a `ChangeSet` of what changed on the remote since last sync. Optimized to minimize API calls — fetches one manifest file, then only downloads content for files that actually differ.

### Steps

1. **Get branch info** — REST: `GET /repos/{owner}/{repo}/branches/main`. Returns both the commit SHA and tree SHA in one call. Store `commit.sha` as `headSha` and `commit.commit.tree.sha` as `baseTreeSha`. If the branch doesn't exist (empty repo, no commits), return an empty ChangeSet.

2. **Fetch remote snapshot.json** — REST: `GET /repos/{owner}/{repo}/contents/.stash/snapshot.json?ref=main`. Response is JSON with base64-encoded `content` field. Decode base64, then parse into `Record<string, SnapshotEntry>`.

   If 404 (file doesn't exist): this is a first connect to a populated repo or the repo was initialized outside of stash. Fall through to step 3 with no remote snapshot.

3. **Diff snapshots** — compare remote snapshot against `localSnapshot`:

   - In remote but not in `localSnapshot` → `added`
   - In both but hashes differ → `modified`
   - In `localSnapshot` but not in remote → `deleted`

   If `localSnapshot` is undefined (first sync): all remote entries are `added`.

   If there is no remote snapshot (step 2 returned 404): fetch the full repo tree via `GET /repos/{owner}/{repo}/git/trees/{baseTreeSha}?recursive=1` to discover all file paths, then treat all files as `added`.

4. **Fetch changed text content** — for files classified as `added` or `modified`, only text files need content downloaded. Binary files already have hash and modified from the remote snapshot.

   Use GraphQL to batch-fetch text content in a single request:

   ```graphql
   query {
     repository(owner: "user", name: "repo") {
       f0: object(expression: "main:hello.md") {
         ... on Blob { text isBinary }
       }
       f1: object(expression: "main:notes/todo.md") {
         ... on Blob { text isBinary }
       }
     }
   }
   ```

5. **Classify text vs binary** — for each fetched blob:

   - `isBinary` is true → binary. No further check needed.
   - `isBinary` is false → call `isValidText(content)` to verify valid UTF-8. If valid, text. If invalid (edge case: Latin-1 with no null bytes), binary.

   ```ts
   isValidText(content: Buffer): boolean
   ```

   Checks whether raw bytes are valid UTF-8. Shared between `scan()` (local files) and `fetch()` (remote files where GitHub said `isBinary: false`). Both paths must agree on what is text vs binary — if they diverge, snapshot hashes won't match and files will ping-pong on every sync.

   GitHub's `isBinary` uses null-byte detection. main.md defines binary as "not valid UTF-8". The two-step approach satisfies both: GitHub filters obvious binaries cheaply, `isValidText()` catches edge cases.

6. **Build ChangeSet** — assemble `added`, `modified`, and `deleted` from steps 3-5 and return.

### API call budget

| Scenario | REST calls | GraphQL calls | Total |
|----------|-----------|---------------|-------|
| Normal sync, changes exist | 2 (branch + snapshot) | 1 (changed content) | 3 |
| Normal sync, no remote changes | 2 (branch + snapshot) | 0 | 2 |
| First sync / no remote snapshot | 2 (branch + tree listing) | 1 (all content) | 3 |
| Empty repo (no commits) | 1 (branch → 404) | 0 | 1 |

### No remote snapshot (first connect)

When `.stash/snapshot.json` doesn't exist on the remote, the provider cannot diff snapshots. Instead it fetches the full repo tree to discover all paths, then fetches all content via GraphQL. All files are returned as `added`.

Two cases:
- **Repo with files but no snapshot** — e.g. initialized with a README via GitHub UI. All remote files come down as `added`.
- **Empty repo** — no HEAD ref. `fetch()` returns an empty ChangeSet (step 1).

---

## get()

```ts
get(path: string): Promise<Readable>
```

Streams a single binary file from the remote. Called by `apply()` after reconcile, only for binary files where `source: "remote"`.

Use the Contents API with the `raw` media type: `GET /repos/{owner}/{repo}/contents/{path}?ref=main` with `Accept: application/vnd.github.raw+json`. Returns raw bytes directly — no base64 encoding, no JSON wrapping. Supports files up to 100 MB.

The `raw` media type is simpler and handles all file sizes in one code path. The default JSON response with base64 encoding only works up to 1 MB; the `raw` response works up to 100 MB with no size branching needed.

---

## push()

```ts
push(payload: PushPayload): Promise<void>
```

Creates a single commit on `main` with all file changes and the updated `snapshot.json`. Uses the Git Data API for atomic tree construction.

### Steps

1. **Create blobs** — for each binary file in `payload.files`, create a blob via `POST /repos/{owner}/{repo}/git/blobs` with base64-encoded content. Returns a SHA for each.

   Text files skip this step — their content is passed inline in step 2.

   Binary blob creations run in parallel.

2. **Create tree** — `POST /repos/{owner}/{repo}/git/trees` with `base_tree` set to `baseTreeSha` (stored during fetch). Tree entries:

   - **Text files**: `{ path, mode: "100644", type: "blob", content: "..." }` — inline.
   - **Binary files**: `{ path, mode: "100644", type: "blob", sha: "..." }` — reference blob SHA from step 1.
   - **snapshot.json**: `{ path: ".stash/snapshot.json", mode: "100644", type: "blob", content: JSON.stringify(payload.snapshot) }` — always inline.
   - **Deletions**: `{ path, mode: "100644", type: "blob", sha: null }` — null SHA removes the file.

   `base_tree` means unchanged files carry over. Only changed/added/deleted files need entries.

3. **Create commit** — `POST /repos/{owner}/{repo}/git/commits` with the new tree SHA, `headSha` as parent, and message `"stash: sync"`.

   Empty repo (first push): omit `parents`. Creates the initial commit.

4. **Update ref** — `PATCH /repos/{owner}/{repo}/git/refs/heads/main` with `force: false`. If `main` has moved since fetch, the API returns 422.

   On 422: throw `PushConflictError`. The provider does not retry.

   Empty repo (first push): ref doesn't exist yet. Use `POST /repos/{owner}/{repo}/git/refs` to create it.

### API call budget

| Scenario | Blob calls | Other calls | Total |
|----------|-----------|-------------|-------|
| Text-only sync | 0 | 3 (tree + commit + ref) | 3 |
| N binary files | N (parallel) | 3 (tree + commit + ref) | 3 + N |

File count does not affect call count for text files — all text content is inline in the tree creation call.

---

## Error handling

### PushConflictError

Thrown when the ref update fails because `main` has moved. Another machine synced between our `fetch()` and `push()`.

The provider throws immediately — no inspection, no resolution. Stash catches it and retries from `fetch()`, reusing the original local ChangeSet. Max 3 retries.

### Rate limiting

GitHub: 5,000 requests/hour (REST, authenticated), 5,000 points/hour (GraphQL). A typical sync uses 3-6 calls. Not a practical concern.

If a 403 response has `X-RateLimit-Remaining: 0`, throw a descriptive error with the reset time from `X-RateLimit-Reset`. No automatic retry.

### Network errors

Transient failures during fetch are safe — no state has been modified. Caller can retry the entire sync.

Transient failures during push before the ref update completes are safe — nothing has changed on `main`. If the ref update succeeds but the response is lost (unlikely), next sync self-heals: remote has moved forward, `fetch()` picks up the new state.

---

## Walkthrough

Same scenario as main.md. Machine A edited `hello.md`, added `new.md`, deleted `image.png`. Machine B edited `hello.md`, added `photo.jpg`.

### fetch()

**1. Get branch info**
```
GET /repos/user/notes/branches/main
→ { commit: { sha: "abc123", commit: { tree: { sha: "def456" } } } }
```

Store `headSha = "abc123"`, `baseTreeSha = "def456"`.

**2. Fetch snapshot.json**
```
GET /repos/user/notes/contents/.stash/snapshot.json?ref=main
→ {
    "hello.md": { "hash": "sha256-of-hello-world!" },
    "image.png": { "hash": "sha256-of-image" },
    "photo.jpg": { "hash": "sha256-of-photo", "modified": 1709290800000 }
  }
```

**3. Diff snapshots**

| File | Local snapshot | Remote snapshot | Result |
|------|---------------|-----------------|--------|
| `hello.md` | `sha256-of-hello-world` | `sha256-of-hello-world!` | `modified` |
| `image.png` | `sha256-of-image` | `sha256-of-image` | skip |
| `photo.jpg` | — | `sha256-of-photo` | `added` |

**4. Fetch changed content**
```graphql
query {
  repository(owner: "user", name: "notes") {
    f0: object(expression: "main:hello.md") {
      ... on Blob { text isBinary }
    }
  }
}
→ { f0: { text: "hello world!", isBinary: false } }
```

Only `hello.md` fetched. `photo.jpg` is binary — hash and modified already known from snapshot, content deferred to `get()`.

**5. Result**
```
ChangeSet = {
  added:    { "photo.jpg": { type: "binary", hash: "sha256-of-photo", modified: ... } },
  modified: { "hello.md":  { type: "text", content: "hello world!" } },
  deleted:  []
}
```

3 API calls total.

### push()

After reconcile: `hello.md` (merged text), `new.md` (new text), `image.png` (delete), plus computed snapshot.

**1. Create blobs** — no binary files to push. Skip.

**2. Create tree**
```
POST /repos/user/notes/git/trees
{
  "base_tree": "def456",
  "tree": [
    { "path": "hello.md", "mode": "100644", "type": "blob",
      "content": "hello brave world!" },
    { "path": "new.md", "mode": "100644", "type": "blob",
      "content": "draft" },
    { "path": "image.png", "mode": "100644", "type": "blob",
      "sha": null },
    { "path": ".stash/snapshot.json", "mode": "100644", "type": "blob",
      "content": "{\"hello.md\":{\"hash\":\"sha256-of-hello-brave-world!\"},\"new.md\":{\"hash\":\"sha256-of-draft\"},\"photo.jpg\":{\"hash\":\"sha256-of-photo\",\"modified\":1709290800000}}" }
  ]
}
→ { sha: "tree789" }
```

**3. Create commit**
```
POST /repos/user/notes/git/commits
{ "message": "stash: sync", "tree": "tree789", "parents": ["abc123"] }
→ { sha: "commit012" }
```

**4. Update ref**
```
PATCH /repos/user/notes/git/refs/heads/main
{ "sha": "commit012", "force": false }
→ 200 OK
```

3 API calls total.

### get()

`apply()` needs `photo.jpg` (binary, `source: "remote"`):

```
GET /repos/user/notes/contents/photo.jpg?ref=main
Accept: application/vnd.github.raw+json
→ <raw bytes>
```

Stream to disk.

---

## Known limitations

To address in future if they become practical concerns:

- **GraphQL query size**: the batch content query (step 4 of fetch) grows with the number of changed files. GitHub GraphQL has a query complexity budget. For very large ChangeSets, may need to split into multiple queries.
- **Recursive tree truncation**: `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` truncates at ~100,000 entries. Not a concern for typical stash sizes.
- **Inline content size in tree creation**: the `content` field in `POST /repos/{owner}/{repo}/git/trees` has undocumented size limits. Very large text files may need blob creation instead of inline.
- **Repo edited outside stash**: if someone pushes directly to the repo (not via stash sync), there's no `snapshot.json` update. Next sync sees stale remote snapshot — changes are invisible until snapshot is rebuilt. Consider detecting this via commit history or tree comparison.
- **`.stash/` filtering**: fetch() must exclude `.stash/` paths from the tree listing (step 3, no-snapshot case). Only `.stash/snapshot.json` is managed; other `.stash/` files should not appear in ChangeSets.

---

## Tests

Unit and integration tests for GitHubProvider. End-to-end tests are in `tests.md`.

### Test Helpers

#### MockGitHubAPI

A mock HTTP layer that intercepts `fetch()` calls to `api.github.com` and returns canned responses. Configured per-test with expected requests and responses.

```ts
class MockGitHubAPI {
  // Register expected request → response pairs
  on(method: string, path: string | RegExp, response: MockResponse): this

  // Register a handler that can inspect the request body
  onPost(path: string, handler: (body: any) => MockResponse): this

  // Install as global fetch mock, returns cleanup function
  install(): () => void

  // Assert all registered expectations were called
  assertDone(): void
}

interface MockResponse {
  status: number
  body: any
  headers?: Record<string, string>
}
```

Uses `node:test` mock API to intercept global `fetch`. Each test installs the mock in `beforeEach` and restores in `afterEach`.

For GraphQL: match on `POST /graphql` and inspect the query body to return the right response.

#### makeProvider()

Creates a `GitHubProvider` with a valid config. Shorthand for `new GitHubProvider({ token: "test-token", repo: "user/repo" })`.

### Unit Tests

#### fetch()

Each test configures `MockGitHubAPI` with the expected API calls and verifies the returned ChangeSet.

```
1. Normal sync — changes exist
   - Mock: GET branches/main → { commit: { sha, commit: { tree: { sha } } } }
   - Mock: GET contents/.stash/snapshot.json → base64-encoded snapshot with changed hashes
   - Mock: POST /graphql → text content for changed files
   - Call fetch(localSnapshot)
   - Verify ChangeSet has correct added/modified/deleted
   - Verify headSha and baseTreeSha stored internally

2. Normal sync — no remote changes
   - Remote snapshot hashes match localSnapshot exactly
   - No GraphQL call made
   - ChangeSet is empty (no added, modified, or deleted)

3. First sync — no localSnapshot
   - Call fetch(undefined)
   - All remote snapshot entries returned as added
   - GraphQL fetches all text content

4. No remote snapshot (404)
   - Mock: GET contents/.stash/snapshot.json → 404
   - Mock: GET git/trees/{sha}?recursive=1 → full tree listing
   - Mock: POST /graphql → all file contents
   - All files returned as added

5. Empty repo (no commits)
   - Mock: GET branches/main → 404
   - Returns empty ChangeSet
   - No further API calls

6. Classification — isBinary true
   - GraphQL returns blob with isBinary: true
   - FileState has type: "binary"

7. Classification — isBinary false, valid UTF-8
   - GraphQL returns blob with isBinary: false, content is valid UTF-8
   - FileState has type: "text" with content string

8. Classification — isBinary false, invalid UTF-8
   - GraphQL returns blob with isBinary: false, but content fails isValidText()
   - FileState has type: "binary" (edge case: Latin-1 with no null bytes)

9. Binary files — no content fetched
   - Remote snapshot has a binary entry (hash + modified)
   - Hash differs from localSnapshot → modified
   - File is NOT included in GraphQL query
   - ChangeSet entry has type: "binary" with hash and modified from snapshot

10. .stash/ paths filtered from tree listing
    - Tree listing includes .stash/snapshot.json and .stash/config.local.json
    - Only .stash/snapshot.json is excluded from the ChangeSet (it's managed separately)
    - Other .stash/ paths also excluded

11. Deleted files detected
    - localSnapshot has file "old.md"
    - Remote snapshot does not have "old.md"
    - ChangeSet.deleted includes "old.md"
```

#### get()

```
1. Streams binary file content
   - Mock: GET contents/{path}?ref=main with Accept: application/vnd.github.raw+json → raw bytes
   - Returned Readable produces the expected bytes

2. Correct auth header
   - Verify request includes Authorization: token ghp_...

3. Path encoding
   - Path with spaces or special characters is correctly URL-encoded
```

#### push()

Each test verifies the correct sequence of API calls and request bodies.

```
1. Text-only push
   - payload: two text files + snapshot, no deletions
   - No blob creation calls
   - POST git/trees: base_tree is baseTreeSha, tree entries have inline content for text files + snapshot.json
   - POST git/commits: tree SHA from previous, parents: [headSha]
   - PATCH git/refs/heads/main: new commit SHA, force: false
   - Verify request bodies match expected

2. Binary files — blob created first
   - payload: one binary file (stream factory)
   - POST git/blobs: base64-encoded content → returns SHA
   - POST git/trees: binary entry references blob SHA (not inline content)
   - Rest of flow same as test 1

3. Multiple binary files — parallel blob creation
   - payload: three binary files
   - All three POST git/blobs happen (order doesn't matter)
   - Tree references all three SHAs

4. Deletions
   - payload: one deletion
   - POST git/trees: entry with sha: null for deleted path

5. Mixed push — text + binary + deletions + snapshot
   - Verify all entry types appear correctly in the tree

6. PushConflictError on 422
   - Mock: PATCH git/refs/heads/main → 422
   - push() throws PushConflictError

7. First push — empty repo (no headSha)
   - POST git/commits: no parents field
   - POST git/refs (create ref, not PATCH)

8. Snapshot included in tree
   - Verify .stash/snapshot.json appears as inline content in tree entries
   - Content matches JSON.stringify(payload.snapshot)
```

#### Error handling

```
1. Rate limit — 403 with X-RateLimit-Remaining: 0
   - Mock any request → 403 with rate limit headers
   - Throws descriptive error including reset time from X-RateLimit-Reset

2. Auth error — 401
   - Mock any request → 401
   - Throws descriptive error about invalid token

3. Network error during fetch — no state modified
   - Mock: GET branches/main → network error
   - fetch() throws
   - Provider internal state (headSha, baseTreeSha) not set
```

### Integration Tests

Integration tests use `MockGitHubAPI` to test multi-step flows without real network access.

```
1. fetch() then push() — internal state flows correctly
   - Run fetch() (sets headSha, baseTreeSha)
   - Run push() with a payload
   - Verify push used headSha as parent and baseTreeSha as base_tree

2. Full fetch→push cycle with realistic data
   - Mock a complete set of API responses matching the walkthrough in the spec
   - fetch(localSnapshot) → ChangeSet
   - Externally build a PushPayload from the ChangeSet (simulating what Stash.sync would do)
   - push(payload) → verify all API calls match the walkthrough
```
