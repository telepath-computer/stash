import test from "node:test";
import assert from "node:assert/strict";
import { hashBuffer } from "../../src/utils/hash.ts";
import { makeStash } from "../helpers/make-stash.ts";

test("computeSnapshot: adds new text file hash", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).computeSnapshot({ "a.md": { hash: "sha256-old" } }, [
    { path: "b.md", disk: "skip", remote: "write", content: "hello" },
  ]);

  assert.deepEqual(result["a.md"], { hash: "sha256-old" });
  assert.deepEqual(result["b.md"], {
    hash: hashBuffer(Buffer.from("hello", "utf8")),
  });
});

test("computeSnapshot: removes file deleted remotely (disk delete)", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).computeSnapshot(
    { "a.md": { hash: "aaa" }, "b.md": { hash: "bbb" } },
    [{ path: "b.md", disk: "delete", remote: "skip" }],
  );
  assert.deepEqual(result, { "a.md": { hash: "aaa" } });
});

test("computeSnapshot: removes file deleted locally (remote delete)", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).computeSnapshot(
    { "a.md": { hash: "aaa" }, "b.md": { hash: "bbb" } },
    [{ path: "b.md", disk: "skip", remote: "delete" }],
  );
  assert.deepEqual(result, { "a.md": { hash: "aaa" } });
});

test("computeSnapshot: updates modified text hash", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).computeSnapshot({ "a.md": { hash: "old-hash" } }, [
    { path: "a.md", disk: "write", remote: "write", content: "new content" },
  ]);
  assert.deepEqual(result["a.md"], {
    hash: hashBuffer(Buffer.from("new content", "utf8")),
  });
});

test("computeSnapshot: stores binary hash and modified", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).computeSnapshot({}, [
    {
      path: "img.png",
      disk: "write",
      remote: "write",
      source: "remote",
      hash: "abc",
      modified: 1_709_290_800_000,
    },
  ]);
  assert.deepEqual(result, {
    "img.png": { hash: "abc", modified: 1_709_290_800_000 },
  });
});

test("computeSnapshot: no mutations keeps snapshot unchanged", async () => {
  const { stash } = await makeStash();
  const oldSnapshot = { "a.md": { hash: "aaa" } };
  const result = (stash as any).computeSnapshot(oldSnapshot, []);
  assert.deepEqual(result, oldSnapshot);
});
