import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { getStashPath } from "./global-config.ts";

type RegistryLockPayload = {
  pid?: number;
  startedAt?: string;
  hostname?: string;
};

type RegistryLockOptions = {
  path?: string;
  stashPath?: string;
  retryDelayMs?: number;
  staleMs?: number;
};

const DEFAULT_RETRY_DELAY_MS = 10;
const DEFAULT_STALE_MS = 60_000;
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export function getRegistryLockPath(stashPath = getStashPath()): string {
  return `${stashPath}/.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockPayload(lockPath: string): Promise<RegistryLockPayload | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const value = JSON.parse(raw) as RegistryLockPayload;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let lockStat: Awaited<ReturnType<typeof stat>>;

  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const payload = await readLockPayload(lockPath);
  if (typeof payload?.pid === "number" && !isProcessAlive(payload.pid)) {
    return true;
  }
  const ageMs = Date.now() - lockStat.mtimeMs;
  return ageMs > staleMs;
}

function installCleanup(lockPath: string): () => void {
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  };

  const exitHandler = (): void => {
    cleanup();
  };
  process.on("exit", exitHandler);

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of SIGNALS) {
    const handler = (): void => {
      cleanup();
      process.off("exit", exitHandler);
      for (const [registeredSignal, registeredHandler] of signalHandlers) {
        process.off(registeredSignal, registeredHandler);
      }
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  return () => {
    process.off("exit", exitHandler);
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  };
}

export async function withRegistryLock<T>(
  fn: () => Promise<T>,
  options: RegistryLockOptions = {},
): Promise<T> {
  const stashPath = options.stashPath ?? getStashPath();
  const lockPath = options.path ?? getRegistryLockPath(stashPath);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const cleanupListeners = installCleanup(lockPath);

  await mkdir(stashPath, { recursive: true, mode: 0o700 });

  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
    } satisfies RegistryLockPayload,
    null,
    2,
  );

  let result: T | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  let acquired = false;

  try {
    for (;;) {
      try {
        await writeFile(lockPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        if (await isStaleLock(lockPath, staleMs)) {
          await rm(lockPath, { force: true });
          continue;
        }

        await delay(retryDelayMs);
      }
    }

    result = await fn();
  } catch (error) {
    operationError = error;
  } finally {
    if (acquired) {
      try {
        const currentPayload = readFileSync(lockPath, "utf8");
        if (currentPayload === payload) {
          unlinkSync(lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupError = error;
        }
      }
    }
    cleanupListeners();
  }

  if (operationError) {
    throw operationError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return result as T;
}
