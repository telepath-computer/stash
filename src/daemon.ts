import watcher from "@parcel/watcher";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getGlobalConfigPath,
  getProviderConfig,
  getStashDirPath,
  normalizeGlobalConfig,
} from "./global-config.ts";
import { withRegistryLock } from "./registry-lock.ts";
import { Stash } from "./stash.ts";
import type { GlobalConfig, StashRecord } from "./types.ts";
import { Watch, type WatchStatus } from "./watch.ts";
import { readJsonFile, writeJsonFile } from "./utils/fs.ts";

const MAX_LOG_BYTES = 1_000_000;
const DEFAULT_POLL_MS = 30_000;
const ORPHAN_MAX_AGE_MS = 5 * 60_000;

type SubscribeFn = typeof watcher.subscribe;
type WatchSubscription = Awaited<ReturnType<typeof watcher.subscribe>>;

type RunningWatch = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

type CreateWatchArgs = {
  stash: Stash;
  onStatus: (status: WatchStatus) => Promise<void>;
};

type CreateWatchFn = (args: CreateWatchArgs) => Promise<RunningWatch>;

type BackgroundDaemonOptions = {
  configPath?: string;
  readGlobalConfig?: () => Promise<GlobalConfig>;
  subscribe?: SubscribeFn;
  createWatch?: CreateWatchFn;
  log?: (message: string) => void;
  pollMs?: number;
};

type PersistedStatus = {
  kind: string;
  lastSync: string | null;
  summary: string | null;
  error: string | null;
};

type DesiredEntry = {
  id: string;
  record: StashRecord;
  providerConfig: Record<string, Record<string, string>>;
  key: string;
};

type RegistrySnapshot = {
  live: Map<string, DesiredEntry>;
  missing: Map<string, DesiredEntry>;
  tombstones: Set<string>;
};

type RunningEntry = {
  key: string;
  watch: RunningWatch;
};

async function readGlobalConfigAtPath(configPath: string): Promise<GlobalConfig> {
  return normalizeGlobalConfig(await readJsonFile(configPath, {}));
}

async function defaultCreateWatch(args: CreateWatchArgs): Promise<RunningWatch> {
  const watch = new Watch(args.stash, {
    dir: args.stash.record.path,
    onStatus: (status) => {
      void args.onStatus(status);
    },
  });
  return {
    start: async () => {
      await watch.start();
    },
    stop: async () => {
      await watch.stop();
    },
  };
}

function serializeStatus(status: WatchStatus): PersistedStatus {
  if (status.kind === "synced") {
    return {
      kind: status.kind,
      lastSync: status.lastSync.toISOString(),
      summary: status.summary,
      error: null,
    };
  }
  if (status.kind === "checked") {
    return {
      kind: status.kind,
      lastSync: status.lastSync.toISOString(),
      summary: null,
      error: null,
    };
  }
  return {
    kind: status.kind,
    lastSync: status.lastSync ? status.lastSync.toISOString() : null,
    summary: null,
    error: status.error,
  };
}

function formatLogLine(status: WatchStatus): string {
  const timestamp =
    status.kind === "error" ? new Date().toISOString() : status.lastSync.toISOString();
  if (status.kind === "synced") {
    return `${timestamp} synced ${status.summary}`;
  }
  if (status.kind === "checked") {
    return `${timestamp} checked`;
  }
  return `${timestamp} error ${status.error}`;
}

