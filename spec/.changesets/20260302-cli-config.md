# CLI, Terminology + Config

## Why

The original spec models the relationship between a stash and its backend as a "remote" — borrowing git terminology (`stash remote set github:user/repo`). But stash isn't git. There are no branches, no refs, no push/pull distinction. The relationship is simpler: a stash is *connected* to a provider that syncs its files.

The `scheme:address` format (`github:user/repo`) and `ProviderRegistry` that parses it are over-engineered for what we need. Each provider has different config requirements (GitHub needs a token + repo, a future p2p provider might need a peer address + port). A generic string format can't express this well.

## What changes

**"Remote" becomes "connection"** throughout the spec. CLI commands change from `stash remote set` to `stash connect` / `stash disconnect`. The `scheme:address` format and `ProviderRegistry` are removed.

**Providers declare their requirements** via a static `ProviderSpec` with typed fields for both setup (global, e.g. auth token) and connect (per-stash, e.g. repo). The CLI reads these specs to know what to prompt for — fully generic across providers.

**Config is split into two layers** with clear ownership. CLI owns global config (`~/.stash/config.json`) for provider setup data like auth tokens. Stash owns per-stash config (`.stash/config.local.json`) for connection data. CLI passes global config into `Stash.load()`, Stash merges with local config on demand via `get config()`.

**`.stash/` directory layout changes.** `config.json` becomes `config.local.json`. Snapshot storage splits into `snapshot.json` (hashes, pushed to remote) and `snapshot.local/` (text content for merge, local only). Binary `.hash` files are removed — `snapshot.json` covers all files.

Driven by decisions 7, 8 in decisions.md.

## Target: spec/main.md

### 1. Terminology: "remote" → "connection"

Replace "remote" with "connection" throughout the entire spec:
- "configured remote" → "configured connection"
- "no remote configured" → "no connection configured"
- "backed by github:user/notes" → "connected to GitHub repo user/notes"
- "talk to a specific remote" → "talk to a specific connection"
- `stash.remote` → `stash.connections`
- `Remote is available via stash.remote` → `Connections available via stash.connections`
- Walkthrough example references updated accordingly.

### 2. CLI commands

#### Remove
- `stash remote set <provider:path>`
- `stash remote`
- The `scheme:address` format (e.g. `github:user/repo`) and `ProviderRegistry` that maps scheme prefixes.

#### Add

**`stash setup <provider>`** — configures global provider settings (e.g. auth token). Accepts `--field value` flags or prompts interactively. Writes to global config.

Example: `stash setup github --token ghp_...` or `stash setup github` (prompts).

**`stash connect <provider>`** — connects this stash to a provider. Accepts `--field value` flags or prompts interactively. If setup has not been done, prompts for setup fields too. Internally calls `stash.connect(provider, fields)`.

Example: `stash connect github --repo user/repo` or `stash connect github` (prompts).

One connection per stash per provider. Stored as a map keyed by provider name (supports multiple providers in future).

**`stash disconnect <provider>`** — removes the connection. Internally calls `stash.disconnect(provider)`.

#### Update
- `stash sync`: "No connection configured" instead of "no remote configured". Still a no-op.
- `stash status`: show connection info instead of remote info.

### 3. `.stash/` directory layout

Replace current layout:

```
.stash/
├── config.local.json          # connections config (local only, never pushed)
├── snapshot.json              # hashes + modified (also pushed to remote)
└── snapshot.local/            # text content for three-way merge (local only)
    ├── notes/todo.md
    └── README.md
```

- `config.local.json`: per-stash connections. Convention: `*.local.*` and `*.local/` never pushed to remote.
- `snapshot.json`: see sync changeset.
- `snapshot.local/`: text file content for merge base. Replaces old `snapshot/` which mixed text content and binary `.hash` files.
- Binary `.hash` files removed — `snapshot.json` tracks hashes for all files.

### 4. Config

Add a new top-level section to main.md (after Architecture, before Sync Walkthrough).

#### Overview

Config is split into two layers with clear ownership:

