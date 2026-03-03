import test from "node:test";
import assert from "node:assert/strict";
import { makeStash } from "../helpers/make-stash.ts";

test("mergeText: three-way non-overlapping edits", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).mergeText(
    "line1\nline2\nline3",
    "LINE1\nline2\nline3",
    "line1\nline2\nLINE3",
  );
  assert.equal(result, "LINE1\nline2\nLINE3");
});

test("mergeText: overlapping edits preserves both sides", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).mergeText(
    "hello world",
    "hello brave world",
    "hello cruel world",
  );
  assert.equal(result.includes("brave"), true);
  assert.equal(result.includes("cruel"), true);
});

test("mergeText: two-way when snapshot is null", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).mergeText(null, "aaa\nbbb", "bbb\nccc");
  assert.equal(result, "bbb\nccc");
});

test("mergeText: one side unchanged", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).mergeText("original", "original", "changed");
  assert.equal(result, "changed");
});

test("mergeText: identical edits", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).mergeText("old", "new", "new");
  assert.equal(result, "new");
});

test("mergeText: empty base content", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).mergeText("", "added", "");
  assert.equal(result, "added");
});
