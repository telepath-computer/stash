import test from "node:test";
import assert from "node:assert/strict";
import { isValidText } from "../../src/utils/text.ts";

test("isValidText: valid UTF-8 string", () => {
  assert.equal(isValidText(Buffer.from("hello", "utf8")), true);
});

test("isValidText: ASCII bytes", () => {
  assert.equal(isValidText(Buffer.from([0x41, 0x42, 0x43])), true);
});

test("isValidText: multi-byte UTF-8", () => {
  assert.equal(isValidText(Buffer.from("hello 世界 👋", "utf8")), true);
});

test("isValidText: invalid sequence", () => {
  assert.equal(isValidText(Buffer.from([0xff, 0xfe])), false);
});

test("isValidText: latin1 bytes are invalid UTF-8", () => {
  assert.equal(isValidText(Buffer.from([0xe9])), false);
});

test("isValidText: empty buffer is text", () => {
  assert.equal(isValidText(Buffer.alloc(0)), true);
});

test("isValidText: null bytes treated as binary", () => {
  assert.equal(isValidText(Buffer.from([0x61, 0x00, 0x62])), false);
});
