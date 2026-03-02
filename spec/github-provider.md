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
class GitHubProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [{ name: "token", label: "Personal access token", secret: true }],
    connect: [{ name: "repo", label: "Repository (user/repo)" }]
  }

  constructor(config: { token: string, repo: string }) { ... }
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
    "photo.jpg": { "hash": "sha256-of-photo", "modified": "2026-03-01T10:00:00Z" }
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
      "content": "{\"hello.md\":{\"hash\":\"sha256-of-hello-brave-world!\"},\"new.md\":{\"hash\":\"sha256-of-draft\"},\"photo.jpg\":{\"hash\":\"sha256-of-photo\",\"modified\":\"2026-03-01T10:00:00Z\"}}" }
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
