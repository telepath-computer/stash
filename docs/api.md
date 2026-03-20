# API

This document describes the developer-facing API that Stash exports from `src/index.ts`.

The goal is to keep the surface area explicit and stable. If this contract changes, update this document deliberately.

## Package Exports

```ts
export { Stash } from "./stash.ts";
export type { StashEvents } from "./stash.ts";
export { GitHubProvider } from "./providers/github-provider.ts";
export { GitRepoError, MigrationError, PushConflictError, SyncLockError } from "./errors.ts";
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

  connect(connection: { name: string } & ConnectionConfig): Promise<void>;
  disconnect(name: string): Promise<void>;
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
- Runs local metadata migrations first when older prerelease stash layouts are detected.
- Uses the provided `globalConfig` plus local `.stash/config.json`.
- The current error guidance points callers toward `stash connect <provider> <name>`.

### `Stash.init()`

Ensures `.stash/` exists in `dir` and returns a loaded `Stash`.

- Creates `.stash/`
- Runs local metadata migrations first when older prerelease stash layouts are detected
- Creates `.stash/snapshot/`
- Creates `.stash/config.json` if missing
- Does not remove or move user files
- Is safe to call repeatedly

### `connections`

Returns the per-stash provider connection config exactly as stored locally.

`ConnectionConfig` always includes a required `provider` field.

### `config`

Returns the merged provider config view:

- global provider config from `globalConfig.providers`
- overlaid with local per-stash connection config

This is useful for code that needs the effective provider configuration, not just the local portion.

### `connect(connection)`

Stores named connection config in `.stash/config.json`.

At most one connection is supported per stash. If one connection exists and `connect` uses a **different** name, throws `MultipleConnectionsError`. Calling `connect` with the same name as an existing entry updates that entry. (The CLI rejects a duplicate name before calling `connect`; see `docs/cli.md`.)

### `disconnect(name)`

Removes connection config for a named connection from `.stash/config.json`.

### `sync()`

Runs one full sync cycle.

Behavioral contract:

- no configured connections -> no-op
- more than one connection in local config -> throws `MultipleConnectionsError` (invalid until reduced to one)
- one active sync at a time per `Stash` instance
- cross-process lock enforced through `.stash/sync.lock`
- may throw `GitRepoError`
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

See `docs/providers/overview.md` for the full provider contract, data types, and how to build a custom provider.

The package exports `GitHubProvider` as the built-in implementation. See `docs/providers/github.md` for its behavioral contract.

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
class MigrationError extends Error {}
class GitRepoError extends Error {}
class SyncLockError extends Error {}
```

- `MigrationError` means stash detected an on-disk local metadata conflict during startup migration and could not safely continue.
- `GitRepoError` means sync was blocked because the stash directory contains `.git/` and local config does not have `allow-git: true`.
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
