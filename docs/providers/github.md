# GitHub Provider

The GitHub provider implements the remote side of the Stash provider contract using the GitHub API directly. It does not clone repositories locally.

## Remote Model

- One GitHub repository is the remote for one stash connection.
- All user files map directly to repository paths on `main`.
- `.stash/snapshot.json` is stored remotely alongside user files.
- Other `.stash/` files remain local-only.
- Each push creates one commit on `main`.

## Configuration

The provider uses:

```ts
type GitHubConfig = {
  token: string;
  repo: string;
};
```

- `token` comes from global config written by `stash setup github`
- `repo` comes from per-stash config written by `stash connect github --repo owner/repo`

## Authentication

- REST requests use `Authorization: token ...`
- GraphQL requests use `Authorization: bearer ...`
- Invalid credentials surface as descriptive errors

## `fetch(localSnapshot)`

`fetch()` returns a `ChangeSet` describing what changed remotely since the local snapshot.

High-level flow:

1. Load `main` branch metadata and store the current commit SHA and tree SHA.
2. Attempt to fetch `.stash/snapshot.json`.
3. If the remote snapshot exists, diff it against the local snapshot.
4. If the remote snapshot does not exist, load the full remote tree and treat remote files as added.
5. For changed text candidates, batch-fetch content through GraphQL.
6. For binary files, rely on snapshot metadata and fetch raw bytes only when needed for classification.

Important rules:

- Empty repo (`main` missing) returns an empty `ChangeSet`.
- `.stash/` paths are excluded from tree-based discovery.
- Binary detection must agree with local scanning so files do not ping-pong across syncs.

## `get(path)`

`get()` streams one binary file from GitHub using the Contents API with the raw media type.

It is only used when reconcile determines that the remote side won for a binary file and local disk needs those bytes.

## `push(payload)`

`push()` writes the remote side of a sync cycle.

High-level flow:

1. Bootstrap an empty repo by creating `.stash/snapshot.json` if `main` does not exist yet.
2. Create blobs for binary writes.
3. Create a tree using the stored base tree SHA.
4. Create a commit with message `stash: sync`.
5. Move `refs/heads/main` without force.

Important rules:

- `.stash/snapshot.json` is always included in the pushed tree.
- Text files are inlined in the tree request.
- Binary files are uploaded as blobs first.
- Deletions are represented with `sha: null` tree entries.
- If the main ref moved since `fetch()`, the provider throws `PushConflictError`.

## Error Model

- ref moved during push -> `PushConflictError`
- GitHub rate limit exceeded -> descriptive error with reset time when available
- auth failure -> descriptive error
- other network and API failures bubble up to the caller

Retry policy belongs to `Stash`, not the provider.