async function appendCappedLog(path: string, line: string): Promise<void> {
  const entry = `${line}\n`;
  const entryBytes = Buffer.byteLength(entry, "utf8");

  if (!existsSync(path)) {
    await writeFile(path, entry, "utf8");
    return;
  }

  const fileSize = (await stat(path)).size;
  if (fileSize + entryBytes <= MAX_LOG_BYTES) {
    await appendFile(path, entry, "utf8");
    return;
  }

  const existing = await readFile(path, "utf8");
  const lines = `${existing}${entry}`.split("\n");
  while (lines.length > 0 && Buffer.byteLength(lines.join("\n"), "utf8") > MAX_LOG_BYTES) {
    lines.shift();
  }
  await writeFile(path, lines.join("\n").replace(/^\n+/, ""), "utf8");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class BackgroundDaemon {
  private readonly configPath: string;
  private readonly stashPath: string;
  private readonly readGlobalConfigFn: () => Promise<GlobalConfig>;
  private readonly subscribeFn: SubscribeFn;
  private readonly createWatchFn: CreateWatchFn;
  private readonly log: (message: string) => void;
  private readonly pollMs: number;
  private readonly running = new Map<string, RunningEntry>();
  private readonly subscriptions: WatchSubscription[] = [];
  private started = false;
  private stopping = false;
  private reloadPromise: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: BackgroundDaemonOptions = {}) {
    this.configPath = options.configPath ?? getGlobalConfigPath();
    this.stashPath = dirname(this.configPath);
    this.readGlobalConfigFn = options.readGlobalConfig ?? (() => readGlobalConfigAtPath(this.configPath));
    this.subscribeFn = options.subscribe ?? watcher.subscribe;
    this.createWatchFn = options.createWatch ?? defaultCreateWatch;
    this.log = options.log ?? ((message) => console.log(message));
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  get watchCount(): number {
    return this.running.size;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    await mkdir(this.stashPath, { recursive: true });
    await this.installWatchers();
    await this.runStartupGc();
    await this.reload();
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.clearPollTimer();
    while (this.subscriptions.length > 0) {
      const subscription = this.subscriptions.pop();
      await subscription?.unsubscribe();
    }
    if (this.reloadPromise) {
      await this.reloadPromise;
    }

    const entries = [...this.running.entries()];
    this.running.clear();
    await Promise.all(entries.map(async ([, entry]) => entry.watch.stop()));
  }

  private schedulePoll(): void {
    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.stopping) {
        return;
      }
      void this.reload().finally(() => {
        if (!this.stopping) {
          this.schedulePoll();
        }
      });
    }, this.pollMs);
  }

  private clearPollTimer(): void {
    if (!this.pollTimer) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async installWatchers(): Promise<void> {
    for (const watchedPath of [this.configPath, this.stashPath]) {
      try {
        const subscription = await this.subscribeFn(watchedPath, (error, events) => {
          if (error) {
            this.log(`background daemon watcher failed: ${error.message}`);
            return;
          }
          if (
            watchedPath === this.configPath &&
            !events.some((event) => event.path === this.configPath)
          ) {
            return;
          }
          void this.reload();
        });
        this.subscriptions.push(subscription);
      } catch (error) {
        this.log(
          `native watcher unavailable, using poll-only reconciliation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async reload(): Promise<void> {
    if (this.reloadPromise) {
      return this.reloadPromise;
    }

    this.reloadPromise = (async () => {
      const globalConfig = normalizeGlobalConfig(await this.readGlobalConfigFn());
      const snapshot = await this.readRegistrySnapshot(globalConfig);
      const retainedIds = new Set<string>([
        ...snapshot.live.keys(),
        ...snapshot.missing.keys(),
        ...snapshot.tombstones,
      ]);

      for (const id of snapshot.tombstones) {
        await this.stopRunning(id);
        await this.deleteTombstoneDir(id);
      }

      for (const [id] of snapshot.missing) {
        await this.stopRunning(id);
        await this.persistMissingStatus(id);
      }

      for (const id of [...this.running.keys()]) {
        if (!retainedIds.has(id)) {
          await this.stopRunning(id);
        }
      }

      for (const [id, entry] of snapshot.live) {
        const current = this.running.get(id);
        if (current && current.key === entry.key) {
          continue;
        }
        if (current) {
          await this.stopRunning(id);
        }
        await this.startWatch(entry, globalConfig);
      }
    })();

    try {
      await this.reloadPromise;
    } finally {
      this.reloadPromise = null;
    }
  }

  private async startWatch(entry: DesiredEntry, globalConfig: GlobalConfig): Promise<void> {
    try {
      const stash = await Stash.load(entry.id, globalConfig, { stashPath: this.stashPath });
      const watch = await this.createWatchFn({
        stash,
        onStatus: async (status) => {
          await this.persistStatus(entry.id, status);
        },
      });
      this.running.set(entry.id, {
        key: entry.key,
        watch,
      });
      await watch.start();
      this.log(`watching ${entry.id}`);
    } catch (error) {
      this.log(
        `failed to start ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async stopRunning(id: string): Promise<void> {
    const current = this.running.get(id);
    if (!current) {
      return;
    }
    this.running.delete(id);
    await current.watch.stop();
    this.log(`stopped watching ${id}`);
  }

  private async readRegistrySnapshot(globalConfig: GlobalConfig): Promise<RegistrySnapshot> {
    const live = new Map<string, DesiredEntry>();
    const missing = new Map<string, DesiredEntry>();
    const tombstones = new Set<string>();

    for (const id of await this.listStashIds()) {
      const record = await this.readStashRecordIfExists(id);
      if (!record) {
        continue;
      }

      if (record.connections.length === 0) {
        tombstones.add(id);
        continue;
      }

      const providerConfig = Object.fromEntries(
        [...new Set(record.connections.map((connection) => connection.provider))]
          .sort((a, b) => a.localeCompare(b))
          .map((provider) => [provider, getProviderConfig(globalConfig, provider)]),
      );
      const entry = {
        id,
        record,
        providerConfig,
        key: JSON.stringify({
          record,
          providerConfig,
        }),
      } satisfies DesiredEntry;

      if (existsSync(record.path)) {
        live.set(id, entry);
      } else {
        missing.set(id, entry);
      }
    }

    return { live, missing, tombstones };
  }

  private async listStashIds(): Promise<string[]> {
    if (!(await isDirectory(this.stashPath))) {
      return [];
    }

    const entries = await readdir(this.stashPath);
    const ids: string[] = [];
    for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
      if (entry.startsWith(".")) {
        continue;
      }
      if (!(await isDirectory(join(this.stashPath, entry)))) {
        continue;
      }
      ids.push(entry);
    }
    return ids;
  }

  private async readStashRecordIfExists(id: string): Promise<StashRecord | null> {
    const path = join(getStashDirPath(id, this.stashPath), "stash.json");
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as StashRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async persistStatus(id: string, status: WatchStatus): Promise<void> {
    const stashDir = getStashDirPath(id, this.stashPath);
    await mkdir(stashDir, { recursive: true });
    await writeJsonFile(join(stashDir, "status.json"), serializeStatus(status));
    await appendCappedLog(join(stashDir, "sync.log"), formatLogLine(status));
  }

  private async persistMissingStatus(id: string): Promise<void> {
    const stashDir = getStashDirPath(id, this.stashPath);
    await mkdir(stashDir, { recursive: true });
    await writeJsonFile(join(stashDir, "status.json"), {
      kind: "missing",
      lastSync: null,
      summary: null,
      error: null,
    } satisfies PersistedStatus);
  }

  private async deleteTombstoneDir(id: string): Promise<void> {
    await withRegistryLock(
      async () => {
        const record = await this.readStashRecordIfExists(id);
        if (record && record.connections.length === 0) {
          await rm(getStashDirPath(id, this.stashPath), { recursive: true, force: true });
        }
      },
      { stashPath: this.stashPath },
    );
  }

  private async deleteOrphanDirIfOld(id: string): Promise<void> {
    await withRegistryLock(
      async () => {
        const stashDir = getStashDirPath(id, this.stashPath);
        if (!(await isDirectory(stashDir))) {
          return;
        }
        if ((await this.readStashRecordIfExists(id)) !== null) {
          return;
        }
        const ageMs = Date.now() - (await stat(stashDir)).mtimeMs;
        if (ageMs > ORPHAN_MAX_AGE_MS) {
          await rm(stashDir, { recursive: true, force: true });
        }
      },
      { stashPath: this.stashPath },
    );
  }

  private async runStartupGc(): Promise<void> {
    for (const id of await this.listStashIds()) {
      const record = await this.readStashRecordIfExists(id);
      if (!record) {
        await this.deleteOrphanDirIfOld(id);
        continue;
      }
      if (record.connections.length === 0) {
        await this.deleteTombstoneDir(id);
      }
    }
  }
}

export async function runDaemon(): Promise<void> {
  const daemon = new BackgroundDaemon();
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stop = (): void => {
    void daemon.stop().finally(() => {
      resolveDone?.();
    });
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await daemon.start();
    console.log(`background daemon started, watching ${daemon.watchCount} stash(es)`);
    await done;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
