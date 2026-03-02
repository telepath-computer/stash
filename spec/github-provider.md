# GitHub Provider

Implementation of the `Provider` interface for GitHub. Uses a single GitHub repository as the remote store. All operations go through the GitHub API — no local git clone.

---

## Storage

All stash files live on the `main` branch. Stash file paths map directly to repository paths — `notes/todo.md` in the stash is `notes/todo.md` in the repo. No path translation, no namespacing.

`.stash/snapshot.json` is stored in the repo alongside user files. It is the only `.stash/` file on the remote. Convention from main.md: `*.local.*` and `*.local/` are never pushed.

Each `push()` creates exactly one commit. No branches, no PRs, no tags.

## Auth

Requires a GitHub personal access token with `repo` scope. Provided via `stash setup github --token ghp_...` and stored in global config. The provider receives it in its constructor config — it never reads config files.

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

1. **Get HEAD ref** — REST: `GET /repos/{owner}/{repo}/git/ref/heads/main`. Store the commit SHA as `headSha`. If the ref doesn't exist (empty repo, no commits), return an empty ChangeSet.

2. **Get HEAD commit tree** — REST: `GET /repos/{owner}/{repo}/git/commits/{headSha}`. Store the tree SHA as `baseTreeSha`.

3. **Fetch remote snapshot.json** — REST: `GET /repos/{owner}/{repo}/contents/.stash/snapshot.json?ref=main`. Parse JSON into `Record<string, SnapshotEntry>`.

   If 404 (file doesn't exist): this is a first connect to a populated repo or the repo was initialized outside of stash. Fall through to step 4 with no remote snapshot.

4. **Diff snapshots** — compare remote snapshot against `localSnapshot`:

   - In remote but not in `localSnapshot` → `added`
   - In both but hashes differ → `modified`
   - In `localSnapshot` but not in remote → `deleted`

   If `localSnapshot` is undefined (first sync): all remote entries are `added`.

   If there is no remote snapshot (step 3 returned 404): fetch the full repo tree via `GET /repos/{owner}/{repo}/git/trees/{baseTreeSha}?recursive=1` to discover all file paths, then treat all files as `added`.

5. **Fetch changed text content** — for files classified as `added` or `modified`, only text files need content downloaded. Binary files already have hash and modified from the remote snapshot.

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

6. **Classify text vs binary** — for each fetched blob:

   - `isBinary` is true → binary. Use hash and modified from remote snapshot.
   - `isBinary` is false → verify valid UTF-8. If valid, text (FileState with content). If invalid (edge case: Latin-1 with no null bytes), treat as binary.

   GitHub's `isBinary` uses null-byte detection. main.md defines binary as "not valid UTF-8". The two-step approach satisfies both: GitHub filters obvious binaries cheaply, our UTF-8 check catches edge cases.

7. **Build ChangeSet** — assemble `added`, `modified`, and `deleted` from steps 4-6 and return.

### API call budget

| Scenario | REST calls | GraphQL calls | Total |
|----------|-----------|---------------|-------|
| Normal sync, changes exist | 3 (ref + commit + snapshot) | 1 (changed content) | 4 |
| Normal sync, no remote changes | 3 (ref + commit + snapshot) | 0 | 3 |
| First sync / no remote snapshot | 3 (ref + commit + tree listing) | 1 (all content) | 4 |
| Empty repo (no commits) | 1 (ref → 404) | 0 | 1 |

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

REST: `GET /repos/{owner}/{repo}/contents/{path}?ref=main`. Returns base64-encoded content. Decode and return as a readable stream.

For files larger than 1 MB (GitHub Contents API limit), use the Blob API instead: fetch the file's blob SHA from the tree, then `GET /repos/{owner}/{repo}/git/blobs/{sha}`. Supports files up to 100 MB.

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

3. **Create commit** — `POST /repos/{owner}/{repo}/git/commits` with the new tree SHA and `headSha` as parent.

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

GitHub: 5,000 requests/hour (REST, authenticated), 5,000 points/hour (GraphQL). A typical sync uses 4-7 calls. Not a practical concern.

If a 403 response has `X-RateLimit-Remaining: 0`, throw a descriptive error with the reset time from `X-RateLimit-Reset`. No automatic retry.

### Network errors

Transient failures during fetch are safe — no state has been modified. Caller can retry the entire sync.

Transient failures during push before the ref update completes are safe — nothing has changed on `main`. If the ref update succeeds but the response is lost (unlikely), next sync self-heals: remote has moved forward, `fetch()` picks up the new state.

---

## Walkthrough

Same scenario as main.md. Machine A edited `hello.md`, added `new.md`, deleted `image.png`. Machine B edited `hello.md`, added `photo.jpg`.

### fetch()

**1. Get HEAD ref**
```
GET /repos/user/notes/git/ref/heads/main
→ { object: { sha: "abc123" } }
```

**2. Get commit tree**
```
GET /repos/user/notes/git/commits/abc123
→ { tree: { sha: "def456" } }
```

**3. Fetch snapshot.json**
```
GET /repos/user/notes/contents/.stash/snapshot.json?ref=main
→ {
    "hello.md": { "hash": "sha256-of-hello-world!" },
    "image.png": { "hash": "sha256-of-image" },
    "photo.jpg": { "hash": "sha256-of-photo", "modified": "2026-03-01T10:00:00Z" }
  }
```

**4. Diff snapshots**

| File | Local snapshot | Remote snapshot | Result |
|------|---------------|-----------------|--------|
| `hello.md` | `sha256-of-hello-world` | `sha256-of-hello-world!` | `modified` |
| `image.png` | `sha256-of-image` | `sha256-of-image` | skip |
| `photo.jpg` | — | `sha256-of-photo` | `added` |

**5. Fetch changed content**
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

**6. Result**
```
ChangeSet = {
  added:    { "photo.jpg": { type: "binary", hash: "sha256-of-photo", modified: ... } },
  modified: { "hello.md":  { type: "text", content: "hello world!" } },
  deleted:  []
}
```

4 API calls total.

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
{ "message": "stash sync", "tree": "tree789", "parents": ["abc123"] }
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
→ { content: "<base64>", encoding: "base64" }
```

Decode and stream to disk.
