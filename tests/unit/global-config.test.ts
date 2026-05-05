import test from "node:test";
import assert from "node:assert/strict";
import { getGlobalConfigPath, getStashPath } from "../../src/global-config.ts";

test("stash paths prefer XDG_CONFIG_HOME when set", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/tmp/stash-xdg";

  try {
    assert.equal(getStashPath(), "/tmp/stash-xdg/stash");
    assert.equal(getGlobalConfigPath(), "/tmp/stash-xdg/stash/config.json");
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  }
});
