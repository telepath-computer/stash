import watcher from "@parcel/watcher";
import { DisposableGroup, type Disposable } from "@rupertsworld/disposable";
import { lstatSync } from "node:fs";
import { relative } from "node:path";
import { Stash } from "./stash.ts";
import { isTrackedPath } from "./utils/is-tracked-path.ts";
import { formatCountdown } from "./ui/format.ts";
import { LiveLine } from "./ui/live-line.ts";
import { SyncRenderer } from "./ui/sync-renderer.ts";

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_POLL_MS = 30_000;
const CTRL_C = "\u0003";

export type WatchState = "idle" | "debouncing" | "syncing";

type WatchOptions = {
  dir?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  debounceMs?: number;
  pollMs?: number;
};

type WatchStatus =
  | { kind: "synced"; summary: string; nextCheck: Date }
  | { kind: "checked"; nextCheck: Date }
  | { kind: "error"; message: string; nextCheck: Date };

function asDisposable(dispose: () => void): Disposable {
  return { dispose };
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

export async function watch(stash: Stash, options: WatchOptions = {}): Promise<void> {
  if (Object.keys(stash.connections).length === 0) {
    throw new Error("no connection configured — run `stash connect <provider>` first");
  }

  const dir = options.dir ?? process.cwd();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const resources = new DisposableGroup();
  const line = resources.add(new LiveLine(stdout));
  const { dim, green, red } = line.colors;

  let state: WatchState = "idle";
  let pendingEvents = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let tickTimer: NodeJS.Timeout | null = null;
  let syncPromise: Promise<void> | null = null;
  let subscription: Awaited<ReturnType<typeof watcher.subscribe>> | null = null;
  let shuttingDown = false;
  let status: WatchStatus | null = null;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const interactive = stdin.isTTY && stdout.isTTY;

  const renderStatus = (): void => {
    if (!stdout.isTTY || state === "syncing" || !status) {
      return;
    }
    const countdown = dim(`checking in ${formatCountdown(status.nextCheck)}`);
    if (status.kind === "synced") {
      line.update(`${green("●")} ${status.summary} ${dim("·")} ${countdown}`);
      return;
    }
    if (status.kind === "error") {
      line.update(
        `${red("✗")} sync failed: ${status.message} ${dim("·")} ${dim(`retrying in ${formatCountdown(status.nextCheck)}`)}`,
      );
      return;
    }
    line.update(`${green("●")} ${dim("up to date")} ${dim("·")} ${countdown}`);
  };

  const clearDebounceTimer = (): void => {
    if (!debounceTimer) {
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const clearPollTimer = (): void => {
    if (!pollTimer) {
      return;
    }
    clearTimeout(pollTimer);
    pollTimer = null;
  };

  let nextCheckAt: Date = new Date(Date.now() + pollMs);

  const schedulePoll = (): void => {
    clearPollTimer();
    nextCheckAt = new Date(Date.now() + pollMs);
    pollTimer = setTimeout(() => {
      if (shuttingDown) {
        return;
      }
      if (state === "idle") {
        startSync();
      }
    }, pollMs);
  };

  const startDebounce = (): void => {
    clearDebounceTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (shuttingDown || state !== "debouncing") {
        return;
      }
      startSync();
    }, debounceMs);
  };

  const startSync = (): void => {
    if (shuttingDown || state === "syncing") {
      return;
    }
    clearDebounceTimer();
    state = "syncing";
    pendingEvents = false;

    syncPromise = (async () => {
      const renderer = new SyncRenderer(line);
      const sub = stash.on("mutation", (mutation) => {
        renderer.onMutation(mutation);
      });
      line.startSpinner("checking...");

      try {
        await stash.sync();
        const summary = renderer.done();

        schedulePoll();

        if (summary) {
          status = { kind: "synced", summary, nextCheck: nextCheckAt };
          if (!stdout.isTTY) {
            line.print(`✓ synced (${summary})`);
          }
        } else {
          status = { kind: "checked", nextCheck: nextCheckAt };
          if (!stdout.isTTY) {
            line.print("✓ up to date");
          }
        }

        if (pendingEvents) {
          state = "debouncing";
          startDebounce();
        } else {
          state = "idle";
        }

        renderStatus();
      } catch (error) {
        renderer.error(error as Error);
        state = "idle";
        schedulePoll();
        const message = error instanceof Error ? error.message : String(error);
        status = { kind: "error", message, nextCheck: nextCheckAt };
        if (stdout.isTTY) {
          renderStatus();
        } else {
          line.print(`${red("✗")} sync failed: ${message}`);
        }
      } finally {
        sub.dispose();
        renderer.dispose();
      }
    })();

    syncPromise.finally(() => {
      syncPromise = null;
    });
  };

  const queueFilesystemEvent = (): void => {
    if (shuttingDown) {
      return;
    }
    if (state === "syncing") {
      pendingEvents = true;
      return;
    }
    state = "debouncing";
    startDebounce();
  };

  const requestStop = (force: boolean): void => {
    if (shuttingDown) {
      if (force && syncPromise) {
        process.exit(130);
      }
      return;
    }
    shuttingDown = true;
    clearDebounceTimer();
    clearPollTimer();

    void (async () => {
      if (subscription) {
        await subscription.unsubscribe();
      }
      if (syncPromise) {
        await syncPromise;
      }
      if (interactive) {
        stdin.setRawMode?.(false);
      }
      line.print(dim(`stopped watching ${dir}`));
      resources.dispose();
      if (resolveDone) {
        resolveDone();
      }
    })();
  };

  subscription = await watcher.subscribe(dir, (error, events) => {
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      schedulePoll();
      status = { kind: "error", message, nextCheck: nextCheckAt };
      if (stdout.isTTY) {
        renderStatus();
      } else {
        line.print(`${red("✗")} watcher error: ${message}`);
      }
      return;
    }

    for (const event of events) {
      const relPath = eventPath(dir, event.path);
      if (!relPath) {
        continue;
      }
      if (event.type !== "delete" && isSymlink(event.path)) {
        continue;
      }
      queueFilesystemEvent();
      break;
    }
  });
  resources.add(
    asDisposable(() => {
      if (subscription) {
        void subscription.unsubscribe();
      }
    }),
  );

  if (interactive) {
    stdin.setRawMode?.(true);
    stdin.resume();
    const onData = (chunk: Buffer): void => {
      for (const key of chunk.toString("utf8")) {
        if (key === "." && !shuttingDown) {
          if (state === "debouncing") {
            clearDebounceTimer();
          }
          if (state === "syncing") {
            pendingEvents = true;
            continue;
          }
          startSync();
          continue;
        }
        if (key === "q") {
          requestStop(false);
          return;
        }
        if (key === CTRL_C) {
          requestStop(true);
        }
      }
    };
    stdin.on("data", onData);
    resources.add(
      asDisposable(() => {
        stdin.off("data", onData);
      }),
    );
  }

  const onSigInt = (): void => {
    requestStop(true);
  };
  process.on("SIGINT", onSigInt);
  resources.add(
    asDisposable(() => {
      process.off("SIGINT", onSigInt);
    }),
  );

  if (stdout.isTTY) {
    tickTimer = setInterval(() => {
      renderStatus();
    }, 1_000);
    resources.add(
      asDisposable(() => {
        if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
      }),
    );
  }

  line.print(dim(`watching ${dir} (. to sync, q to quit)`));
  startSync();
  await done;
}
