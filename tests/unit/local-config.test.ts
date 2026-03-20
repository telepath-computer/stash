import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocalConfig } from "../../src/local-config.ts";

test("normalizeLocalConfig skips connections missing provider", () => {
  assert.deepEqual(
    normalizeLocalConfig({
      connections: {
        origin: { repo: "user/repo" },
        backup: { provider: "github", repo: "user/repo" },
      },
    }),
    {
      connections: {
        backup: { provider: "github", repo: "user/repo" },
      },
    },
  );
});
