import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStashDirPath } from "../../src/global-config.ts";
import { Stash } from "../../src/stash.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

async function withTempHome<T>(prefix: string, run: (home: string) => Promise<T>): Promise<T> {
  const home = await makeTempDir(prefix);
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

test("stash factories: create writes stash.json under ~/.stash/<ulid> and load reads it back", async () => {
  await withTempHome("stash-factory", async () => {
    const dir = await makeTempDir("stash-local");
    const globalConfig = { providers: {}, background: { stashes: [] } };
    const record = {
      path: dir,
      connections: [{ provider: "github", config: { id: "user/repo" } }],
    };

    try {
      const created = await Stash.create(record, globalConfig);

      assert.match(created.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(existsSync(join(dir, ".stash")), false);

      const stashDir = getStashDirPath(created.id);
      assert.equal(existsSync(stashDir), true);
      assert.deepEqual(JSON.parse(await readFile(join(stashDir, "stash.json"), "utf8")), record);

      const loaded = await Stash.load(created.id, globalConfig);
      assert.equal(loaded.id, created.id);
      assert.deepEqual(loaded.record, record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
