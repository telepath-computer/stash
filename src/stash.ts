import DiffMatchPatch from "diff-match-patch";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { Emitter } from "./emitter.ts";
import { GitRepoError, MultipleConnectionsError, PushConflictError, SyncLockError } from "./errors.ts";
import { normalizeGlobalConfig } from "./global-config.ts";
import { getLocalConfigPath, readLocalConfig, writeLocalConfig } from "./local-config.ts";
import { ensureMigration } from "./migrations.ts";
import { providers as defaultProviders } from "./providers/index.ts";
import type {
  ChangeSet,
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
import { hashBuffer, hashText } from "./utils/hash.ts";
import { isTrackedPath } from "./utils/is-tracked-path.ts";
import { isValidText } from "./utils/text.ts";

export type StashEvents = {
  mutation: FileMutation;
};

type StashOptions = {
  providers?: Record<string, ProviderClass>;
};

function cloneSnapshot(snapshot: Record<string, SnapshotEntry>): Record<string, SnapshotEntry> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, SnapshotEntry>;
}

function sortPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

const STALE_SYNC_LOCK_MS = 10 * 60 * 1000;
const SYNC_RETRY_LIMIT = 5;
const NON_FILE_HASH = "__non-file__";

export class Stash extends Emitter<StashEvents> {
  private readonly dir: string;
  private readonly globalConfig: GlobalConfig;
  private readonly providerRegistry: Record<string, ProviderClass>;
  private _connections: Record<string, ConnectionConfig>;
  private syncInFlight = false;

  private constructor(
    dir: string,
    globalConfig: GlobalConfig,
    connections: Record<string, ConnectionConfig>,
    options?: StashOptions,
  ) {
    super();
    this.dir = dir;
    this.globalConfig = globalConfig;
    this._connections = connections;
    this.providerRegistry = options?.providers ?? defaultProviders;
  }

  static async load(
    dir: string,
    globalConfig: GlobalConfig,
    options?: StashOptions,
  ): Promise<Stash> {
    const stashDir = join(dir, ".stash");
    if (!existsSync(stashDir)) {
      throw new Error(
        "This directory is not a stash. Run `stash connect <provider> <name>` first.",
      );
    }

    await ensureMigration(dir);
    const localConfig = await readLocalConfig(dir);
    return new Stash(
      dir,
      normalizeGlobalConfig(globalConfig),
      localConfig.connections ?? {},
      options,
    );
  }

  static async init(
    dir: string,
    globalConfig: GlobalConfig,
    options?: StashOptions,
  ): Promise<Stash> {
    const stashDir = join(dir, ".stash");
    mkdirSync(stashDir, { recursive: true });
    await ensureMigration(dir);
    mkdirSync(join(stashDir, "snapshot"), { recursive: true });
    if (!existsSync(getLocalConfigPath(dir))) {
      await writeLocalConfig(dir, { connections: {} });
    }
    return Stash.load(dir, globalConfig, options);
  }

  get connections(): Record<string, ConnectionConfig> {
    return this._connections;
  }

