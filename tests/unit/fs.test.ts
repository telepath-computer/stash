import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonFile } from "../../src/utils/fs.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

test("writeJsonFile writes JSON atomically with the requested mode", async () => {
  const dir = await makeTempDir("stash-fs");
  const path = join(dir, "nested", "config.json");

  try {
    await writeJsonFile(path, { hello: "world" }, { mode: 0o600 });

    assert.equal(await readFile(path, "utf8"), '{\n  "hello": "world"\n}');
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
