import test from "node:test";
import assert from "node:assert/strict";
import { isTrackedPath } from "../../src/utils/is-tracked-path.ts";

test("isTrackedPath: regular file path is tracked", () => {
  assert.equal(isTrackedPath("notes.md"), true);
});

test("isTrackedPath: dotfile is ignored", () => {
  assert.equal(isTrackedPath(".hidden"), false);
});

test("isTrackedPath: dot-directory path is ignored", () => {
  assert.equal(isTrackedPath(".config/settings.json"), false);
});

test("isTrackedPath: .stash path is ignored", () => {
  assert.equal(isTrackedPath(".stash/snapshot.json"), false);
});

test("isTrackedPath: nested regular path is tracked", () => {
  assert.equal(isTrackedPath("a/b/c.md"), true);
});
