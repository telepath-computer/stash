import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeStash } from "../helpers/make-stash.ts";

test("integration config: connect writes config.local.json", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect("github", { repo: "user/repo" });
  const config = JSON.parse(await readFile(join(dir, ".stash", "config.local.json"), "utf8"));
  assert.deepEqual(config, {
    connections: {
      github: { repo: "user/repo" },
    },
  });
});

test("integration config: disconnect removes connection", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect("github", { repo: "user/repo" });
  await stash.disconnect("github");
  const config = JSON.parse(await readFile(join(dir, ".stash", "config.local.json"), "utf8"));
  assert.deepEqual(config, { connections: {} });
});

test("integration config: config getter merges global and local", async () => {
  const { stash } = await makeStash({}, { globalConfig: { github: { token: "t" } } });
  await stash.connect("github", { repo: "r" });
  assert.deepEqual((stash as any).config, {
    github: { token: "t", repo: "r" },
  });
});
