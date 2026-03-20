export { Stash } from "./stash.ts";
export type { StashEvents } from "./stash.ts";
export { GitHubProvider } from "./providers/github-provider.ts";
export { GitRepoError, MigrationError, MultipleConnectionsError, PushConflictError, SyncLockError } from "./errors.ts";
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
