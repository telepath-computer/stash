import test from "node:test";
import assert from "node:assert/strict";
import { hashBuffer } from "../../src/utils/hash.ts";
import { makeStash, writeFiles } from "../helpers/make-stash.ts";

test("status: no snapshot returns all files added and null lastSync", async () => {
  const { stash } = await makeStash({ "hello.md": "hello" });
  const status = stash.status();
  assert.deepEqual(status.added, ["hello.md"]);
  assert.deepEqual(status.modified, []);
  assert.deepEqual(status.deleted, []);
  assert.equal(status.lastSync, null);
});

test("status: mixed changes and connections", async () => {
  const { stash, dir } = await makeStash(
    { "hello.md": "hello", "keep.md": "keep" },
    {
      snapshot: {
        "hello.md": { hash: hashBuffer(Buffer.from("old", "utf8")) },
        "gone.md": { hash: hashBuffer(Buffer.from("gone", "utf8")) },
        "keep.md": { hash: hashBuffer(Buffer.from("keep", "utf8")) },
      },
    },
  );

  await writeFiles(dir, { "new.md": "draft" });
  await stash.connect("github", { repo: "user/repo" });

  const status = stash.status();
  assert.deepEqual(status.added, ["new.md"]);
  assert.deepEqual(status.modified, ["hello.md"]);
  assert.deepEqual(status.deleted, ["gone.md"]);
  assert.ok(status.lastSync instanceof Date);
  assert.deepEqual(stash.connections, { github: { repo: "user/repo" } });
});

test("status: matching snapshot has no added/modified/deleted", async () => {
  const files = {
    "a.md": "a",
    "b.md": "b",
  };
  const { stash } = await makeStash(files, {
    snapshot: {
      "a.md": { hash: hashBuffer(Buffer.from("a", "utf8")) },
      "b.md": { hash: hashBuffer(Buffer.from("b", "utf8")) },
    },
  });
  const status = stash.status();
  assert.deepEqual(status.added, []);
  assert.deepEqual(status.modified, []);
  assert.deepEqual(status.deleted, []);
  assert.ok(status.lastSync instanceof Date);
});
