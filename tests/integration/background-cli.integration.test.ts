import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../../src/cli-main.ts";
import type { GlobalConfig, StashRecord } from "../../src/types.ts";

type ServiceCalls = {
  install: number;
  uninstall: number;
  status: number;
};

type RunResult = {
  stdout: string;
  stderr: string;
  config: GlobalConfig;
  configWrites: number;
  calls: ServiceCalls;
};

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

function getTestStashPath(dir: string): string {
  return join(dir, ".xdg", "stash");
}

async function listStashIds(stashPath: string): Promise<string[]> {
  if (!existsSync(stashPath)) {
    return [];
  }
  return (await readdir(stashPath)).filter((entry) => !entry.startsWith(".") && entry !== "config.json");
}

async function readOnlyStashRecord(stashPath: string): Promise<{ id: string; record: StashRecord }> {
  const ids = await listStashIds(stashPath);
  assert.equal(ids.length, 1);
  return {
    id: ids[0],
    record: JSON.parse(await readFile(join(stashPath, ids[0], "stash.json"), "utf8")) as StashRecord,
  };
}

async function writeStashRecord(stashPath: string, id: string, record: StashRecord): Promise<void> {
  await mkdir(join(stashPath, id), { recursive: true });
  await writeFile(join(stashPath, id, "stash.json"), JSON.stringify(record, null, 2), "utf8");
}

