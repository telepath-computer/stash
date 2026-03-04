# Better commits

## Why

Stash commits all show up as `"stash: sync"` with no indication of who made them. When multiple people sync to the same repo, or when stash commits are interleaved with normal git commits, there's no way to tell which machine or person triggered each sync. The commit author defaults to whatever GitHub infers from the API token, which is correct but the commit message itself carries no identity.

This changeset fetches the GitHub user's profile during `stash setup github` and uses it to produce more informative commits.

## Behavior

### Setup: fetch and cache user profile

During `stash setup github`, after the token is validated, fetch the authenticated user's profile via `GET /user`. Cache the `login` and `name` fields in global config alongside the token:

```json
{
  "github": {
    "token": "ghp_...",
    "login": "rupert",
    "name": "Rupert"
  }
}
```

`login` is always present. `name` may be null (not all GitHub users set a display name) — omit it from config if null.

This is a single API call that only happens once during setup. No runtime cost to sync.

### Commit message

Change the commit message from:

```
stash: sync
```

to:

```
stash: sync by rupert
```

Uses the `login` field from global config. If `login` is not present in config (e.g., user set up before this change), fall back to `"stash: sync"`.

### Commit author

Set the `author` field on the commit to the GitHub user's identity:

```json
{
  "message": "stash: sync by rupert",
  "tree": "...",
  "parents": ["..."],
  "author": {
    "name": "Rupert",
    "email": "rupert@users.noreply.github.com"
  }
}
```

- `name`: use `name` from config if available, otherwise fall back to `login`.
- `email`: use `{login}@users.noreply.github.com` (GitHub's standard noreply address, ensures the commit links to the user's profile on GitHub).

If `login` is not in config, omit `author` entirely (GitHub API defaults to the token owner, which is the same person — just without the explicit attribution).

## Implementation

### Global config shape

Add `login` and `name` (optional) to the github section of global config. These are not setup fields that the user provides — they're fetched automatically after the token is accepted.

The `GlobalConfig` type (`Record<string, Record<string, string>>`) already accommodates this — `login` and `name` are just additional string entries under `"github"`.

### `stash setup github` flow

After collecting the token (existing logic), add:

1. Call `GET /user` with the token via `Authorization: token ghp_...`
2. On success: store `login` and (if present) `name` in global config
3. On failure (bad token, network error): the setup still succeeds (token is saved), but `login`/`name` are not cached. Print a warning: `warning: could not fetch GitHub profile — commits will not include your username`

This keeps setup resilient — a network blip shouldn't block saving a valid token.

### GitHubProvider changes

`GitHubConfig` gains optional fields:

```ts
export interface GitHubConfig {
  token: string;
  repo: string;
  login?: string;
  name?: string;
}
```

In `push()`, when creating the commit (step 3):

```ts
const commitBody: Record<string, unknown> = {
  message: this.login ? `stash: sync by ${this.login}` : "stash: sync",
  tree: treeSha,
};
if (this.headSha) {
  commitBody.parents = [this.headSha];
}
if (this.login) {
  commitBody.author = {
    name: this.displayName || this.login,
    email: `${this.login}@users.noreply.github.com`,
  };
}
```

`this.login` and `this.displayName` are set from constructor config.

### Config passing

The CLI already merges setup config + connect config when constructing the provider. Global config has `{ token, login, name }`, connect config has `{ repo }`. These are spread together and passed to the `GitHubProvider` constructor. No changes needed to the config plumbing — the provider already receives `Record<string, string>`.

### Fetching user profile

Add a small helper in `cli.ts` (or a util) for the setup-time API call:

```ts
async function fetchGitHubUser(token: string): Promise<{ login: string; name?: string } | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `token ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { login: data.login, name: data.name || undefined };
}
```

This lives in the CLI layer, not in the provider — it's a setup concern, not a sync concern.

## Targets

### `spec/github-provider.md`

1. **Update `GitHubConfig`** to include optional `login` and `name` fields.
2. **Update `push()` step 3** — commit message uses login, author field set from config.
3. **Update walkthrough** — commit creation example shows new message and author.

### `spec/cli.md`

1. **Update `stash setup` flow** — after collecting token, fetch user profile and cache in global config.
2. **Update global config shape** — show `login` and `name` alongside token.

### `code/src/providers/github-provider.ts`

1. **Update `GitHubConfig` interface** — add optional `login` and `name`.
2. **Update `push()`** — use `login` in commit message and `author` field.

### `code/src/cli.ts`

1. **Add `fetchGitHubUser()`** helper.
2. **Update `runSetup()`** — call `fetchGitHubUser()` after collecting token, merge result into global config.

## Tests

### Unit tests

```
1. Commit message includes login when available
   - GitHubProvider with login: "rupert"
   - push() → verify POST /git/commits body has message "stash: sync by rupert"

2. Commit author set when login available
   - GitHubProvider with login: "rupert", name: "Rupert"
   - push() → verify author: { name: "Rupert", email: "rupert@users.noreply.github.com" }

3. Commit author uses login as name when name not set
   - GitHubProvider with login: "rupert", no name
   - push() → verify author: { name: "rupert", email: "rupert@users.noreply.github.com" }

4. Fallback when no login in config
   - GitHubProvider with no login
   - push() → verify message is "stash: sync", no author field

5. fetchGitHubUser success
   - Mock GET /user → { login: "rupert", name: "Rupert" }
   - Returns { login: "rupert", name: "Rupert" }

6. fetchGitHubUser with null name
   - Mock GET /user → { login: "rupert", name: null }
   - Returns { login: "rupert" } (no name key)

7. fetchGitHubUser failure
   - Mock GET /user → 401
   - Returns null
```
