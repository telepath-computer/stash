import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Emitter } from "../../src/emitter.ts";
import { Watch, type WatchStatus } from "../../src/watch.ts";
import type { FileMutation } from "../../src/types.ts";

class FakeStash extends Emitter<{ mutation: FileMutation }> {
  connections: Record<string, Record<string, string>> = {};
  syncCalls = 0;
  runSync: (call: number, stash: FakeStash) => Promise<void> = async () => {};

  async sync(): Promise<void> {
    this.syncCalls += 1;
    await this.runSync(this.syncCalls, this);
  }
}

test("watch: performs an initial check even when no providers are connected", async () => {
  const stash = new FakeStash();
  const statuses: WatchStatus[] = [];
  const dir = "/tmp/stash-watch-initial";

  let unsubscribeCalls = 0;
  const watch = new Watch(stash as any, {
    dir,
    pollMs: 1_000,
    subscribe: async () => ({
      unsubscribe: async () => {
        unsubscribeCalls += 1;
      },
    }),
    onStatus: (status) => {
      statuses.push(status);
    },
  });

  await watch.start();
  await delay(20);
  await watch.stop();

  assert.equal(stash.syncCalls, 1);
  assert.equal(statuses[0]?.kind, "checked");
  assert.equal(unsubscribeCalls, 1);
});

test("watch: debounces filesystem events and reports a synced summary", async () => {
  const stash = new FakeStash();
  const statuses: WatchStatus[] = [];
  const dir = "/tmp/stash-watch-events";
  let onEvents:
    | ((
        error: Error | null,
        events: Array<{ path: string; type: "create" | "update" | "delete" }>,
      ) => void)
    | null = null;

  stash.connections = { github: { repo: "user/repo" } };
  stash.runSync = async (call, instance) => {
    if (call === 2) {
      instance.emit("mutation", {
        path: "notes.md",
        disk: "write",
        remote: "skip",
      });
    }
  };

  const watch = new Watch(stash as any, {
    dir,
    debounceMs: 10,
    pollMs: 1_000,
    subscribe: async (_dir, callback) => {
      onEvents = callback as typeof onEvents;
      return {
        unsubscribe: async () => {},
      };
    },
    onStatus: (status) => {
      statuses.push(status);
    },
  });

  await watch.start();
  await delay(20);
  onEvents?.(null, [{ type: "update", path: join(dir, "notes.md") }]);
  await delay(40);
  await watch.stop();

  assert.equal(stash.syncCalls, 2);
  assert.equal(statuses[0]?.kind, "checked");
  assert.equal(statuses[1]?.kind, "synced");
  assert.equal(statuses[1] && "summary" in statuses[1] ? statuses[1].summary : null, "1↓");
});

test("watch: stop waits for an in-flight sync to finish", async () => {
  const stash = new FakeStash();
  const dir = "/tmp/stash-watch-stop";
  let releaseSync: (() => void) | null = null;
  let finished = false;

  stash.connections = { github: { repo: "user/repo" } };
  stash.runSync = async () =>
    new Promise<void>((resolve) => {
      releaseSync = () => {
        finished = true;
        resolve();
      };
    });

  const watch = new Watch(stash as any, {
    dir,
    pollMs: 1_000,
    subscribe: async () => ({
      unsubscribe: async () => {},
    }),
  });

  await watch.start();
  const stopPromise = watch.stop();

  assert.equal(finished, false);
  releaseSync?.();
  await stopPromise;
  assert.equal(finished, true);
});

test("watch: falls back to poll-only when subscribe throws", async () => {
  const stash = new FakeStash();
  const statuses: WatchStatus[] = [];
  const dir = "/tmp/stash-watch-no-native";

  const watch = new Watch(stash as any, {
    dir,
    pollMs: 50,
    subscribe: async () => {
      throw new Error("inotify limit reached");
    },
    onStatus: (status) => {
      statuses.push(status);
    },
  });

  await watch.start();
  await delay(20);

  assert.equal(stash.syncCalls, 1, "initial sync should still run");
  assert.equal(statuses[0]?.kind, "checked", "should report checked status");

  await delay(80);
  assert.ok(stash.syncCalls >= 2, "poll timer should trigger additional syncs");

  await watch.stop();
});