async function runMain(
  cwd: string,
  args: string[],
  options?: {
    config?: GlobalConfig;
    serviceStatus?: { installed: boolean; running: boolean } | Error;
  },
): Promise<RunResult> {
  let config: GlobalConfig = structuredClone(
    options?.config ?? {
      providers: {},
      background: {
        stashes: [],
      },
    },
  );
  let stdout = "";
  let stderr = "";
  let configWrites = 0;
  const calls: ServiceCalls = {
    install: 0,
    uninstall: 0,
    status: 0,
  };

  await main(["node", "stash", ...args], {
    cwd: () => cwd,
    stashPath: getTestStashPath(cwd),
    readGlobalConfig: async () => structuredClone(config),
    writeGlobalConfig: async (nextConfig) => {
      configWrites += 1;
      config = structuredClone(nextConfig);
    },
    service: {
      install: async () => {
        calls.install += 1;
      },
      uninstall: async () => {
        calls.uninstall += 1;
      },
      status: async () => {
        calls.status += 1;
        if (options?.serviceStatus instanceof Error) {
          throw options.serviceStatus;
        }
        return options?.serviceStatus ?? { installed: false, running: false };
      },
    },
    stdout: {
      isTTY: false,
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      isTTY: false,
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
  });

  return { stdout, stderr, config, configWrites, calls };
}

test("connect creates a new stash record and stores provider globals separately", async () => {
  const dir = await makeTempDir("stash-cli-connect");

  try {
    const result = await runMain(
      dir,
      ["connect", "github:user/repo", "--token", "test-token"],
      {
        serviceStatus: { installed: true, running: true },
      },
    );

    assert.equal(result.stdout.includes(`Connected github:user/repo to ${await realpath(dir)}.`), true);
    assert.equal(result.stdout.includes("Background sync is on"), true);
    assert.equal(result.config.providers.github?.token, "test-token");
    assert.equal(existsSync(join(dir, ".stash")), false);

    const { record } = await readOnlyStashRecord(getTestStashPath(dir));
    assert.deepEqual(record, {
      path: await realpath(dir),
      connections: [{ provider: "github", config: { id: "user/repo" } }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect is idempotent for the same uri", async () => {
  const dir = await makeTempDir("stash-cli-connect-idempotent");

  try {
    const first = await runMain(dir, ["connect", "github:user/repo", "--token", "test-token"]);
    const second = await runMain(dir, ["connect", "github:user/repo"], {
      config: first.config,
    });

    assert.equal(second.stdout.includes("Already connected."), true);
    assert.deepEqual(await listStashIds(getTestStashPath(dir)), [(
      await readOnlyStashRecord(getTestStashPath(dir))
    ).id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect skips rewriting global config when provider globals are unchanged", async () => {
  const dir = await makeTempDir("stash-cli-connect-global-unchanged");

  try {
    const result = await runMain(dir, ["connect", "github:user/repo"], {
      config: {
        providers: {
          github: { token: "test-token" },
        },
        background: {
          stashes: [],
        },
      },
    });

    assert.equal(result.configWrites, 0);
    assert.deepEqual(result.config.providers.github, { token: "test-token" });
    const { record } = await readOnlyStashRecord(getTestStashPath(dir));
    assert.deepEqual(record.connections, [{ provider: "github", config: { id: "user/repo" } }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect blocks git repositories unless --dangerously-allow-git is passed", async () => {
  const dir = await makeTempDir("stash-cli-connect-git");

  try {
    await mkdir(join(dir, ".git"), { recursive: true });

    const error = await runMain(dir, ["connect", "github:user/repo", "--token", "test-token"]).catch(
      (value: Error) => value,
    );

    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("--dangerously-allow-git"), true);
    assert.deepEqual(await listStashIds(getTestStashPath(dir)), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect tombstones the last connection without deleting the stash dir", async () => {
  const dir = await makeTempDir("stash-cli-disconnect");

  try {
    const connected = await runMain(dir, ["connect", "github:user/repo", "--token", "test-token"]);
    const { id } = await readOnlyStashRecord(getTestStashPath(dir));

    const result = await runMain(dir, ["disconnect"], {
      config: connected.config,
    });

    assert.equal(
      result.stdout.includes(`Disconnected github:user/repo from ${await realpath(dir)}.`),
      true,
    );
    assert.equal(existsSync(join(getTestStashPath(dir), id)), true);
    const record = JSON.parse(
      await readFile(join(getTestStashPath(dir), id, "stash.json"), "utf8"),
    ) as StashRecord;
    assert.deepEqual(record.connections, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("relink rewrites stash.json.path and enforces the git gate on the new path", async () => {
  const dir = await makeTempDir("stash-cli-relink-old");
  const moved = await makeTempDir("stash-cli-relink-new");

  try {
    const connected = await runMain(dir, ["connect", "github:user/repo", "--token", "test-token"]);
    const { id } = await readOnlyStashRecord(getTestStashPath(dir));

    await mkdir(join(moved, ".git"), { recursive: true });
    const error = await runMain(dir, ["relink", dir, moved], { config: connected.config }).catch(
      (value: Error) => value,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("--dangerously-allow-git"), true);

    const result = await runMain(
      dir,
      ["relink", dir, moved, "--dangerously-allow-git"],
      { config: connected.config },
    );

    assert.equal(
      result.stdout.includes(`Relinked ${await realpath(dir)} -> ${await realpath(moved)}.`),
      true,
    );
    const record = JSON.parse(
      await readFile(join(getTestStashPath(dir), id, "stash.json"), "utf8"),
    ) as StashRecord;
    assert.equal(record.path, await realpath(moved));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("status prints daemon state, connection URIs, and missing-path guidance", async () => {
  const dir = await makeTempDir("stash-cli-status");
  const missing = join(dir, "missing-folder");
  const stashPath = getTestStashPath(dir);

  try {
    await writeStashRecord(stashPath, "live-stash", {
      path: resolve(dir),
      connections: [{ provider: "github", config: { id: "user/live" } }],
    });
    await writeStashRecord(stashPath, "missing-stash", {
      path: resolve(missing),
      connections: [{ provider: "github", config: { id: "user/missing" } }],
    });
    await writeFile(
      join(stashPath, "live-stash", "status.json"),
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
    await writeFile(
      join(stashPath, "missing-stash", "status.json"),
      JSON.stringify(
        {
          kind: "missing",
          lastSync: null,
          summary: null,
          error: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runMain(dir, ["status"], {
      serviceStatus: { installed: true, running: true },
    });

    assert.equal(result.stdout.includes("Daemon: running"), true);
    assert.equal(result.stdout.includes(resolve(dir)), true);
    assert.equal(result.stdout.includes("github:user/live"), true);
    assert.equal(
      result.stdout.includes(`path missing — run \`stash relink ${resolve(missing)} <new-path>\``),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("start and stop delegate to the service and use the new daemon messaging", async () => {
  const dir = await makeTempDir("stash-cli-service");

  try {
    const started = await runMain(dir, ["start"]);
    assert.equal(started.calls.install, 1);
    assert.equal(started.stdout.includes("Daemon started."), true);

    const stopped = await runMain(dir, ["stop"], {
      serviceStatus: { installed: true, running: true },
    });
    assert.equal(stopped.calls.uninstall, 1);
    assert.equal(stopped.stdout.includes("Daemon stopped."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
