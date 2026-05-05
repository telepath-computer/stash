import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRegistryLockPath, withRegistryLock } from "../../src/registry-lock.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

test("withRegistryLock creates a 0600 lock file and releases it after the callback", async () => {
  const xdg = await makeTempDir("stash-lock");
  const previous = process.env.XDG_CONFIG_HOME;

  process.env.XDG_CONFIG_HOME = xdg;

  try {
    const seenPayloads: string[] = [];

    await withRegistryLock(async () => {
      const lockPath = getRegistryLockPath();
      assert.equal(existsSync(lockPath), true);
      assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
      seenPayloads.push(await readFile(lockPath, "utf8"));
    });

    assert.equal(seenPayloads.length, 1);
    assert.equal(existsSync(getRegistryLockPath()), false);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
    await rm(xdg, { recursive: true, force: true });
  }
});

test("withRegistryLock serializes concurrent callers", async () => {
  const xdg = await makeTempDir("stash-lock-serial");
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;

  try {
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withRegistryLock(async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = withRegistryLock(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(events, ["first:start"]);

    releaseFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
    await rm(xdg, { recursive: true, force: true });
  }
});

test("withRegistryLock reclaims a stale lock left by a dead process", async () => {
  const xdg = await makeTempDir("stash-lock-stale");
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;

  try {
    const lockPath = getRegistryLockPath();
    await mkdir(join(xdg, "stash"), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify(
        {
          pid: 999_999,
          startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          hostname: "test-host",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    let acquired = false;
    await withRegistryLock(async () => {
      acquired = true;
      assert.equal(existsSync(lockPath), true);
    });

    assert.equal(acquired, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
    await rm(xdg, { recursive: true, force: true });
  }
});
