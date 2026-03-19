import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
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
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, ".xdg"), ...(env ?? {}) },
  });
}

test("cli connect auto-inits the stash directory", async () => {
  const dir = await makeTempDir("cli-connect-init");
  try {
    const result = await runCli(dir, ["connect", "github", "--token", "test-token", "--repo", "user/repo"]);

    assert.equal(existsSync(join(dir, ".stash")), true);
    assert.equal(result.stdout.includes("Connected github."), true);
    const config = JSON.parse(await readFile(join(dir, ".stash", "config.local.json"), "utf8"));
    assert.deepEqual(config, {
      connections: {
        github: { repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli sync failure sets exit code 1 and prints error once", async () => {
  const dir = await makeTempDir("cli-sync-fail");
  try {
    const result = await execFileAsync("node", [CLI_PATH, "sync"], {
      cwd: dir,
      env: process.env,
    }).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1, "process should exit with code 1");

    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    const errorOccurrences = combined.split("sync failed").length - 1;
    assert.equal(errorOccurrences <= 1, true, `error should appear at most once, got: ${combined}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
