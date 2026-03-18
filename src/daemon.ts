import watcher from "@parcel/watcher";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getGlobalConfigPath, normalizeGlobalConfig, readGlobalConfig } from "./global-config.ts";
import { Stash } from "./stash.ts";
import type { GlobalConfig } from "./types.ts";
import { Watch, type WatchStatus } from "./watch.ts";

const MAX_LOG_BYTES = 1_000_000;

type SubscribeFn = typeof watcher.subscribe;
type ConfigSubscription = Awaited<ReturnType<typeof watcher.subscribe>>;

type RunningWatch = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

type CreateWatchArgs = {
  dir: string;
  globalConfig: GlobalConfig;
  onStatus: (status: WatchStatus) => Promise<void>;
};

type CreateWatchFn = (args: CreateWatchArgs) => Promise<RunningWatch>;

type BackgroundDaemonOptions = {
  configPath?: string;
  readGlobalConfig?: () => Promise<GlobalConfig>;
  subscribe?: SubscribeFn;
  createWatch?: CreateWatchFn;
  log?: (message: string) => void;
};

type PersistedWatchStatus = {
  kind: WatchStatus["kind"];
  lastSync: string | null;
  summary: string | null;
  error: string | null;
};

async function defaultCreateWatch(args: CreateWatchArgs): Promise<RunningWatch> {
  const stash = await Stash.load(args.dir, args.globalConfig);
  const watch = new Watch(stash, {
    dir: args.dir,
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

function serializeStatus(status: WatchStatus): PersistedWatchStatus {
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

export class BackgroundDaemon {
  private readonly configPath: string;
  private readonly readGlobalConfigFn: () => Promise<GlobalConfig>;
  private readonly subscribeFn: SubscribeFn;
  private readonly createWatchFn: CreateWatchFn;
  private readonly log: (message: string) => void;
  private readonly running = new Map<string, RunningWatch>();
  private configSubscription: ConfigSubscription | null = null;
  private started = false;
  private stopping = false;
  private reloadPromise: Promise<void> | null = null;

  constructor(options: BackgroundDaemonOptions = {}) {
    this.configPath = options.configPath ?? getGlobalConfigPath();
    this.readGlobalConfigFn = options.readGlobalConfig ?? readGlobalConfig;
    this.subscribeFn = options.subscribe ?? watcher.subscribe;
    this.createWatchFn = options.createWatch ?? defaultCreateWatch;
    this.log = options.log ?? ((message) => console.log(message));
  }

  get watchCount(): number {
    return this.running.size;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      this.configSubscription = await this.subscribeFn(
        dirname(this.configPath),
        (error, events) => {
          if (error) {
            this.log(`background daemon config watch failed: ${error.message}`);
            return;
          }
          if (!events.some((event) => event.path === this.configPath)) {
            return;
          }
          void this.reload();
        },
      );
    } catch (error) {
      this.log(
        `native config watcher unavailable, config hot-reload disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.reload();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    if (this.configSubscription) {
      await this.configSubscription.unsubscribe();
      this.configSubscription = null;
    }
    if (this.reloadPromise) {
      await this.reloadPromise;
    }

    const entries = [...this.running.entries()];
    this.running.clear();
    await Promise.all(entries.map(async ([, watchHandle]) => watchHandle.stop()));
  }

  private async reload(): Promise<void> {
    if (this.reloadPromise) {
      return this.reloadPromise;
    }

    this.reloadPromise = (async () => {
      const config = normalizeGlobalConfig(await this.readGlobalConfigFn());
      const desired = new Set(config.background.stashes);

      for (const [dir, watchHandle] of [...this.running.entries()]) {
        if (desired.has(dir)) {
          continue;
        }
        this.running.delete(dir);
        await watchHandle.stop();
        this.log(`stopped watching ${dir}`);
      }

      for (const dir of desired) {
        if (this.running.has(dir)) {
          continue;
        }
        try {
          const watchHandle = await this.createWatchFn({
            dir,
            globalConfig: config,
            onStatus: async (status) => {
              await this.persistStatus(dir, status);
            },
          });
          this.running.set(dir, watchHandle);
          await watchHandle.start();
          this.log(`watching ${dir}`);
        } catch (error) {
          this.log(
            `failed to start ${dir}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();

    try {
      await this.reloadPromise;
    } finally {
      this.reloadPromise = null;
    }
  }

  private async persistStatus(dir: string, status: WatchStatus): Promise<void> {
    const stashDir = join(dir, ".stash");
    if (!existsSync(stashDir)) {
      return;
    }

    await mkdir(stashDir, { recursive: true });
    await writeFile(
      join(stashDir, "status.json"),
      JSON.stringify(serializeStatus(status), null, 2),
      "utf8",
    );
    await appendCappedLog(join(stashDir, "sync.log"), formatLogLine(status));
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
