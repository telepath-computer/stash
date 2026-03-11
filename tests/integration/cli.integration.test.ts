import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/make-stash.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

async function runCli(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("node", [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
  });
}

test("cli init creates stash and keeps existing files", async () => {
  const dir = await makeTempDir("cli-init");
  try {
    await writeFile(join(dir, "hello.md"), "hello", "utf8");

    const result = await runCli(dir, ["init"]);

    assert.equal(existsSync(join(dir, ".stash")), true);
    assert.equal(await readFile(join(dir, "hello.md"), "utf8"), "hello");
    assert.equal(result.stdout.includes("Initialized stash"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli init on existing stash is a no-op", async () => {
  const dir = await makeTempDir("cli-init-idempotent");
  try {
    await runCli(dir, ["init"]);
    const second = await runCli(dir, ["init"]);

    assert.equal(existsSync(join(dir, ".stash")), true);
    assert.equal(second.stdout.includes("Already initialized"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