  get config(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [name, connection] of Object.entries(this._connections)) {
      out[name] = {
        ...(this.globalConfig.providers[connection.provider] ?? {}),
        ...connection,
      };
    }
    return out;
  }

  async connect({ name, ...configFields }: { name: string } & ConnectionConfig): Promise<void> {
    const { provider, ...fields } = configFields;
    const existing = Object.keys(this._connections);
    if (existing.length >= 1 && !existing.includes(name)) {
      throw new MultipleConnectionsError();
    }
    this._connections[name] = { provider, ...fields };
    await this.persistLocalConfig();
  }

  async disconnect(name: string): Promise<void> {
    delete this._connections[name];
    await this.persistLocalConfig();
  }

  async sync(): Promise<void> {
    if (this.syncInFlight) {
      throw new SyncLockError();
    }
    this.acquireSyncLock();
    this.syncInFlight = true;

    try {
      const localConfig = await readLocalConfig(this.dir);
      if (this.hasGitRepository() && localConfig["allow-git"] !== true) {
        throw new GitRepoError();
      }

      const connectionNames = Object.keys(this._connections);
      if (connectionNames.length === 0) {
        return;
      }
      if (connectionNames.length > 1) {
        throw new MultipleConnectionsError();
      }

      for (const name of connectionNames) {
        const provider = this.buildProvider(name);
        let lastRetryError: Error | null = null;
        let completed = false;

        for (let attempt = 1; attempt <= SYNC_RETRY_LIMIT; attempt += 1) {
          const localSnapshot = this.readSnapshot();
          const localChanges = this.scan();
          const remoteChanges = await provider.fetch(localSnapshot);
          const mutations = this.reconcile(localChanges, remoteChanges);
          const nextSnapshot = this.computeSnapshot(localSnapshot, mutations);
          const expectedHashes = this.buildExpectedHashes(localChanges, localSnapshot, mutations);

          if (this.hasAnyPathDrift(expectedHashes)) {
            lastRetryError = new Error("local files changed during sync");
            if (attempt === SYNC_RETRY_LIMIT) {
              throw lastRetryError;
            }
            continue;
          }

          if (mutations.length > 0) {
            const payload = await this.buildPushPayload(mutations, nextSnapshot);
            const snapshotChanged = JSON.stringify(nextSnapshot) !== JSON.stringify(localSnapshot);
            if (payload.files.size > 0 || payload.deletions.length > 0 || snapshotChanged) {
              try {
                await provider.push(payload);
              } catch (error) {
                if (error instanceof PushConflictError) {
                  lastRetryError = error;
                  if (attempt === SYNC_RETRY_LIMIT) {
                    throw error;
                  }
                  continue;
                }
                throw error;
              }
            }
          }

          const skippedWritePaths = await this.apply(mutations, provider, expectedHashes);
          const localSnapshotToSave = this.rollBackSkippedSnapshotEntries(
            nextSnapshot,
            localSnapshot,
            skippedWritePaths,
          );
          await this.saveSnapshot(localSnapshotToSave, mutations, skippedWritePaths);
          completed = true;
          break;
        }

        if (!completed) {
          throw lastRetryError ?? new Error("sync failed");
        }
      }
    } finally {
      this.syncInFlight = false;
      this.releaseSyncLock();
    }
  }

  status(): StatusResult {
    const changeSet = this.scan();
    const snapshotPath = this.snapshotPath();
    let lastSync: Date | null = null;
    if (existsSync(snapshotPath)) {
      lastSync = new Date(statSync(snapshotPath).mtimeMs);
    }
    return {
      added: sortPaths(changeSet.added.keys()),
      modified: sortPaths(changeSet.modified.keys()),
      deleted: [...changeSet.deleted].sort((a, b) => a.localeCompare(b)),
      lastSync,
    };
  }

  private buildProvider(name: string): Provider {
    const connection = this._connections[name];
    if (!connection) {
      throw new Error(`Unknown connection: ${name}`);
    }

    const providerName = connection.provider;
    const providerClass = this.providerRegistry[providerName];
    if (!providerClass) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    const config = {
      ...(this.globalConfig.providers[providerName] ?? {}),
      ...connection,
    };
    return new providerClass(config);
  }

  private scan(): ChangeSet {
    const snapshot = this.readSnapshot();
    const added = new Map<string, FileState>();
    const modified = new Map<string, FileState>();
    const deleted: string[] = [];

    const seen = new Set<string>();
    for (const relPath of this.listTrackedFiles()) {
      const absPath = this.abs(relPath);
      const content = readFileSync(absPath);
      const hash = hashBuffer(content);
      const stat = statSync(absPath);
      const snapshotEntry = snapshot[relPath];
      const fileState: FileState = isValidText(content)
        ? { type: "text", content: content.toString("utf8") }
        : {
            type: "binary",
            hash,
            modified: Math.trunc(stat.mtimeMs),
          };

      seen.add(relPath);
      if (!snapshotEntry) {
        added.set(relPath, fileState);
      } else if (snapshotEntry.hash !== hash) {
        modified.set(relPath, fileState);
      }
    }

    for (const path of Object.keys(snapshot)) {
      if (!seen.has(path)) {
        deleted.push(path);
      }
    }
    deleted.sort((a, b) => a.localeCompare(b));

    return { added, modified, deleted };
  }

  private reconcile(local: ChangeSet, remote: ChangeSet): FileMutation[] {
    const allPaths = new Set<string>();
    for (const path of local.added.keys()) allPaths.add(path);
    for (const path of local.modified.keys()) allPaths.add(path);
    for (const path of local.deleted) allPaths.add(path);
    for (const path of remote.added.keys()) allPaths.add(path);
    for (const path of remote.modified.keys()) allPaths.add(path);
    for (const path of remote.deleted) allPaths.add(path);

    const mutations: FileMutation[] = [];
    const localDeleted = new Set(local.deleted);
    const remoteDeleted = new Set(remote.deleted);
    for (const path of sortPaths(allPaths)) {
      const localWasDeleted = localDeleted.has(path);
      const remoteWasDeleted = remoteDeleted.has(path);
      const localState = local.added.get(path) ?? local.modified.get(path) ?? null;
      const remoteState = remote.added.get(path) ?? remote.modified.get(path) ?? null;
      const localKind = localWasDeleted
        ? "deleted"
        : local.added.has(path)
          ? "added"
          : local.modified.has(path)
            ? "modified"
            : "none";
      const remoteKind = remoteWasDeleted
        ? "deleted"
        : remote.added.has(path)
          ? "added"
          : remote.modified.has(path)
            ? "modified"
            : "none";

      if (localKind === "none" && remoteKind === "none") {
        continue;
      }

      if (localKind === "deleted" && remoteKind === "deleted") {
        mutations.push({ path, disk: "skip", remote: "skip" });
        continue;
      }

      if (localKind === "deleted" && remoteKind === "none") {
        mutations.push({ path, disk: "skip", remote: "delete" });
        continue;
      }

      if (localKind === "none" && remoteKind === "deleted") {
        mutations.push({ path, disk: "delete", remote: "skip" });
        continue;
      }

      if (localKind === "deleted" && remoteState) {
        if (remoteState.type === "text") {
          mutations.push({
            path,
            disk: "write",
            remote: "skip",
            content: remoteState.content,
          });
        } else {
          mutations.push({
            path,
            disk: "write",
            remote: "skip",
            source: "remote",
            hash: remoteState.hash,
            modified: remoteState.modified,
          });
        }
        continue;
      }

      if (remoteKind === "deleted" && localState) {
        if (localState.type === "text") {
          mutations.push({
            path,
            disk: "skip",
            remote: "write",
            content: localState.content,
          });
        } else {
          mutations.push({
            path,
            disk: "skip",
            remote: "write",
            source: "local",
            hash: localState.hash,
            modified: localState.modified,
          });
        }
        continue;
      }

      if (localState && !remoteState) {
        if (localState.type === "text") {
          mutations.push({
            path,
            disk: "skip",
            remote: "write",
            content: localState.content,
          });
        } else {
          mutations.push({
            path,
            disk: "skip",
            remote: "write",
            source: "local",
            hash: localState.hash,
            modified: localState.modified,
          });
        }
        continue;
      }

      if (!localState && remoteState) {
        if (remoteState.type === "text") {
          mutations.push({
            path,
            disk: "write",
            remote: "skip",
            content: remoteState.content,
          });
        } else {
          mutations.push({
            path,
            disk: "write",
            remote: "skip",
            source: "remote",
            hash: remoteState.hash,
            modified: remoteState.modified,
          });
        }
        continue;
      }

      if (!localState || !remoteState) {
        continue;
      }

      if (localState.type === "text" && remoteState.type === "text") {
        const base = this.readSnapshotLocal(path);
        const merged = this.mergeText(base, localState.content, remoteState.content);
        mutations.push({
          path,
          disk: merged === localState.content ? "skip" : "write",
          remote: merged === remoteState.content ? "skip" : "write",
          content: merged,
        });
        continue;
      }

      if (localState.type === "binary" && remoteState.type === "binary") {
        const localWins = localState.modified >= remoteState.modified;
        const winner = localWins ? localState : remoteState;
        const identical = localState.hash === remoteState.hash;
        mutations.push({
          path,
          disk: identical ? "skip" : "write",
          remote: identical ? "skip" : "write",
          source: localWins ? "local" : "remote",
          hash: winner.hash,
          modified: winner.modified,
        });
        continue;
      }

      // Text-vs-binary should not happen in steady state, but we pick
      // text content to avoid dropping readable edits.
      if (localState.type === "text") {
        mutations.push({
          path,
          disk: "write",
          remote: "write",
          content: localState.content,
        });
      } else {
        mutations.push({
          path,
          disk: "write",
          remote: "write",
          content: (remoteState as { type: "text"; content: string }).content,
        });
      }
    }

    return mutations;
  }

  private mergeText(snapshot: string | null, local: string, remote: string): string {
    if (local === remote) {
      return local;
    }

    if (snapshot !== null) {
      if (local === snapshot) {
        return remote;
      }
      if (remote === snapshot) {
        return local;
      }

      const dmp = new DiffMatchPatch();
      const localPatches = dmp.patch_make(snapshot, local);
      const remotePatches = dmp.patch_make(snapshot, remote);
      const [afterLocal] = dmp.patch_apply(localPatches, snapshot);
      const [merged] = dmp.patch_apply(remotePatches, afterLocal);
      return merged as string;
    }

    const dmp = new DiffMatchPatch();
    const patches = dmp.patch_make(local, remote);
    const [merged] = dmp.patch_apply(patches, local);
    return merged as string;
  }

  private computeSnapshot(
    oldSnapshot: Record<string, SnapshotEntry>,
    mutations: FileMutation[],
  ): Record<string, SnapshotEntry> {
    const next = cloneSnapshot(oldSnapshot);

    for (const mutation of mutations) {
      const isDelete =
        mutation.disk === "delete" ||
        mutation.remote === "delete" ||
        (mutation.disk === "skip" &&
          mutation.remote === "skip" &&
          mutation.content === undefined &&
          mutation.source === undefined);
      if (isDelete) {
        delete next[mutation.path];
        continue;
      }

      if (mutation.content !== undefined) {
        next[mutation.path] = { hash: hashText(mutation.content) };
        continue;
      }

      if (mutation.hash && mutation.modified !== undefined) {
        next[mutation.path] = {
          hash: mutation.hash,
          modified: mutation.modified,
        };
      }
    }

    return next;
  }

  private async apply(
    mutations: FileMutation[],
    provider: Provider,
    expectedHashes: Map<string, string | null>,
  ): Promise<Set<string>> {
    const skippedWritePaths = new Set<string>();
    // Process deletes before writes so case-only renames on
    // case-insensitive filesystems don't delete a just-written file.
    const ordered = [...mutations].sort((a, b) => {
      const aIsDelete = a.disk === "delete" ? 0 : 1;
      const bIsDelete = b.disk === "delete" ? 0 : 1;
      return aIsDelete - bIsDelete;
    });
    for (const mutation of ordered) {
      let diskAction = mutation.disk;
      if (diskAction === "write") {
        const expectedHash = expectedHashes.get(mutation.path) ?? null;
        if (this.pathDrifted(mutation.path, expectedHash)) {
          diskAction = "skip";
          skippedWritePaths.add(mutation.path);
        }
      }

      const target = this.abs(mutation.path);

      if (diskAction === "delete") {
        this.safeDelete(target);
      } else if (diskAction === "write") {
        this.ensureDirectoryCasing(mutation.path);
        await mkdir(dirname(target), { recursive: true });

        if (mutation.content !== undefined) {
          await writeFile(target, mutation.content, "utf8");
        } else if (mutation.source === "remote") {
          const remoteStream = await provider.get(mutation.path);
          const writer = createWriteStream(target);
          await pipeline(remoteStream, writer);
        }
      }

      if (diskAction === mutation.disk) {
        this.emit("mutation", mutation);
      } else {
        this.emit("mutation", { ...mutation, disk: diskAction });
      }
    }
    return skippedWritePaths;
  }

  private async saveSnapshot(
    snapshot: Record<string, SnapshotEntry>,
    mutations: FileMutation[],
    skippedWritePaths: Set<string> = new Set<string>(),
  ): Promise<void> {
    await mkdir(this.snapshotLocalDir(), { recursive: true });
    await writeFile(this.snapshotPath(), JSON.stringify(snapshot, null, 2), "utf8");

    for (const mutation of mutations) {
      if (skippedWritePaths.has(mutation.path)) {
        continue;
      }
      if (mutation.content !== undefined) {
        const destination = join(this.snapshotLocalDir(), mutation.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, mutation.content, "utf8");
        continue;
      }

      const isDelete =
        mutation.disk === "delete" ||
        mutation.remote === "delete" ||
        (mutation.disk === "skip" && mutation.remote === "skip" && mutation.source === undefined);
      if (isDelete) {
        this.safeDelete(join(this.snapshotLocalDir(), mutation.path));
      }
    }
  }

  private rollBackSkippedSnapshotEntries(
    nextSnapshot: Record<string, SnapshotEntry>,
    previousSnapshot: Record<string, SnapshotEntry>,
    skippedWritePaths: Set<string>,
  ): Record<string, SnapshotEntry> {
    if (skippedWritePaths.size === 0) {
      return nextSnapshot;
    }
    const localSnapshot = cloneSnapshot(nextSnapshot);
    for (const path of skippedWritePaths) {
      if (previousSnapshot[path]) {
        localSnapshot[path] = { ...previousSnapshot[path] };
      } else {
        delete localSnapshot[path];
      }
    }
    return localSnapshot;
  }

  private async buildPushPayload(
    mutations: FileMutation[],
    snapshot: Record<string, SnapshotEntry>,
  ): Promise<PushPayload> {
    const files = new Map<string, string | (() => import("node:stream").Readable)>();
    const deletions: string[] = [];

    for (const mutation of mutations) {
      if (mutation.remote === "delete") {
        deletions.push(mutation.path);
        continue;
      }
      if (mutation.remote !== "write") {
        continue;
      }

      if (mutation.content !== undefined) {
        files.set(mutation.path, mutation.content);
        continue;
      }

      if (mutation.source === "local") {
        files.set(mutation.path, () => createReadStream(this.abs(mutation.path)));
        continue;
      }
      // source: "remote" already exists remotely with winning content.
      // No need to stream bytes back to the same provider.
    }

    return { files, deletions, snapshot };
  }

  private hasAnyPathDrift(expectedHashes: Map<string, string | null>): boolean {
    for (const [path, expectedHash] of expectedHashes) {
      if (this.pathDrifted(path, expectedHash)) {
        return true;
      }
    }
    return false;
  }

  private pathDrifted(path: string, expectedHash: string | null): boolean {
    return this.currentHash(path) !== expectedHash;
  }

  private ensureDirectoryCasing(relPath: string): void {
    const segments = relPath.split("/");
    const dirSegments = segments.slice(0, -1);
    let current = this.dir;
    for (const segment of dirSegments) {
      if (!existsSync(current)) {
        break;
      }
      const entries = readdirSync(current);
      const actual = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      if (actual && actual !== segment && !entries.includes(segment)) {
        renameSync(join(current, actual), join(current, segment));
      }
      current = join(current, segment);
    }
  }

  private hasExactCasing(relPath: string): boolean {
    const segments = relPath.split("/");
    let current = this.dir;
    for (const segment of segments) {
      const entries = readdirSync(current);
      const actual = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      if (!actual || actual !== segment) {
        return false;
      }
      current = join(current, actual);
    }
    return true;
  }

  private currentHash(path: string): string | null {
    const absPath = this.abs(path);
    if (!existsSync(absPath)) {
      return null;
    }
    if (!this.hasExactCasing(path)) {
      return null;
    }
    const stat = lstatSync(absPath);
    if (!stat.isFile()) {
      return NON_FILE_HASH;
    }
    return hashBuffer(readFileSync(absPath));
  }

  private buildExpectedHashes(
    localChanges: ChangeSet,
    localSnapshot: Record<string, SnapshotEntry>,
    mutations: FileMutation[],
  ): Map<string, string | null> {
    const expected = new Map<string, string | null>();
    const localDeleted = new Set(localChanges.deleted);

    for (const mutation of mutations) {
      if (expected.has(mutation.path)) {
        continue;
      }
      const path = mutation.path;
      if (localDeleted.has(path)) {
        expected.set(path, null);
        continue;
      }
      const localState = localChanges.added.get(path) ?? localChanges.modified.get(path) ?? null;
      if (localState?.type === "text") {
        expected.set(path, hashText(localState.content));
        continue;
      }
      if (localState?.type === "binary") {
        expected.set(path, localState.hash);
        continue;
      }
      const snapshotEntry = localSnapshot[path];
      expected.set(path, snapshotEntry ? snapshotEntry.hash : null);
    }

    return expected;
  }

  private readSnapshot(): Record<string, SnapshotEntry> {
    const path = this.snapshotPath();
    if (!existsSync(path)) {
      return {};
    }
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, SnapshotEntry>;
  }

  private readSnapshotLocal(path: string): string | null {
    const snapshotPath = join(this.snapshotLocalDir(), path);
    if (!existsSync(snapshotPath)) {
      return null;
    }
    return readFileSync(snapshotPath, "utf8");
  }

  private async persistLocalConfig(): Promise<void> {
    const currentConfig = await readLocalConfig(this.dir);
    await writeLocalConfig(this.dir, {
      ...currentConfig,
      connections: this._connections,
    });
  }

  private acquireSyncLock(): void {
    const lockPath = this.syncLockPath();
    const payload = JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: hostname(),
      },
      null,
      2,
    );

    if (this.tryCreateSyncLock(lockPath, payload)) {
      return;
    }

    this.maybeReclaimStaleSyncLock(lockPath);
    if (!this.tryCreateSyncLock(lockPath, payload)) {
      throw new SyncLockError();
    }
  }

  private tryCreateSyncLock(lockPath: string, payload: string): boolean {
    try {
      writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  private maybeReclaimStaleSyncLock(lockPath: string): void {
    const startedAt = this.readSyncLockStartedAt(lockPath);
    if (!startedAt) {
      return;
    }

    const startedAtMs = Date.parse(startedAt);
    if (Number.isNaN(startedAtMs)) {
      return;
    }
    if (Date.now() - startedAtMs <= STALE_SYNC_LOCK_MS) {
      return;
    }

    try {
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private readSyncLockStartedAt(lockPath: string): string | null {
    try {
      const raw = readFileSync(lockPath, "utf8");
      const parsed = JSON.parse(raw) as { startedAt?: unknown };
      if (typeof parsed.startedAt !== "string") {
        return null;
      }
      return parsed.startedAt;
    } catch {
      return null;
    }
  }

  private releaseSyncLock(): void {
    try {
      unlinkSync(this.syncLockPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private listTrackedFiles(): string[] {
    const root = this.dir;
    const paths: string[] = [];

    const walk = (currentDir: string): void => {
      const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        const absPath = join(currentDir, entry.name);
        const relPath = relative(root, absPath).split("\\").join("/");
        if (!isTrackedPath(relPath)) {
          continue;
        }
        const stat = lstatSync(absPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          walk(absPath);
          continue;
        }
        if (stat.isFile()) {
          paths.push(relPath);
        }
      }
    };

    walk(root);
    return paths;
  }

  private safeDelete(path: string): void {
    if (!existsSync(path)) {
      return;
    }
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
  }

  private abs(path: string): string {
    return join(this.dir, path);
  }

  private snapshotPath(): string {
    return join(this.dir, ".stash", "snapshot.json");
  }

  private snapshotLocalDir(): string {
    return join(this.dir, ".stash", "snapshot");
  }

  private hasGitRepository(): boolean {
    return existsSync(join(this.dir, ".git"));
  }

  private syncLockPath(): string {
    return join(this.dir, ".stash", "sync.lock");
  }
}
