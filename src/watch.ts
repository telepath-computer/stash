import watcher from "@parcel/watcher";
import type { Disposable } from "@rupertsworld/disposable";
import { lstatSync } from "node:fs";
import { relative } from "node:path";
import { Stash } from "./stash.ts";
import type { FileMutation } from "./types.ts";
import { isTrackedPath } from "./utils/is-tracked-path.ts";
import { formatSummary } from "./ui/format.ts";
import { LiveLine } from "./ui/live-line.ts";
import { WatchRenderer } from "./ui/watch-renderer.ts";

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_POLL_MS = 10_000;
const CTRL_C = "\u0003";

export type WatchState = "idle" | "debouncing" | "syncing";
type SubscribeFn = typeof watcher.subscribe;
type Cleanup = Disposable | (() => void) | void;
type WatchSubscription = Awaited<ReturnType<typeof watcher.subscribe>>;

export type WatchStatus =
  | { kind: "synced"; summary: string; nextCheck: Date; lastSync: Date; error: null }
  | { kind: "checked"; nextCheck: Date; lastSync: Date; error: null }
  | { kind: "error"; nextCheck: Date; lastSync: Date | null; error: string };

export type WatchOptions = {
  dir?: string;
  debounceMs?: number;
  pollMs?: number;
  subscribe?: SubscribeFn;
  onSyncStart?: (stash: Stash) => Cleanup;
  onStatus?: (status: WatchStatus) => void;
};

type InteractiveWatchOptions = WatchOptions & {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
};

function disposeCleanup(cleanup: Cleanup): void {
  if (!cleanup) {
    return;
  }
  if (typeof cleanup === "function") {
    cleanup();
    return;
  }
  cleanup.dispose();
}

function eventPath(dir: string, absolutePath: string): string | null {
  const relPath = relative(dir, absolutePath).split("\\").join("/");
  if (!relPath || relPath === "." || relPath.startsWith("../")) {
    return null;
  }
  if (!isTrackedPath(relPath)) {
    return null;
  }
  return relPath;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export class Watch {
  private readonly stash: Stash;
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly subscribeFn: SubscribeFn;
  private readonly onSyncStart?: (stash: Stash) => Cleanup;
  private readonly onStatus?: (status: WatchStatus) => void;
  private doneResolve: (() => void) | null = null;
  private readonly donePromise = new Promise<void>((resolve) => {
    this.doneResolve = resolve;
  });
  private stateValue: WatchState = "idle";
  private started = false;
  private stopping = false;
  private pendingEvents = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private subscription: WatchSubscription | null = null;
  private syncPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastSuccessfulSync: Date | null = null;
  private nextCheckAt: Date = new Date(Date.now() + DEFAULT_POLL_MS);

  constructor(stash: Stash, options: WatchOptions = {}) {
    this.stash = stash;
    this.dir = options.dir ?? process.cwd();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.subscribeFn = options.subscribe ?? watcher.subscribe;
    this.onSyncStart = options.onSyncStart;
    this.onStatus = options.onStatus;
  }

  get state(): WatchState {
    return this.stateValue;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    try {
      this.subscription = await this.subscribeFn(this.dir, (error, events) => {
        if (error) {
          this.schedulePoll();
          this.onStatus?.({
            kind: "error",
            error: error instanceof Error ? error.message : String(error),
            lastSync: this.lastSuccessfulSync,
            nextCheck: this.nextCheckAt,
          });
          return;
        }

        for (const event of events) {
          const relPath = eventPath(this.dir, event.path);
          if (!relPath) {
            continue;
          }
          if (event.type !== "delete" && isSymlink(event.path)) {
            continue;
          }
          this.queueFilesystemEvent();
          break;
        }
      });
    } catch {
      // Native FS watcher unavailable (e.g. Docker, missing inotify).
      // Continue in poll-only mode — schedulePoll will still fire.
    }

    this.startSync();
  }

  wait(): Promise<void> {
    return this.donePromise;
  }

  triggerSync(): void {
    if (this.stopping) {
      return;
    }
    if (this.stateValue === "debouncing") {
      this.clearDebounceTimer();
    }
    if (this.stateValue === "syncing") {
      this.pendingEvents = true;
      return;
    }
    this.startSync();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopping = true;
    this.clearDebounceTimer();
    this.clearPollTimer();
    this.stopPromise = (async () => {
      if (this.subscription) {
        await this.subscription.unsubscribe();
        this.subscription = null;
      }
      if (this.syncPromise) {
        await this.syncPromise;
      }
      if (this.doneResolve) {
        this.doneResolve();
        this.doneResolve = null;
      }
    })();

    return this.stopPromise;
  }

  private clearDebounceTimer(): void {
    if (!this.debounceTimer) {
      return;
    }
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private clearPollTimer(): void {
    if (!this.pollTimer) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private schedulePoll(): void {
    this.clearPollTimer();
    this.nextCheckAt = new Date(Date.now() + this.pollMs);
    this.pollTimer = setTimeout(() => {
      if (this.stopping) {
        return;
      }
      if (this.stateValue === "idle") {
        this.startSync();
      }
    }, this.pollMs);
  }

  private startDebounce(): void {
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopping || this.stateValue !== "debouncing") {
        return;
      }
      this.startSync();
    }, this.debounceMs);
  }

  private startSync(): void {
    if (this.stopping || this.stateValue === "syncing") {
      return;
    }
    this.clearDebounceTimer();
    this.stateValue = "syncing";
    this.pendingEvents = false;

    const mutations: FileMutation[] = [];
    const mutationSubscription = this.stash.on("mutation", (mutation) => {
      mutations.push(mutation);
    });
    const cleanup = this.onSyncStart?.(this.stash);

    this.syncPromise = (async () => {
      try {
        await this.stash.sync();
        const completedAt = new Date();
        this.lastSuccessfulSync = completedAt;
        this.schedulePoll();
        const summary = formatSummary(mutations);
        if (summary) {
          this.onStatus?.({
            kind: "synced",
            summary,
            nextCheck: this.nextCheckAt,
            lastSync: completedAt,
            error: null,
          });
        } else {
          this.onStatus?.({
            kind: "checked",
            nextCheck: this.nextCheckAt,
            lastSync: completedAt,
            error: null,
          });
        }

        if (this.pendingEvents) {
          this.stateValue = "debouncing";
          this.startDebounce();
        } else {
          this.stateValue = "idle";
        }
      } catch (error) {
        this.stateValue = "idle";
        this.schedulePoll();
        const message = error instanceof Error ? error.message : String(error);
        this.onStatus?.({
          kind: "error",
          error: message,
          nextCheck: this.nextCheckAt,
          lastSync: this.lastSuccessfulSync,
        });
      } finally {
        mutationSubscription.dispose();
        disposeCleanup(cleanup);
      }
    })();

    this.syncPromise.finally(() => {
      this.syncPromise = null;
    });
  }

  private queueFilesystemEvent(): void {
    if (this.stopping) {
      return;
    }
    if (this.stateValue === "syncing") {
      this.pendingEvents = true;
      return;
    }
    this.stateValue = "debouncing";
    this.startDebounce();
  }
}

