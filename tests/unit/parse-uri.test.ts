import test from "node:test";
import assert from "node:assert/strict";
import { InvalidUriError } from "../../src/errors.ts";
import { parseUri } from "../../src/uri.ts";

test("parseUri splits on the first colon", () => {
  assert.deepEqual(parseUri("github:owner/repo"), {
    provider: "github",
    config: { id: "owner/repo" },
  });
});

test("parseUri preserves additional colons in the id", () => {
  assert.deepEqual(parseUri("s3:bucket/prefix:with:colon"), {
    provider: "s3",
    config: { id: "bucket/prefix:with:colon" },
  });
});

test("parseUri throws when the uri is missing a colon", () => {
  assert.throws(() => parseUri("github"), InvalidUriError);
});
