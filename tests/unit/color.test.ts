import test from "node:test";
import assert from "node:assert/strict";
import { createColors } from "../../src/ui/color.ts";

test("color: wraps text in ANSI codes when isTTY is true", () => {
  const colors = createColors({ isTTY: true } as NodeJS.WriteStream);
  assert.match(colors.dim("hello"), /\x1b\[/);
  assert.match(colors.yellow("hello"), /\x1b\[/);
  assert.match(colors.green("hello"), /\x1b\[/);
  assert.match(colors.red("hello"), /\x1b\[/);
});

test("color: returns plain text when isTTY is false", () => {
  const colors = createColors({ isTTY: false } as NodeJS.WriteStream);
  assert.equal(colors.dim("hello"), "hello");
  assert.equal(colors.yellow("hello"), "hello");
  assert.equal(colors.green("hello"), "hello");
  assert.equal(colors.red("hello"), "hello");
});

test("color: returns plain text when isTTY is undefined", () => {
  const colors = createColors({} as NodeJS.WriteStream);
  assert.equal(colors.dim("hello"), "hello");
});
