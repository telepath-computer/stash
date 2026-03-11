import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SyncLockError } from "../../src/errors.ts";
import { FakeProvider } from "../helpers/fake-provider.ts";
import { makeStash } from "../helpers/make-stash.ts";

function fakeRegistry(fake: FakeProvider) {
  class TestProvider {
    static spec = { setup: [], connect: [{ name: "repo", label: "Repo" }] };
    constructor() {
      return fake;
    }
  }

  return { fake: TestProvider as any };
}

function lockPath(dir: string): string {
  return join(dir, ".stash", "sync.lock");
}

function lockPayload(startedAt: string): string {
  return JSON.stringify(
    {
      pid: 99999,
      startedAt,
      hostname: "test-host",
    },
    null,
    2,
  );
}

test("sync lock: lock acquired and released on successful sync", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });

  await stash.sync();
  assert.equal(existsSync(lockPath(dir)), false);
});

test("sync lock: lock released when sync fails", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });

  fake.push = async () => {
    throw new Error("push failed");
  };

  await assert.rejects(stash.sync(), /push failed/);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("sync lock: SyncLockError when lock is held by another process", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash({}, { providers: fakeRegistry(fake) });
  await stash.connect("fake", { repo: "r" });

  await writeFile(lockPath(dir), lockPayload(new Date().toISOString()), "utf8");
  await assert.rejects(stash.sync(), SyncLockError);
});

test("sync lock: stale lock is reclaimed", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });

  const stale = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
  await writeFile(lockPath(dir), lockPayload(stale), "utf8");
  await stash.sync();
  assert.equal(existsSync(lockPath(dir)), false);
});

test("sync lock: stale reclaim race throws SyncLockError", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });

  const lock = lockPath(dir);
  const stale = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
  await writeFile(lock, lockPayload(stale), "utf8");

  const originalTryCreate = (stash as any).tryCreateSyncLock.bind(stash);
  let attempts = 0;
  (stash as any).tryCreateSyncLock = (targetPath: string, payload: string): boolean => {
    attempts += 1;
    if (attempts === 2) {
      writeFileSync(targetPath, lockPayload(new Date().toISOString()), "utf8");
      return false;
    }
    return originalTryCreate(targetPath, payload);
  };

  await assert.rejects(stash.sync(), SyncLockError);
});

test("sync lock: in-process single flight throws SyncLockError", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });

  const originalPush = fake.push.bind(fake);
  fake.push = async (payload) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await originalPush(payload);
  };

  const firstSync = stash.sync();
  await assert.rejects(stash.sync(), SyncLockError);
  await firstSync;
  assert.equal(existsSync(lockPath(dir)), false);
});
