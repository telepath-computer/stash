# API

This document describes the developer-facing API that Stash exports from `src/index.ts`.

The goal is to keep the surface area explicit and stable. If this contract changes, update this document deliberately.

## Package Exports

```ts
export { Stash } from "./stash.ts";
export type { StashEvents } from "./stash.ts";
export { GitHubProvider } from "./providers/github-provider.ts";
export { PushConflictError, SyncLockError } from "./errors.ts";
export type { Disposable } from "./emitter.ts";
export { getGlobalConfigPath, readGlobalConfig, writeGlobalConfig } from "./global-config.ts";
export type {
  ChangeSet,
  ConnectionConfig,
  Field,
  FileMutation,
  FileState,
  GlobalConfig,
  Provider,
  ProviderClass,
  ProviderSpec,
  PushPayload,
  SnapshotEntry,
  StatusResult,
} from "./types.ts";
```

## `Stash`

`Stash` is the main programmatic interface.

```ts
type StashEvents = {
  mutation: FileMutation;
};

class Stash extends Emitter<StashEvents> {
  static load(
    dir: string,
    globalConfig: GlobalConfig,
    options?: { providers?: Record<string, ProviderClass> },
  ): Promise<Stash>;

  static init(
    dir: string,
    globalConfig: GlobalConfig,
    options?: { providers?: Record<string, ProviderClass> },
  ): Promise<Stash>;

  get connections(): Record<string, ConnectionConfig>;
  get config(): Record<string, Record<string, string>>;

  connect(provider: string, fields: Record<string, string>): Promise<void>;
  disconnect(provider: string): Promise<void>;
  sync(): Promise<void>;
  status(): StatusResult;
}
```

## Events

`Stash` inherits its event API from `Emitter`.

```ts
type StashEvents = {
  mutation: FileMutation
}

stash.on("mutation", (mutation) => {
  // mutation is a FileMutation
}): Disposable
```

### `mutation`

Emitted as sync applies local disk mutations.

- The payload is always a `FileMutation`.
- The event is intended for UI, logging, and progress reporting.
- If a local write is skipped because of post-push drift protection, the emitted mutation reflects the actual disk action taken.

This is the event surface the CLI uses to render sync progress.

### `Stash.load()`

Loads an existing stash rooted at `dir`.

- Requires `.stash/` to already exist.
- Throws if the directory is not already a stash.
- Uses the provided `globalConfig` plus local `.stash/config.local.json`.
- The current error guidance points callers toward `stash connect <provider>`.

### `Stash.init()`

Ensures `.stash/` exists in `dir` and returns a loaded `Stash`.

- Creates `.stash/`
- Creates `.stash/snapshot.local/`
- Creates `.stash/config.local.json` if missing
- Does not remove or move user files
- Is safe to call repeatedly

### `connections`

Returns the per-stash provider connection config exactly as stored locally.

### `config`

Returns the merged provider config view:

- global provider config from `globalConfig.providers`
- overlaid with local per-stash connection config

This is useful for code that needs the effective provider configuration, not just the local portion.

### `connect(provider, fields)`

Stores connection config for a provider in `.stash/config.local.json`.

### `disconnect(provider)`

Removes connection config for a provider from `.stash/config.local.json`.

### `sync()`

Runs one full sync cycle.

Behavioral contract:

- no configured connections -> no-op
- one active sync at a time per `Stash` instance
- cross-process lock enforced through `.stash/sync.lock`
- may throw `SyncLockError`
- may throw `PushConflictError` only indirectly through retry exhaustion logic or provider failures
- emits `mutation` events as disk mutations are applied

See `docs/sync.md` and `docs/reconciliation.md` for the exact sync semantics.

### `status()`

Returns local status without network access:

```ts
interface StatusResult {
  added: string[];
  modified: string[];
  deleted: string[];
  lastSync: Date | null;
}
```

## Global Config Helpers

The package also exports helpers for reading and writing the global config file:

```ts
function getGlobalConfigPath(): string;
function readGlobalConfig(): Promise<GlobalConfig>;
function writeGlobalConfig(config: GlobalConfig): Promise<void>;
```

Behavior:

- `getGlobalConfigPath()` resolves to `$XDG_CONFIG_HOME/stash/config.json` when `XDG_CONFIG_HOME` is set
- otherwise it resolves to `~/.stash/config.json`
- `readGlobalConfig()` normalizes the structured config shape shown below

Global config shape:

```ts
interface GlobalConfig {
  providers: Record<string, Record<string, string>>;
  background: {
    stashes: string[];
  };
}
```

## Provider Contract

Providers are transport interfaces used by `Stash`.

```ts
interface Provider {
  fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet>;
  get(path: string): Promise<Readable>;
  push(payload: PushPayload): Promise<void>;
}
```

### `fetch(localSnapshot)`

Returns the remote-side `ChangeSet` relative to the local snapshot.

### `get(path)`

Returns a readable stream for a remote binary file when local apply needs the remote bytes.

### `push(payload)`

Writes remote changes for one sync cycle.

## Provider Declaration Types

```ts
interface ProviderSpec {
  setup: Field[];
  connect: Field[];
}

interface Field {
  name: string;
  label: string;
  secret?: boolean;
}

type ProviderClass = {
  spec: ProviderSpec;
  new (config: Record<string, string>): Provider;
};
```

Providers expose:

- setup fields used by `stash setup`
- connect fields used by `stash connect`
- a constructor that accepts the merged config object

## Built-In Provider

The package exports `GitHubProvider` as the built-in provider implementation.

Its static provider declaration is:

```ts
GitHubProvider.spec = {
  setup: [{ name: "token", label: "Personal access token", secret: true }],
  connect: [{ name: "repo", label: "Repository (user/repo)" }],
};
```

See `docs/providers/github.md` for its behavioral contract.

## Important Data Types

```ts
type SnapshotEntry = { hash: string } | { hash: string; modified: number };

type FileState =
  | { type: "text"; content: string }
  | { type: "binary"; hash: string; modified: number };

interface ChangeSet {
  added: Map<string, FileState>;
  modified: Map<string, FileState>;
  deleted: string[];
}

interface FileMutation {
  path: string;
  disk: "write" | "delete" | "skip";
  remote: "write" | "delete" | "skip";
  content?: string;
  source?: "local" | "remote";
  hash?: string;
  modified?: number;
}

interface PushPayload {
  files: Map<string, string | (() => Readable)>;
  deletions: string[];
  snapshot: Record<string, SnapshotEntry>;
}

```

## Error Types

The package exports:

```ts
class PushConflictError extends Error {}
class SyncLockError extends Error {}
```

- `SyncLockError` means a sync could not start because another sync is already active.
- `PushConflictError` represents a remote ref race detected by a provider push.

## Stability Notes

The most important developer-facing contracts are:

- `Stash`
- `StashEvents`
- `Provider`
- `ProviderSpec`
- `ChangeSet`
- `FileMutation`
- `SnapshotEntry`
- `StatusResult`

Changes to these should be treated as deliberate API changes, not incidental refactors.
