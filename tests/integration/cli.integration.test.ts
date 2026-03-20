import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMigration, writeLegacyLayout } from "../helpers/assert-migration.ts";
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
    const result = await runCli(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    assert.equal(existsSync(join(dir, ".stash")), true);
    assert.equal(result.stdout.includes("Connected origin."), true);
    const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
    assert.deepEqual(config, {
      connections: {
        origin: { provider: "github", repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli connect defaults the connection name to the provider when omitted", async () => {
  const dir = await makeTempDir("cli-connect-default-name");
  try {
    const result = await runCli(dir, [
      "connect",
      "github",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    assert.equal(result.stdout.includes("Connected github."), true);
    const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
    assert.deepEqual(config, {
      connections: {
        github: { provider: "github", repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli connect errors when the connection name already exists", async () => {
  const dir = await makeTempDir("cli-connect-duplicate");
  try {
    await runCli(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    const result = await execFileAsync(
      "node",
      [CLI_PATH, "connect", "github", "origin", "--repo", "user/other-repo"],
      {
        cwd: dir,
        env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".xdg") },
      },
    ).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(combined.includes("Connection already exists: origin"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli connect errors when the default connection name is already taken", async () => {
  const dir = await makeTempDir("cli-connect-default-duplicate");
  try {
    await runCli(dir, ["connect", "github", "--token", "test-token", "--repo", "user/repo"]);

    const result = await execFileAsync(
      "node",
      [CLI_PATH, "connect", "github", "--repo", "user/other-repo"],
      {
        cwd: dir,
        env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".xdg") },
      },
    ).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(combined.includes("Connection already exists: github"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli connect errors when adding a second connection with a different name", async () => {
  const dir = await makeTempDir("cli-connect-multi");
  try {
    await runCli(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    const result = await execFileAsync(
      "node",
      [CLI_PATH, "connect", "github", "backup", "--repo", "user/other"],
      {
        cwd: dir,
        env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".xdg") },
      },
    ).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(combined.includes("multiple connections are not yet supported"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli config set/get stores allowed stash settings", async () => {
  const dir = await makeTempDir("cli-config");
  try {
    await runCli(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);
    await runCli(dir, ["config", "set", "allow-git", "true"]);

    const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
    assert.deepEqual(config, {
      "allow-git": true,
      connections: {
        origin: { provider: "github", repo: "user/repo" },
      },
    });

    const result = await runCli(dir, ["config", "get", "allow-git"]);
    assert.equal(result.stdout.trim(), "true");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli config get prints nothing when value is unset", async () => {
  const dir = await makeTempDir("cli-config-empty");
  try {
    await runCli(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    const result = await runCli(dir, ["config", "get", "allow-git"]);
    assert.equal(result.stdout.trim(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli config set rejects unknown keys", async () => {
  const dir = await makeTempDir("cli-config-unknown");
  try {
    await runCli(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    const result = await execFileAsync("node", [CLI_PATH, "config", "set", "unknown-key", "true"], {
      cwd: dir,
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".xdg") },
    }).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(combined.includes("Unknown config key"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli config commands require an initialized stash", async () => {
  const dir = await makeTempDir("cli-config-missing");
  try {
    const result = await execFileAsync("node", [CLI_PATH, "config", "set", "allow-git", "true"], {
      cwd: dir,
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".xdg") },
    }).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(combined.includes("not a stash"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli config get migrates the legacy local stash layout", async () => {
  const dir = await makeTempDir("cli-config-migration");
  try {
    await writeLegacyLayout(dir, {
      connections: {},
      snapshotLocal: { "note.md": "base" },
    });

    const result = await runCli(dir, ["config", "get", "allow-git"]);
    assert.equal(result.stdout.trim(), "");

    await assertMigration(dir, {
      connections: {},
      snapshotLocal: { "note.md": "base" },
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
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, ".xdg") },
    }).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1, "process should exit with code 1");

    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    const errorOccurrences = combined.split("sync failed").length - 1;
    assert.equal(errorOccurrences <= 1, true, `error should appear at most once, got: ${combined}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli sync in a git repository prints the allow-git guidance", async () => {
  const dir = await makeTempDir("cli-sync-git");
  const xdg = await makeTempDir("cli-sync-git-xdg");
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    await runCli(
      dir,
      ["connect", "github", "origin", "--token", "test-token", "--repo", "user/repo"],
      {
        XDG_CONFIG_HOME: xdg,
      },
    );

    const result = await execFileAsync("node", [CLI_PATH, "sync"], {
      cwd: dir,
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    }).catch((error) => error as { stdout: string; stderr: string; code: number });

    assert.equal(result.code, 1);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.equal(
      combined.includes(
        "git repository detected — run `stash config set allow-git true` to allow syncing",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("cli sync migrates the legacy local stash layout before a no-op sync", async () => {
  const dir = await makeTempDir("cli-sync-migration");
  try {
    await writeLegacyLayout(dir, {
      connections: {},
      snapshotLocal: { "note.md": "base" },
    });

    const result = await runCli(dir, ["sync"]);
    assert.equal(result.stdout.includes("up to date"), true);

    await assertMigration(dir, {
      connections: {},
      snapshotLocal: { "note.md": "base" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

