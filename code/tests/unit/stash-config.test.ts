import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeStash } from "../helpers/make-stash.ts";

test("connect writes provider connection config", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect("github", { repo: "user/repo" });

  const config = JSON.parse(
    await readFile(join(dir, ".stash", "config.local.json"), "utf8"),
  );
  assert.deepEqual(config, {
    connections: {
      github: { repo: "user/repo" },
    },
  });
});

test("disconnect removes provider connection config", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect("github", { repo: "user/repo" });
  await stash.disconnect("github");

  const config = JSON.parse(
    await readFile(join(dir, ".stash", "config.local.json"), "utf8"),
  );
  assert.deepEqual(config, { connections: {} });
});

test("connections getter reflects latest local state", async () => {
  const { stash } = await makeStash();
  await stash.connect("github", { repo: "user/repo" });
  assert.deepEqual(stash.connections, { github: { repo: "user/repo" } });
});

test("config getter merges global and local provider fields", async () => {
  const { stash } = await makeStash({}, { globalConfig: { github: { token: "t" } } });
  await stash.connect("github", { repo: "r" });
  assert.deepEqual((stash as any).config, {
    github: {
      token: "t",
      repo: "r",
    },
  });
});
