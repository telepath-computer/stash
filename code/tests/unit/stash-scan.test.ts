import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBuffer } from "../../src/utils/hash.ts";
import { makeStash, writeFiles } from "../helpers/make-stash.ts";

test("scan: first sync marks all visible files as added", async () => {
  const { stash } = await makeStash({
    "hello.md": "hello",
    "notes/todo.md": "buy milk",
  });
  const result = (stash as any).scan();
  assert.deepEqual([...result.added.keys()].sort(), ["hello.md", "notes/todo.md"]);
  assert.equal(result.modified.size, 0);
  assert.deepEqual(result.deleted, []);
});

test("scan: unchanged files produce empty changeset", async () => {
  const content = "hello";
  const hash = hashBuffer(Buffer.from(content, "utf8"));
  const { stash } = await makeStash(
    { "hello.md": content },
    { snapshot: { "hello.md": { hash } } },
  );
  const result = (stash as any).scan();
  assert.equal(result.added.size, 0);
  assert.equal(result.modified.size, 0);
  assert.deepEqual(result.deleted, []);
});

test("scan: modified file detected by hash mismatch", async () => {
  const oldHash = hashBuffer(Buffer.from("original", "utf8"));
  const { stash } = await makeStash(
    { "hello.md": "changed" },
    { snapshot: { "hello.md": { hash: oldHash } } },
  );
  const result = (stash as any).scan();
  assert.equal(result.modified.get("hello.md")?.type, "text");
});

test("scan: deleted file detected", async () => {
  const oldHash = hashBuffer(Buffer.from("gone", "utf8"));
  const { stash } = await makeStash({}, { snapshot: { "hello.md": { hash: oldHash } } });
  const result = (stash as any).scan();
  assert.deepEqual(result.deleted, ["hello.md"]);
});

test("scan: new file on disk is added when absent in snapshot", async () => {
  const { stash } = await makeStash(
    { "new.md": "draft" },
    { snapshot: { "existing.md": { hash: hashBuffer(Buffer.from("old", "utf8")) } } },
  );
  const result = (stash as any).scan();
  assert.equal(result.added.get("new.md")?.type, "text");
  assert.deepEqual(result.deleted, ["existing.md"]);
});

test("scan: dotfiles, symlinks, and .stash are ignored", async () => {
  const { stash, dir } = await makeStash({ "visible.md": "public" });
  await writeFiles(dir, { ".hidden": "secret", ".config/settings.json": "{}" });
  await writeFile(join(dir, ".stash", "noise.txt"), "ignored", "utf8");
  await mkdir(join(dir, "links"), { recursive: true });
  await symlink(join(dir, "visible.md"), join(dir, "links", "visible-link.md"));

  const result = (stash as any).scan();
  assert.deepEqual([...result.added.keys()], ["visible.md"]);
});

test("scan: binary file has binary FileState with modified time", async () => {
  const { stash } = await makeStash({ "image.bin": Buffer.from([0xff, 0xfe, 0x00]) });
  const state = (stash as any).scan().added.get("image.bin");
  assert.deepEqual(state?.type, "binary");
  assert.equal(typeof state?.hash, "string");
  assert.equal(typeof state?.modified, "number");
});

test("scan: nested directories preserve path", async () => {
  const { stash } = await makeStash({ "a/b/c.md": "deep" });
  const result = (stash as any).scan();
  assert.equal(result.added.get("a/b/c.md")?.type, "text");
});

test("scan: empty file detected as text with empty content", async () => {
  const { stash } = await makeStash({ "empty.md": "" });
  const result = (stash as any).scan();
  assert.deepEqual(result.added.get("empty.md"), { type: "text", content: "" });
});
