import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MultipleConnectionsError } from "../../src/errors.ts";
import { makeStash } from "../helpers/make-stash.ts";

test("integration config: connect writes stash.json", async () => {
  const { stash, metadataDir } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  const record = JSON.parse(await readFile(join(metadataDir, "stash.json"), "utf8"));
  assert.deepEqual(record.connections, [
    {
      provider: "github",
      config: {
        name: "origin",
        repo: "user/repo",
      },
    },
  ]);
});

test("integration config: disconnect removes the stash connection", async () => {
  const { stash, metadataDir } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  await stash.disconnect("origin");
  const record = JSON.parse(await readFile(join(metadataDir, "stash.json"), "utf8"));
  assert.deepEqual(record.connections, []);
});

test("integration config: connect rejects a second connection with a different name", async () => {
  const { stash } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  await assert.rejects(
    stash.connect({ name: "backup", provider: "github", repo: "user/other" }),
    MultipleConnectionsError,
  );
});

test("integration config: connect allows reconnecting the same name", async () => {
  const { stash, metadataDir } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  await stash.connect({ name: "origin", provider: "github", repo: "user/updated" });
  const record = JSON.parse(await readFile(join(metadataDir, "stash.json"), "utf8"));
  assert.deepEqual(record.connections, [
    {
      provider: "github",
      config: {
        name: "origin",
        repo: "user/updated",
      },
    },
  ]);
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
