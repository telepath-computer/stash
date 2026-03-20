# Providers

A provider is a remote transport for Stash. It knows how to fetch, stream, and push files to a remote storage backend. It does not merge files, resolve conflicts, or touch local disk — Stash handles all of that.

The only built-in provider is [GitHub](github.md). This document defines the contract any provider must satisfy and how to build a new one.

## How sync uses providers

Understanding where providers fit in the sync lifecycle helps clarify what each method needs to do.

1. Stash scans local files and diffs them against the stored snapshot.
2. Stash calls **`fetch()`** on the provider, passing the local snapshot. The provider loads its own copy of the snapshot from the remote, diffs it, and returns what changed.
3. Stash reconciles local and remote changes — merging text, picking winners for binaries.
4. Stash calls **`push()`** with the files, deletions, and updated snapshot that need to go to the remote.
5. If a binary file was won by the remote side, Stash calls **`get()`** to stream the bytes for local disk.
6. Stash applies local writes and saves the new snapshot.

The provider only participates in steps 2, 4, and 5. Everything else — scanning, reconciliation, merging, local disk writes — is Stash's job.

## Contract

A provider implements three async methods:

### `fetch(localSnapshot?): Promise<ChangeSet>`

Returns what changed on the remote since the last sync.

- `localSnapshot` is a `Record<string, SnapshotEntry>` mapping file paths to their last-synced state. It will be `undefined` on the very first sync before any snapshot exists.
- Returns a `ChangeSet` describing files that were added, modified, or deleted on the remote relative to the snapshot.
- For text files, the `FileState` in the change set must include the full file content — Stash needs it for three-way merging.
- For binary files, the `FileState` includes a hash and modified timestamp. The actual bytes are fetched lazily via `get()` only if the remote side wins reconciliation.
- Should return an empty `ChangeSet` when the remote is empty or uninitialized (e.g. an empty repo with no commits).
- Must exclude `.stash/` paths from file discovery. The provider reads `.stash/snapshot.json` internally to compute the diff, but it should not surface `.stash/` files as user content.

### `get(path): Promise<Readable>`

Streams one binary file from the remote.

- Only called when reconciliation determines the remote version wins for a binary file and Stash needs the actual bytes to write locally.
- Returns a Node `Readable` stream of the file contents.
- The `path` argument is the same relative path used in the `ChangeSet` (e.g. `"images/photo.png"`).

### `push(payload): Promise<void>`

Writes one sync cycle's worth of changes to the remote.

- `payload.files` is a `Map<string, string | (() => Readable)>` mapping relative paths to content. Text files are plain `string` values. Binary files are thunks that return a `Readable` stream — call them to get the bytes.
- `payload.deletions` is a `string[]` of relative paths to remove from the remote.
- `payload.snapshot` is the new snapshot state (`Record<string, SnapshotEntry>`) that must be written to `.stash/snapshot.json` on the remote. This is how the next `fetch()` call will determine what changed.
- Must detect concurrent remote changes and throw `PushConflictError` when the remote state moved since `fetch()` was called. For example, the GitHub provider compares the branch HEAD SHA before and after. Stash handles retry logic — the provider just signals the conflict.
- An empty `payload.files` and `payload.deletions` with only a snapshot update is valid — the provider should still write the snapshot.

## Snapshot management

The snapshot is central to how providers work. It's a JSON object mapping every synced file path to its hash (and for binary files, a modified timestamp):

```json
{
  "notes/todo.md": { "hash": "sha256-abc123" },
  "images/photo.png": { "hash": "sha256-def456", "modified": 1709290800000 }
```

The provider stores this as `.stash/snapshot.json` on the remote. On each `fetch()`, the provider loads the remote snapshot, compares it against the `localSnapshot` argument, and returns the differences as a `ChangeSet`. On each `push()`, the provider writes the new snapshot from `payload.snapshot`.

This means the provider doesn't need to track file history or maintain a changelog — the snapshot diff is sufficient.

## Static declaration

Every provider class has a static `spec` that tells the CLI what config fields to prompt for:

```ts
import type { ProviderSpec } from "@rupertsworld/stash";

static spec: ProviderSpec = {
  setup: [
    // Global fields, prompted once by `stash setup <provider>`.
    // Stored in ~/.stash/config.json (or $XDG_CONFIG_HOME/stash/config.json).
    { name: "token", label: "Access token", secret: true },
  ],
  connect: [
    // Per-stash fields, prompted by `stash connect <provider>`.
    // Stored in .stash/config.json inside the stash directory.
    { name: "bucket", label: "S3 bucket name" },
  ],
};
```

- **`setup` fields** are global credentials or account-level config. These are prompted once by `stash setup <provider>` and stored in the user's global config (`~/.stash/config.json` or `$XDG_CONFIG_HOME/stash/config.json`). Think API tokens, access keys, account IDs.
- **`connect` fields** are per-stash identifiers. These are prompted by `stash connect <provider>` and stored in `.stash/config.json` inside the stash directory. Think repo names, bucket names, folder paths.
- Fields with `secret: true` are masked during CLI input.

## Constructor

The constructor receives the merged config — global setup fields overlaid with per-stash connect fields — as a flat `Record<string, string>`. For example, if `setup` defines `token` and `connect` defines `bucket`, the constructor receives `{ token: "...", bucket: "..." }`.