export async function watch(stash: Stash, options: InteractiveWatchOptions = {}): Promise<void> {
  if (Object.keys(stash.connections).length === 0) {
    throw new Error("no connection configured — run `stash connect <provider> <name>` first");
  }

  const dir = options.dir ?? process.cwd();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const interactive = stdin.isTTY && stdout.isTTY;
  const line = new LiveLine(stdout);
  const renderer = new WatchRenderer(line, dir, stdout.isTTY);
  let lastStatus: WatchStatus | null = null;
  const watchInstance = new Watch(stash, {
    ...options,
    dir,
    onSyncStart: (currentStash) => renderer.startSync(currentStash),
    onStatus: (status) => {
      lastStatus = status;
      renderer.onStatus(status);
    },
  });

  let stopPromise: Promise<void> | null = null;
  const requestStop = (): void => {
    if (!stopPromise) {
      stopPromise = watchInstance.stop();
    }
  };

  const onData = (chunk: Buffer): void => {
    for (const key of chunk.toString("utf8")) {
      if (key === ".") {
        watchInstance.triggerSync();
        continue;
      }
      if (key === "q" || key === CTRL_C) {
        requestStop();
        return;
      }
    }
  };
  const onSigInt = (): void => {
    requestStop();
  };

  let tickTimer: NodeJS.Timeout | null = null;
  try {
    if (interactive) {
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onData);
    }
    process.on("SIGINT", onSigInt);

    if (stdout.isTTY) {
      tickTimer = setInterval(() => {
        if (lastStatus && watchInstance.state !== "syncing") {
          renderer.onStatus(lastStatus);
        }
      }, 1_000);
    }

    renderer.printWatching();
    await watchInstance.start();
    await watchInstance.wait();
    renderer.printStopped();
  } finally {
    if (tickTimer) {
      clearInterval(tickTimer);
    }
    if (interactive) {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
    }
    process.off("SIGINT", onSigInt);
    renderer.dispose();
  }
}
