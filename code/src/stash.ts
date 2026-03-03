import DiffMatchPatch from "diff-match-patch";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { Emitter } from "./emitter.ts";
import { PushConflictError } from "./errors.ts";
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
import { isValidText } from "./utils/text.ts";

type StashEvents = {
  mutation: FileMutation;
};

type LocalConfig = {
  connections: Record<string, ConnectionConfig>;
};

type StashOptions = {
  providers?: Record<string, ProviderClass>;
};

function cloneSnapshot(
  snapshot: Record<string, SnapshotEntry>,
): Record<string, SnapshotEntry> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, SnapshotEntry>;
}

function sortPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

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
      throw new Error("This directory is not a stash. Run `stash init` first.");
    }

    const configPath = join(stashDir, "config.local.json");
    const localConfig = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, "utf8")) as LocalConfig)
      : { connections: {} };
    return new Stash(dir, globalConfig, localConfig.connections ?? {}, options);
  }

  static async init(
    dir: string,
    globalConfig: GlobalConfig,
    options?: StashOptions,
  ): Promise<Stash> {
    const stashDir = join(dir, ".stash");
    const configPath = join(stashDir, "config.local.json");
    mkdirSync(stashDir, { recursive: true });
    mkdirSync(join(stashDir, "snapshot.local"), { recursive: true });
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify({ connections: {} }, null, 2), "utf8");
    }
    return Stash.load(dir, globalConfig, options);
  }

  get connections(): Record<string, ConnectionConfig> {
    return this._connections;
  }

  get config(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    const names = new Set([
      ...Object.keys(this.globalConfig),
      ...Object.keys(this._connections),
    ]);
    for (const name of names) {
      out[name] = {
        ...(this.globalConfig[name] ?? {}),
        ...(this._connections[name] ?? {}),
      };
    }
    return out;
  }

  async connect(provider: string, fields: Record<string, string>): Promise<void> {
    this._connections[provider] = { ...fields };
    this.writeLocalConfig();
  }

  async disconnect(provider: string): Promise<void> {
    delete this._connections[provider];
    this.writeLocalConfig();
  }

  async sync(): Promise<void> {
    if (this.syncInFlight) {
      throw new Error("sync already in progress");
    }
    this.syncInFlight = true;

    try {
      const connectionNames = Object.keys(this._connections);
      if (connectionNames.length === 0) {
        return;
      }

      for (const name of connectionNames) {
        const provider = this.buildProvider(name);
        const localSnapshot = this.readSnapshot();
        const localChanges = this.scan();

        let mutations: FileMutation[] = [];
        let nextSnapshot = cloneSnapshot(localSnapshot);
        let attempts = 0;
        while (attempts < 3) {
          attempts += 1;
          const remoteChanges = await provider.fetch(localSnapshot);
          mutations = this.reconcile(localChanges, remoteChanges);
          nextSnapshot = this.computeSnapshot(localSnapshot, mutations);

          if (mutations.length === 0) {
            break;
          }

          const payload = await this.buildPushPayload(mutations, nextSnapshot);
          if (payload.files.size === 0 && payload.deletions.length === 0) {
            break;
          }
          try {
            await provider.push(payload);
            break;
          } catch (error) {
            if (error instanceof PushConflictError && attempts < 3) {
              continue;
            }
            throw error;
          }
        }

        await this.apply(mutations, provider);
        await this.saveSnapshot(nextSnapshot, mutations);
      }
    } finally {
      this.syncInFlight = false;
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
    const providerClass = this.providerRegistry[name];
    if (!providerClass) {
      throw new Error(`Unknown provider: ${name}`);
    }

    const config = {
      ...(this.globalConfig[name] ?? {}),
      ...(this._connections[name] ?? {}),
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
      const localState =
        local.added.get(path) ?? local.modified.get(path) ?? null;
      const remoteState =
        remote.added.get(path) ?? remote.modified.get(path) ?? null;
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
          disk: "write",
          remote: "write",
          content: merged,
        });
        continue;
      }

      if (localState.type === "binary" && remoteState.type === "binary") {
        // Equal mtimes choose local for deterministic tie-breaking.
        const localWins = localState.modified >= remoteState.modified;
        const winner = localWins ? localState : remoteState;
        mutations.push({
          path,
          disk: "write",
          remote: "write",
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
          content: remoteState.content,
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

  private async apply(mutations: FileMutation[], provider: Provider): Promise<void> {
    for (const mutation of mutations) {
      const target = this.abs(mutation.path);

      if (mutation.disk === "delete") {
        this.safeDelete(target);
      } else if (mutation.disk === "write") {
        await mkdir(dirname(target), { recursive: true });

        if (mutation.content !== undefined) {
          await writeFile(target, mutation.content, "utf8");
        } else if (mutation.source === "remote") {
          const remoteStream = await provider.get(mutation.path);
          const writer = createWriteStream(target);
          await pipeline(remoteStream, writer);
        }
      }

      this.emit("mutation", mutation);
    }
  }

  private async saveSnapshot(
    snapshot: Record<string, SnapshotEntry>,
    mutations: FileMutation[],
  ): Promise<void> {
    await mkdir(this.snapshotLocalDir(), { recursive: true });
    await writeFile(this.snapshotPath(), JSON.stringify(snapshot, null, 2), "utf8");

    for (const mutation of mutations) {
      if (mutation.content !== undefined) {
        const destination = join(this.snapshotLocalDir(), mutation.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, mutation.content, "utf8");
        continue;
      }

      const isDelete =
        mutation.disk === "delete" ||
        mutation.remote === "delete" ||
        (mutation.disk === "skip" &&
          mutation.remote === "skip" &&
          mutation.source === undefined);
      if (isDelete) {
        this.safeDelete(join(this.snapshotLocalDir(), mutation.path));
      }
    }
  }

  private async buildPushPayload(
    mutations: FileMutation[],
    snapshot: Record<string, SnapshotEntry>,
  ): Promise<PushPayload> {
    const files = new Map<string, string | (() => NodeJS.ReadableStream)>();
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

  private writeLocalConfig(): void {
    const localConfig: LocalConfig = { connections: this._connections };
    writeFileSync(
      join(this.dir, ".stash", "config.local.json"),
      JSON.stringify(localConfig, null, 2),
      "utf8",
    );
  }

  private listTrackedFiles(): string[] {
    const root = this.dir;
    const paths: string[] = [];

    const walk = (currentDir: string): void => {
      const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }

        const absPath = join(currentDir, entry.name);
        const relPath = relative(root, absPath).split("\\").join("/");
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
    return join(this.dir, ".stash", "snapshot.local");
  }
}
