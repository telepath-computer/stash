import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/make-stash.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

function getTestStashPath(dir: string): string {
  return join(dir, ".xdg", "stash");
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("node", [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, ".xdg") },
  });
}

async function listStashIds(stashPath: string): Promise<string[]> {
  if (!existsSync(stashPath)) {
    return [];
  }
  return (await readdir(stashPath)).filter((entry) => !entry.startsWith(".") && entry !== "config.json");
}

test("cli setup stores provider globals in ~/.stash/config.json", async () => {
  const dir = await makeTempDir("cli-setup-global");

  try {
    const result = await runCli(dir, ["setup", "github", "--token", "test-token"]);

    assert.equal(stripAnsi(result.stdout).includes("Configured github"), true);
    const config = JSON.parse(await readFile(join(getTestStashPath(dir), "config.json"), "utf8"));
    assert.deepEqual(config, {
      providers: {
        github: {
          token: "test-token",
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli connect creates registry metadata without a local .stash directory", async () => {
  const dir = await makeTempDir("cli-connect-uri");

  try {
    const result = await runCli(dir, ["connect", "github:user/repo", "--token", "test-token"]);
    const canonicalDir = await realpath(dir);

    assert.equal(stripAnsi(result.stdout).includes("Connected"), true);
    assert.equal(stripAnsi(result.stdout).includes("github:user/repo"), true);
    assert.equal(stripAnsi(result.stdout).includes(canonicalDir), true);
    assert.equal(existsSync(join(dir, ".stash")), false);

    const ids = await listStashIds(getTestStashPath(dir));
    assert.equal(ids.length, 1);
    const record = JSON.parse(
      await readFile(join(getTestStashPath(dir), ids[0], "stash.json"), "utf8"),
    ) as { path: string; connections: Array<{ provider: string; config: { id: string } }> };
    assert.deepEqual(record, {
      path: await realpath(dir),
      connections: [{ provider: "github", config: { id: "user/repo" } }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli connect accepts an explicit path argument", async () => {
  const dir = await makeTempDir("cli-connect-explicit");
  const target = await makeTempDir("cli-connect-target");

  try {
    const result = await runCli(dir, ["connect", target, "github:user/repo", "--token", "test-token"]);
    const canonicalTarget = await realpath(target);

    assert.equal(stripAnsi(result.stdout).includes("Connected"), true);
    assert.equal(stripAnsi(result.stdout).includes("github:user/repo"), true);
    assert.equal(stripAnsi(result.stdout).includes(canonicalTarget), true);
    const ids = await listStashIds(getTestStashPath(dir));
    assert.equal(ids.length, 1);
    const record = JSON.parse(
      await readFile(join(getTestStashPath(dir), ids[0], "stash.json"), "utf8"),
    ) as { path: string };
    assert.equal(record.path, await realpath(target));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("cli disconnect tombstones the stash record", async () => {
  const dir = await makeTempDir("cli-disconnect");

  try {
    await runCli(dir, ["connect", "github:user/repo", "--token", "test-token"]);
    const [id] = await listStashIds(getTestStashPath(dir));
    const canonicalDir = await realpath(dir);

    const result = await runCli(dir, ["disconnect"]);

    assert.equal(stripAnsi(result.stdout).includes("Disconnected"), true);
    assert.equal(stripAnsi(result.stdout).includes("github:user/repo"), true);
    assert.equal(stripAnsi(result.stdout).includes(canonicalDir), true);
    const record = JSON.parse(
      await readFile(join(getTestStashPath(dir), id, "stash.json"), "utf8"),
    ) as { connections: unknown[] };
    assert.deepEqual(record.connections, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli relink rewrites the canonical path stored in stash.json", async () => {
  const dir = await makeTempDir("cli-relink-old");
  const moved = await makeTempDir("cli-relink-new");

  try {
    await runCli(dir, ["connect", "github:user/repo", "--token", "test-token"]);
    const [id] = await listStashIds(getTestStashPath(dir));
    const canonicalDir = await realpath(dir);
    const canonicalMoved = await realpath(moved);

    const result = await runCli(dir, ["relink", dir, moved]);

    assert.equal(stripAnsi(result.stdout).includes("Relinked"), true);
    assert.equal(stripAnsi(result.stdout).includes(canonicalDir), true);
    assert.equal(stripAnsi(result.stdout).includes(canonicalMoved), true);
    assert.equal(stripAnsi(result.stdout).includes("→"), true);
    const record = JSON.parse(
      await readFile(join(getTestStashPath(dir), id, "stash.json"), "utf8"),
    ) as { path: string };
    assert.equal(record.path, await realpath(moved));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("cli status prints registered stashes from the registry root", async () => {
  const dir = await makeTempDir("cli-status");
  const stashPath = getTestStashPath(dir);

  try {
    await runCli(dir, ["connect", "github:user/repo", "--token", "test-token"]);
    const [id] = await listStashIds(stashPath);
    await writeFile(
      join(stashPath, id, "status.json"),
      JSON.stringify(
        {
          kind: "idle",
          lastSync: "2026-03-11T14:30:00.000Z",
          summary: null,
          error: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runCli(dir, ["status"]);

    assert.equal(stripAnsi(result.stdout).includes("Daemon:"), true);
    assert.equal(stripAnsi(result.stdout).includes("Connection"), true);
    assert.equal(stripAnsi(result.stdout).includes("State"), true);
    assert.equal(stripAnsi(result.stdout).includes(await realpath(dir)), true);
    assert.equal(stripAnsi(result.stdout).includes("github:user/repo"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli connect blocks git repos unless --dangerously-allow-git is passed", async () => {
  const dir = await makeTempDir("cli-connect-git");

  try {
    await mkdir(join(dir, ".git"), { recursive: true });

    const error = await execFileAsync(
      "node",
      [CLI_PATH, "connect", "github:user/repo", "--token", "test-token"],
      {
        cwd: dir,
        env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".xdg") },
      },
    ).catch((value) => value as { stdout: string; stderr: string; code: number });
    const stderr = stripAnsi(error.stderr ?? "");

    assert.equal(error.code, 1);
    assert.equal(stderr.includes("Error:"), true);
    assert.equal(stderr.includes("is a git repository"), true);
    assert.equal(stderr.includes("--dangerously-allow-git"), true);

    const allowed = await runCli(dir, [
      "connect",
      "github:user/repo",
      "--token",
      "test-token",
      "--dangerously-allow-git",
    ]);
    assert.equal(stripAnsi(allowed.stdout).includes("Connected"), true);
    assert.equal(stripAnsi(allowed.stdout).includes("github:user/repo"), true);
    assert.equal(stripAnsi(allowed.stdout).includes(await realpath(dir)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
