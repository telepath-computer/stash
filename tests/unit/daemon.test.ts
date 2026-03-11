import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BackgroundDaemon } from "../../src/daemon.ts";
import type { GlobalConfig } from "../../src/types.ts";
import type { WatchStatus } from "../../src/watch.ts";

type ConfigEvent = {
  path: string;
  type: "create" | "update" | "delete";
};

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

test("daemon: starts registered watches, writes status.json, and hot-reloads config changes", async () => {
  const workspace = await makeTempDir("stash-daemon");
  const stashA = join(workspace, "stash-a");
  const stashB = join(workspace, "stash-b");
  const configPath = join(workspace, "config.json");
  const started: string[] = [];
    const stopped: string[] = [];
    const logs: string[] = [];
    const watchCallbacks = new Map<string, (status: WatchStatus) => Promise<void>>();
  let config: GlobalConfig = {
    providers: {},
    background: {
      stashes: [stashA],
    },
  };
  let onConfigEvent: ((error: Error | null, events: ConfigEvent[]) => void) | null = null;

  try {
    await mkdir(join(stashA, ".stash"), { recursive: true });
    await mkdir(join(stashB, ".stash"), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const daemon = new BackgroundDaemon({
      configPath,
      readGlobalConfig: async () => config,
      log: (message) => logs.push(message),
      subscribe: async (_path, callback) => {
        onConfigEvent = callback as typeof onConfigEvent;
        return {
          unsubscribe: async () => {},
        };
      },
      createWatch: async ({ dir, onStatus }) => {
        watchCallbacks.set(dir, onStatus);
        return {
          start: async () => {
            started.push(dir);
            await onStatus({
              kind: "checked",
              lastSync: new Date("2026-03-11T14:30:00.000Z"),
              nextCheck: new Date("2026-03-11T14:31:00.000Z"),
              error: null,
            });
          },
          stop: async () => {
            stopped.push(dir);
          },
        };
      },
    });

    await daemon.start();

    const statusPath = join(stashA, ".stash", "status.json");
    assert.equal(existsSync(statusPath), true);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), {
      kind: "checked",
      lastSync: "2026-03-11T14:30:00.000Z",
      summary: null,
      error: null,
    });

    const logPath = join(stashA, ".stash", "sync.log");
    assert.equal((await readFile(logPath, "utf8")).includes("checked"), true);

    config = {
      providers: {},
      background: {
        stashes: [stashB],
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    onConfigEvent?.(null, [{ type: "update", path: configPath }]);
    await delay(20);

    assert.deepEqual(started, [stashA, stashB]);
    assert.deepEqual(stopped, [stashA]);

    assert.ok(logs.some((m) => m.includes(`watching ${stashA}`)), "should log when starting a watch");
    assert.ok(logs.some((m) => m.includes(`stopped watching ${stashA}`)), "should log when stopping a watch");
    assert.ok(logs.some((m) => m.includes(`watching ${stashB}`)), "should log new watch after reload");

    await daemon.stop();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("daemon: caps sync.log at 1MB by truncating the oldest lines", async () => {
  const workspace = await makeTempDir("stash-daemon-log");
  const stashDir = join(workspace, "stash");
  const configPath = join(workspace, "config.json");
  const oldLine = "x".repeat(200);
  const oldLog = `old-start\n${`${oldLine}\n`.repeat(7_000)}old-tail\n`;

  try {
    await mkdir(join(stashDir, ".stash"), { recursive: true });
    await writeFile(join(stashDir, ".stash", "sync.log"), oldLog, "utf8");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          providers: {},
          background: {
            stashes: [stashDir],
          },
        } satisfies GlobalConfig,
        null,
        2,
      ),
      "utf8",
    );

    const daemon = new BackgroundDaemon({
      configPath,
      readGlobalConfig: async () => ({
        providers: {},
        background: {
          stashes: [stashDir],
        },
      }),
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

    const logPath = join(stashDir, ".stash", "sync.log");
    const log = await readFile(logPath, "utf8");
    assert.ok(Buffer.byteLength(log, "utf8") <= 1_000_000);
    assert.equal(log.includes("1↑ 2↓"), true);
    assert.equal(log.includes("old-start"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
