export { Stash } from "./stash.ts";
export type { StashEvents } from "./stash.ts";
export { GitHubProvider } from "./providers/github-provider.ts";
export { parseUri } from "./uri.ts";
export {
  GitRepoError,
  InvalidUriError,
  MigrationError,
  MultipleConnectionsError,
  PushConflictError,
  SyncLockError,
} from "./errors.ts";
export type { Disposable } from "./emitter.ts";
export { getGlobalConfigPath, readGlobalConfig, writeGlobalConfig } from "./global-config.ts";
export type {
  ChangeSet,
  ConfigItem,
  ConnectionConfig,
  FileMutation,
  FileState,
  GlobalConfig,
  Provider,
  ProviderClass,
  PushPayload,
  SnapshotEntry,
  StatusResult,
} from "./types.ts";
