import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BackgroundDaemon } from "../../src/daemon.ts";
import type { GlobalConfig, StashRecord } from "../../src/types.ts";

type WatchEvent = {
  path: string;
  type: "create" | "update" | "delete";
};

type WatchCallback = (error: Error | null, events: WatchEvent[]) => void;

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

async function writeConfig(configPath: string, providers: GlobalConfig["providers"]): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ providers }, null, 2), "utf8");
}

async function writeStashRecord(
  stashPath: string,
  id: string,
  record: StashRecord,
): Promise<void> {
  await mkdir(join(stashPath, id), { recursive: true });
  await writeFile(join(stashPath, id, "stash.json"), JSON.stringify(record, null, 2), "utf8");
}

test("daemon: reconciles registry entries, restarts on tuple changes, and stops removed stashes", async () => {
  const workspace = await makeTempDir("stash-daemon-registry");
  const stashPath = join(workspace, "stash");
  const configPath = join(stashPath, "config.json");
  const dirA = join(workspace, "dir-a");
  const dirB = join(workspace, "dir-b");
  const started: string[] = [];
  const stopped: string[] = [];
  const logs: string[] = [];
  const callbacks = new Map<string, WatchCallback>();

  try {
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeConfig(configPath, {
      github: { token: "token-a" },
    });
    await writeStashRecord(stashPath, "stash-a", {
      path: dirA,
      connections: [{ provider: "github", config: { id: "user/repo-a" } }],
    });

    const daemon = new BackgroundDaemon({
      configPath,
      pollMs: 20,
      log: (message) => logs.push(message),
      subscribe: async (path, callback) => {
        callbacks.set(path, callback as WatchCallback);
        return {
          unsubscribe: async () => {
            callbacks.delete(path);
          },
        };
      },
      createWatch: async ({ stash, onStatus }) => ({
        start: async () => {
          started.push(stash.id);
          await onStatus({
            kind: "checked",
            lastSync: new Date("2026-03-11T14:30:00.000Z"),
            nextCheck: new Date("2026-03-11T14:31:00.000Z"),
            error: null,
          });
        },
        stop: async () => {
          stopped.push(stash.id);
        },
      }),
    });

    await daemon.start();

    assert.deepEqual(started, ["stash-a"]);
    assert.deepEqual(JSON.parse(await readFile(join(stashPath, "stash-a", "status.json"), "utf8")), {
      kind: "checked",
      lastSync: "2026-03-11T14:30:00.000Z",
      summary: null,
      error: null,
    });

    await writeConfig(configPath, {
      github: { token: "token-b" },
    });
    callbacks.get(configPath)?.(null, [{ type: "update", path: configPath }]);
    await delay(30);

    assert.deepEqual(started, ["stash-a", "stash-a"]);
    assert.deepEqual(stopped, ["stash-a"]);

    await writeStashRecord(stashPath, "stash-b", {
      path: dirB,
      connections: [{ provider: "github", config: { id: "user/repo-b" } }],
    });
    callbacks.get(stashPath)?.(null, [{ type: "create", path: join(stashPath, "stash-b") }]);
    await delay(30);

    assert.deepEqual(started, ["stash-a", "stash-a", "stash-b"]);

    await rm(join(stashPath, "stash-a"), { recursive: true, force: true });
    callbacks.get(stashPath)?.(null, [{ type: "delete", path: join(stashPath, "stash-a") }]);
    await delay(30);

    assert.deepEqual(stopped, ["stash-a", "stash-a"]);
    assert.ok(logs.some((message) => message.includes("watching stash-a")));
    assert.ok(logs.some((message) => message.includes("watching stash-b")));
    assert.ok(logs.some((message) => message.includes("stopped watching stash-a")));

    await daemon.stop();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("daemon: poll-only mode still reconciles new registry entries", async () => {
  const workspace = await makeTempDir("stash-daemon-poll");
  const stashPath = join(workspace, "stash");
  const configPath = join(stashPath, "config.json");
  const dirA = join(workspace, "dir-a");
  const dirB = join(workspace, "dir-b");
  const started: string[] = [];
  const logs: string[] = [];

  try {
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeConfig(configPath, {
      github: { token: "token-a" },
    });
    await writeStashRecord(stashPath, "stash-a", {
      path: dirA,
      connections: [{ provider: "github", config: { id: "user/repo-a" } }],
    });

    const daemon = new BackgroundDaemon({
      configPath,
      pollMs: 20,
      log: (message) => logs.push(message),
      subscribe: async () => {
        throw new Error("watch unavailable");
      },
      createWatch: async ({ stash, onStatus }) => ({
        start: async () => {
          started.push(stash.id);
          await onStatus({
            kind: "checked",
            lastSync: new Date("2026-03-11T14:30:00.000Z"),
            nextCheck: new Date("2026-03-11T14:31:00.000Z"),
            error: null,
          });
        },
        stop: async () => {},
      }),
    });

    await daemon.start();
    assert.deepEqual(started, ["stash-a"]);

    await writeStashRecord(stashPath, "stash-b", {
      path: dirB,
      connections: [{ provider: "github", config: { id: "user/repo-b" } }],
    });
    await delay(60);

    assert.deepEqual(started, ["stash-a", "stash-b"]);
    assert.ok(logs.some((message) => message.includes("watch unavailable")));

    await daemon.stop();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("daemon: writes missing status and revalidates tombstone deletion after stop", async () => {
  const workspace = await makeTempDir("stash-daemon-missing");
  const stashPath = join(workspace, "stash");
  const configPath = join(stashPath, "config.json");
  const liveDir = join(workspace, "live-dir");
  const missingDir = join(workspace, "missing-dir");
  const started: string[] = [];
  const stopStarted: string[] = [];
  let releaseStop: (() => void) | null = null;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });

  try {
    await mkdir(liveDir, { recursive: true });
    await writeConfig(configPath, {
      github: { token: "token-a" },
    });
    await writeStashRecord(stashPath, "missing-stash", {
      path: missingDir,
      connections: [{ provider: "github", config: { id: "user/missing" } }],
    });
    await writeStashRecord(stashPath, "live-stash", {
      path: liveDir,
      connections: [{ provider: "github", config: { id: "user/live" } }],
    });

    const daemon = new BackgroundDaemon({
      configPath,
      pollMs: 20,
      subscribe: async () => ({
        unsubscribe: async () => {},
      }),
      createWatch: async ({ stash, onStatus }) => ({
        start: async () => {
          started.push(stash.id);
          await onStatus({
            kind: "checked",
            lastSync: new Date("2026-03-11T14:30:00.000Z"),
            nextCheck: new Date("2026-03-11T14:31:00.000Z"),
            error: null,
          });
        },
        stop: async () => {
          stopStarted.push(stash.id);
          await stopGate;
        },
      }),
    });

    await daemon.start();

    assert.deepEqual(started, ["live-stash"]);
    assert.deepEqual(
      JSON.parse(await readFile(join(stashPath, "missing-stash", "status.json"), "utf8")),
      {
        kind: "missing",
        lastSync: null,
        summary: null,
        error: null,
      },
    );

    await writeStashRecord(stashPath, "live-stash", {
      path: liveDir,
      connections: [],
    });
    await delay(40);

    assert.deepEqual(stopStarted, ["live-stash"]);

    await writeStashRecord(stashPath, "live-stash", {
      path: liveDir,
      connections: [{ provider: "github", config: { id: "user/live" } }],
    });
    releaseStop?.();
    await delay(80);

    assert.equal(existsSync(join(stashPath, "live-stash")), true);
    assert.deepEqual(started, ["live-stash", "live-stash"]);

    await daemon.stop();
  } finally {
    releaseStop?.();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("daemon: startup GC removes old incomplete dirs and keeps fresh incomplete dirs", async () => {
  const workspace = await makeTempDir("stash-daemon-gc");
  const stashPath = join(workspace, "stash");
  const configPath = join(stashPath, "config.json");
  const oldDir = join(stashPath, "old-orphan");
  const freshDir = join(stashPath, "fresh-orphan");

  try {
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    const oldDate = new Date(Date.now() - 10 * 60_000);
    await utimes(oldDir, oldDate, oldDate);
    await writeConfig(configPath, {});

    const daemon = new BackgroundDaemon({
      configPath,
      pollMs: 20,
      subscribe: async () => ({
        unsubscribe: async () => {},
      }),
      createWatch: async () => {
        throw new Error("no watches expected");
      },
    });

    await daemon.start();
    await daemon.stop();

    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(freshDir), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("daemon: caps sync.log at 1MB under per-stash metadata dirs", async () => {
  const workspace = await makeTempDir("stash-daemon-log");
  const stashPath = join(workspace, "stash");
  const configPath = join(stashPath, "config.json");
  const liveDir = join(workspace, "live-dir");
  const oldLine = "x".repeat(200);
  const oldLog = `old-start\n${`${oldLine}\n`.repeat(7_000)}old-tail\n`;

  try {
    await mkdir(liveDir, { recursive: true });
    await writeConfig(configPath, {
      github: { token: "token-a" },
    });
    await writeStashRecord(stashPath, "live-stash", {
      path: liveDir,
      connections: [{ provider: "github", config: { id: "user/live" } }],
    });
    await writeFile(join(stashPath, "live-stash", "sync.log"), oldLog, "utf8");

    const daemon = new BackgroundDaemon({
      configPath,
      pollMs: 20,
      subscribe: async () => ({
        unsubscribe: async () => {},
      }),
      createWatch: async ({ onStatus }) => ({
        start: async () => {
          await onStatus({
            kind: "synced",
            summary: "1↑ 2↓",
            lastSync: new Date("2026-03-11T14:30:00.000Z"),
            nextCheck: new Date("2026-03-11T14:31:00.000Z"),
            error: null,
          });
        },
        stop: async () => {},
      }),
    });

    await daemon.start();
    await daemon.stop();

    const logPath = join(stashPath, "live-stash", "sync.log");
    const log = await readFile(logPath, "utf8");
    assert.ok(Buffer.byteLength(log, "utf8") <= 1_000_000);
    assert.equal(log.includes("1↑ 2↓"), true);
    assert.equal(log.includes("old-start"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