- **Global config** — CLI-owned. Provider setup data (auth tokens, API keys) that spans all stashes.
- **Per-stash config** — Stash-owned. Connection data specific to this stash. Lives inside `.stash/`.

Neither layer knows how the other is stored or managed. They meet at `Stash.load(dir, globalConfig)` — CLI passes global config in, Stash merges with local config internally.

#### Global config

Location: `~/.stash/config.json`. Respects `$XDG_CONFIG_HOME` if set (`$XDG_CONFIG_HOME/stash/config.json`). Directory (`~/.stash/`) allows room for future global state (cache, logs).

Managed by CLI via `readGlobalConfig()` / `writeGlobalConfig()` utility functions. Written by `stash setup <provider>`.

Shape — keyed by provider name, each provider owns its section:
```json
{
  "github": {
    "token": "ghp_..."
  }
}
```

Fields defined by the provider's `ProviderSpec.setup`.

#### Per-stash config

Location: `.stash/config.local.json`. Never pushed to remote.

Managed by Stash via `connect()` / `disconnect()` methods. Written by `stash connect <provider>`.

Shape — `connections` map keyed by provider name:
```json
{
  "connections": {
    "github": {
      "repo": "user/repo"
    }
  }
}
```

Fields defined by the provider's `ProviderSpec.connect`.

#### How CLI instantiates Stash

CLI reads global config from disk and passes it in. Stash never reads global config itself.

```ts
const globalConfig = readGlobalConfig()
const stash = await Stash.load(dir, globalConfig)
```

#### How Stash manages config

Stash holds `globalConfig` in memory (received at load time, never changes).

`get config()` reads `.stash/config.local.json` from disk each time and merges with `globalConfig`. No caching — the file is tiny, reads are free, and this guarantees config is always fresh after `connect()` / `disconnect()` writes.

```ts
class Stash {
  private globalConfig: GlobalConfig

  get config() {
    const local = readJson(".stash/config.local.json")
    return merge(this.globalConfig, local)
  }

  connect(provider, fields) {
    // write to .stash/config.local.json
    // next config read automatically picks it up
  }
}
```

#### Provider construction

When a provider is needed (e.g. during `sync()`):

1. Read `this.config` (merges global + local)
2. Look up provider class from registry by name
3. Pass merged config to provider constructor

```ts
const provider = new GitHubProvider(this.config.connections["github"])
// { token: "ghp_...", repo: "user/repo" }
```

Provider receives a flat config object. It never reads or writes config files.

#### CLI flow for `stash setup`

1. Look up provider class from registry
2. Read `ProviderSpec.setup` fields
3. For each field: use `--field value` flag if provided, otherwise prompt interactively (masked if `secret: true`)
4. Write to global config under provider name

#### CLI flow for `stash connect`

1. Look up provider class from registry
2. Check global config for setup fields — if missing, prompt for them first (and write to global config)
3. Read `ProviderSpec.connect` fields
4. For each field: use `--field value` flag if provided, otherwise prompt interactively
5. Call `stash.connect(providerName, fields)` — Stash writes to `.stash/config.local.json`

### 5. Provider spec + registry

Add `ProviderSpec` and `Field` types:

```ts
interface ProviderSpec {
  setup: Field[]      // global, one-time (e.g. token)
  connect: Field[]    // per-stash (e.g. repo)
}

interface Field {
  name: string
  label: string
  secret?: boolean    // masks input in prompts
}
```

Providers declare spec as a static property:

```ts
class GitHubProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [{ name: "token", label: "Personal access token", secret: true }],
    connect: [{ name: "repo", label: "Repository (user/repo)" }]
  }

  constructor(config: { token: string, repo: string }) { ... }
}
```

Provider registry is a simple name→class map:

```ts
const providers = { github: GitHubProvider }
```

### 6. Stash class

Replace:
- `readonly remote: string | null` → `readonly connections: Record<string, ConnectionConfig>`
- `setRemote(remote: string)` → `connect(provider: string, fields: Record<string, string>)`
- Add `disconnect(provider: string)`
- Constructor: `Stash.load(dir, globalConfig)` and `Stash.init(dir, globalConfig)`
