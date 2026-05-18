import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ensureStashDirPath,
  getGlobalConfigPath,
  getStashDirPath,
  getStashPath,
  writeGlobalConfig,
} from "../../src/global-config.ts";
import { getRegistryLockPath, withRegistryLock } from "../../src/registry-lock.ts";

async function makeTempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

async function withTempHome<T>(prefix: string, run: (home: string) => Promise<T>): Promise<T> {
  const home = await makeTempHome(prefix);
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;

  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test("stash layout: global config writes under ~/.stash with 0700 root, 0600 config, and provider-only JSON", async () => {
  await withTempHome("stash-layout-config", async (home) => {
    await writeGlobalConfig({
      providers: {
        github: { token: "secret" },
      },
      background: {
        stashes: ["/tmp/ignored-by-new-layout"],
      },
    });

    const stashPath = join(home, ".stash");
    const configPath = join(stashPath, "config.json");

    assert.equal(getStashPath(), stashPath);
    assert.equal(getGlobalConfigPath(), configPath);
    assert.equal((await stat(stashPath)).mode & 0o777, 0o700);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      providers: {
        github: { token: "secret" },
      },
    });
  });
});

test("stash layout: per-stash metadata directories live under ~/.stash keyed by ULID", async () => {
  await withTempHome("stash-layout-dir", async (home) => {
    const id = "01HF7E2K3Y4Z5N8M9PQRSTVWXY";
    const stashDir = await ensureStashDirPath(id);

    assert.equal(stashDir, join(home, ".stash", id));
    assert.equal(getStashDirPath(id), stashDir);
    assert.equal(basename(stashDir), id);
    assert.equal(existsSync(stashDir), true);
    assert.equal((await stat(stashDir)).mode & 0o777, 0o700);
  });
});

test("stash layout: withRegistryLock uses ~/.stash/.lock and serializes callers", async () => {
  await withTempHome("stash-layout-lock", async (home) => {
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withRegistryLock(async () => {
      events.push("first:start");
      assert.equal(getRegistryLockPath(), join(home, ".stash", ".lock"));
      assert.equal(existsSync(getRegistryLockPath()), true);
      assert.equal((await stat(getRegistryLockPath())).mode & 0o777, 0o600);
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
    assert.equal(existsSync(getRegistryLockPath()), false);
  });
});

test("stash layout: withRegistryLock reclaims a lock older than 60 seconds", async () => {
  await withTempHome("stash-layout-stale", async () => {
    const lockPath = getRegistryLockPath();
    await mkdir(getStashPath(), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "test-host",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const old = new Date(Date.now() - 2 * 60_000);
    await utimes(lockPath, old, old);

    let acquired = false;
    await withRegistryLock(async () => {
      acquired = true;
    });

    assert.equal(acquired, true);
    assert.equal(existsSync(lockPath), false);
  });
});
