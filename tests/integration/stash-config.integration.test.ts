import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeStash } from "../helpers/make-stash.ts";

test("integration config: connect writes config.json", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
  assert.deepEqual(config, {
    connections: {
      origin: { provider: "github", repo: "user/repo" },
    },
  });
});

test("integration config: disconnect removes connection", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  await stash.disconnect("origin");
  const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
  assert.deepEqual(config, { connections: {} });
});

test("integration config: config getter merges global and local by provider type", async () => {
  const { stash } = await makeStash(
    {},
    {
      globalConfig: {
        providers: {
          github: { token: "t" },
          origin: { token: "wrong" },
        },
        background: {
          stashes: [],
        },
      },
    },
  );
  await stash.connect({ name: "origin", provider: "github", repo: "r" });
  assert.deepEqual((stash as any).config, {
    origin: { token: "t", provider: "github", repo: "r" },
  });
});
