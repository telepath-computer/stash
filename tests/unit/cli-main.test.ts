import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveServiceLaunch } from "../../src/cli-main.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

async function withPath<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  if (value === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = value;
  }

  try {
    return await run();
  } finally {
    if (original === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = original;
    }
  }
}

test("resolveServiceLaunch uses current executable script when directly executable", async () => {
  const dir = await makeTempDir("stash-cli-launch-exec");
  const script = join(dir, "stash");

  try {
    await writeFile(script, "#!/usr/bin/env node\n", "utf8");
    await chmod(script, 0o755);

    const launch = await withPath("", () => resolveServiceLaunch(["node", script, "start"]));
    assert.deepEqual(launch, {
      command: resolve(script),
      args: ["daemon"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveServiceLaunch uses node plus script when invoked from source", async () => {
  const dir = await makeTempDir("stash-cli-launch-node");
  const script = join(dir, "cli.ts");

  try {
    await writeFile(script, "export {};\n", "utf8");

    const launch = await withPath("", () => resolveServiceLaunch(["node", script, "connect"]));
    assert.deepEqual(launch, {
      command: process.execPath,
      args: [resolve(script), "daemon"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveServiceLaunch falls back to stash on PATH when current invocation is unusable", async () => {
  const dir = await makeTempDir("stash-cli-launch-path");
  const binDir = join(dir, "bin");
  const stashPath = join(binDir, "stash");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(stashPath, "#!/usr/bin/env node\n", "utf8");
    await chmod(stashPath, 0o755);

    const launch = await withPath(binDir, () =>
      resolveServiceLaunch(["node", join(dir, "missing-cli.ts"), "start"]),
    );
    assert.deepEqual(launch, {
      command: stashPath,
      args: ["daemon"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveServiceLaunch fails cleanly when no invocation or PATH command is usable", async () => {
  await withPath("", async () => {
    await assert.rejects(
      resolveServiceLaunch(["node", join(tmpdir(), "definitely-missing-cli.ts"), "start"]),
      /Could not resolve a command to run `stash daemon`/,
    );
  });
});