```ts
class S3Provider implements Provider {
  private bucket: string;
  private client: S3Client;

  constructor(config: Record<string, string>) {
    this.bucket = config.bucket;
    this.client = new S3Client({ credentials: { ... } });
  }
}
```

Validate eagerly in the constructor. If required fields are missing or credentials are obviously invalid, throw immediately rather than failing later during sync.

## Registration

Providers are registered by passing them to `Stash.load()` or `Stash.init()`:

```ts
import { Stash } from "@rupertsworld/stash";
import { S3Provider } from "./s3-provider.ts";

const stash = await Stash.load(dir, globalConfig, {
  providers: { s3: S3Provider },
});
```

The key (e.g. `"s3"`) is the provider name used in CLI commands like `stash setup s3` and `stash connect s3`.

Built-in providers are registered in `src/providers/index.ts`. External providers can be passed in without modifying that file.

## Constraints

Providers must stay within these boundaries:

- **Transport-only.** No merging, no conflict resolution, no local disk access. The provider moves bytes between Stash and the remote — nothing more.
- **Stateless across calls.** Each `fetch`/`push` cycle should be self-contained. Don't cache file state between sync cycles. Stash manages continuity through snapshots.
- **Snapshot as source of truth.** The provider is responsible for storing and retrieving `.stash/snapshot.json` on the remote. Without this, `fetch()` has no way to compute a diff.
- **Error signaling.** Throw `PushConflictError` (exported from the package) for ref races or concurrent modification. Let other errors (auth failures, network errors, etc.) propagate naturally. Retry logic belongs to Stash, not the provider.
- **Consistent binary detection.** Text vs binary classification must agree with how Stash scans local files. If `fetch()` classifies a file differently than the local scanner, the file will ping-pong between text and binary states across syncs.

## Data types

All types are exported from `@rupertsworld/stash`.

### `SnapshotEntry`

```ts
type SnapshotEntry = { hash: string } | { hash: string; modified: number };
```

Represents one file in the snapshot. Text files have only a `hash` (SHA-256 of the content). Binary files also have a `modified` timestamp (milliseconds since epoch) used for last-modified-wins resolution.

### `FileState`

```ts
type FileState =
  | { type: "text"; content: string }
  | { type: "binary"; hash: string; modified: number };
```

Describes a file in a `ChangeSet`. Text files carry their full content inline — Stash needs this for three-way merging. Binary files carry metadata only; the actual bytes are fetched on demand via `get()`.

### `ChangeSet`

```ts
interface ChangeSet {
  added: Map<string, FileState>;
  modified: Map<string, FileState>;
  deleted: string[];
}
```

Returned by `fetch()`. Maps are keyed by relative file path (e.g. `"notes/todo.md"`). `deleted` is a flat list of paths that existed in the snapshot but no longer exist on the remote.

### `PushPayload`

```ts
interface PushPayload {
  files: Map<string, string | (() => Readable)>;
  deletions: string[];
  snapshot: Record<string, SnapshotEntry>;
}
```

Passed to `push()`. `files` maps paths to content — `string` for text, `() => Readable` for binary. The thunk pattern for binaries avoids reading large files into memory until the provider actually needs them. `snapshot` is the complete new snapshot state to write to `.stash/snapshot.json`.

### `PushConflictError`

```ts
import { PushConflictError } from "@rupertsworld/stash";
```

Throw this from `push()` when the remote state changed between `fetch()` and `push()`. Stash will catch it and retry the full sync cycle (up to 5 times).

## Full skeleton

```ts
import type { Readable } from "node:stream";
import type {
  ChangeSet,
  Provider,
  ProviderSpec,
  PushPayload,
  SnapshotEntry,
} from "@rupertsworld/stash";
import { PushConflictError } from "@rupertsworld/stash";

export class MyProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [{ name: "token", label: "API token", secret: true }],
    connect: [{ name: "remote-id", label: "Remote identifier" }],
  };

  constructor(config: Record<string, string>) {
    // Validate and store config.
    // config contains merged setup + connect fields,
    // e.g. { token: "...", "remote-id": "..." }
  }

  async fetch(
    localSnapshot?: Record<string, SnapshotEntry>,
  ): Promise<ChangeSet> {
    // 1. Load .stash/snapshot.json from the remote.
    // 2. If no remote snapshot exists (first sync from another client),
    //    list all remote files and return them as added.
    // 3. Otherwise, diff the remote snapshot against localSnapshot
    //    to find added, modified, and deleted files.
    // 4. For text files, fetch their full content.
    // 5. For binary files, include hash + modified metadata only.
    // 6. Return the ChangeSet.
  }

  async get(path: string): Promise<Readable> {
    // Stream one binary file from the remote.
    // Only called for files where the remote side won reconciliation.
  }

  async push(payload: PushPayload): Promise<void> {
    // 1. Write payload.files to the remote.
    //    - For text: value is a string.
    //    - For binary: value is () => Readable, call it to get the stream.
    // 2. Delete payload.deletions from the remote.
    // 3. Write payload.snapshot as .stash/snapshot.json on the remote.
    // 4. If the remote changed concurrently, throw PushConflictError.
  }
}
```

See [GitHub provider](github.md) for a complete working implementation.
