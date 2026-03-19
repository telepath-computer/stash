import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UnsupportedPlatformError } from "@rupertsworld/daemon";
import { main } from "../../src/cli-main.ts";
import { Stash } from "../../src/stash.ts";
import type { GlobalConfig } from "../../src/types.ts";
import { assertMigration, writeLegacyLayout } from "../helpers/assert-migration.ts";

type ServiceCalls = {
  install: number;
  uninstall: number;
  status: number;
};

type RunResult = {
  stdout: string;
  stderr: string;
  config: GlobalConfig;
  calls: ServiceCalls;
};

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
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
  const calls: ServiceCalls = {
    install: 0,
    uninstall: 0,
    status: 0,
  };

  await main(["node", "stash", ...args], {
    cwd: () => cwd,
    readGlobalConfig: async () => structuredClone(config),
    writeGlobalConfig: async (nextConfig) => {
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

  return { stdout, stderr, config, calls };
}

test("background add/remove stores absolute stash paths and warns when sync cannot start yet", async () => {
  const dir = await makeTempDir("stash-cli-background-add");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });

    const added = await runMain(dir, ["background", "add", dir]);
    assert.deepEqual(added.config.background?.stashes, [resolve(dir)]);
    assert.equal(added.stderr.includes("won't sync until a provider is connected"), true);
    assert.equal(added.stderr.includes("service is not installed"), true);

    const removed = await runMain(dir, ["background", "remove", dir], {
      config: added.config,
    });
    assert.deepEqual(removed.config.background?.stashes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect --background stores provider setup and registers the current directory", async () => {
  const dir = await makeTempDir("stash-cli-connect-background");

  try {
    const result = await runMain(dir, [
      "connect",
      "github",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
      "--background",
    ]);

    const localConfig = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));

    assert.deepEqual(result.config, {
      providers: {
        github: { token: "test-token" },
      },
      background: {
        stashes: [resolve(dir)],
      },
    });
    assert.deepEqual(localConfig, {
      connections: {
        github: { repo: "user/repo" },
      },
    });
    assert.equal(result.stderr.includes("service is not installed"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("background status prints unsupported-platform service state and per-stash summaries", async () => {
  const dir = await makeTempDir("stash-cli-background-status");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });
    await writeFile(
      join(dir, ".stash", "status.json"),
      JSON.stringify(
        {
          kind: "synced",
          lastSync: "2026-03-11T14:30:00.000Z",
          summary: "1↑ 2↓",
          error: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runMain(dir, ["background", "status"], {
      config: {
        providers: {},
        background: {
          stashes: [dir],
        },
      },
      serviceStatus: new UnsupportedPlatformError(),
    });

    assert.equal(result.stdout.includes("not supported on this platform"), true);
    assert.equal(result.stdout.includes(dir), true);
    assert.equal(result.stdout.includes("1↑ 2↓"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("background status shows the git safety error message", async () => {
  const dir = await makeTempDir("stash-cli-background-git-error");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });
    await writeFile(
      join(dir, ".stash", "status.json"),
      JSON.stringify(
        {
          kind: "error",
          lastSync: null,
          summary: null,
          error: "git repository detected — run `stash config set allow-git true` to allow syncing",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runMain(dir, ["background", "status"], {
      config: {
        providers: {},
        background: {
          stashes: [dir],
        },
      },
      serviceStatus: new UnsupportedPlatformError(),
    });

    assert.equal(result.stdout.includes("git repository detected"), true);
    assert.equal(result.stdout.includes("stash config set allow-git true"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect warns when git repository syncing is still blocked", async () => {
  const dir = await makeTempDir("stash-cli-connect-git-warning");

  try {
    await mkdir(join(dir, ".git"), { recursive: true });

    const result = await runMain(dir, [
      "connect",
      "github",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    assert.equal(result.stdout.includes("Connected github."), true);
    assert.equal(result.stdout.includes("Warning:"), true);
    assert.equal(result.stdout.includes("remove .git"), true);
    assert.equal(result.stdout.includes("stash config set allow-git true"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("background install delegates to the service module", async () => {
  const dir = await makeTempDir("stash-cli-background-install");

  try {
    const result = await runMain(dir, ["background", "install"]);

    assert.equal(result.calls.install, 1);
    assert.equal(result.stdout.includes("Installed background service"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("background add migrates the legacy local stash layout", async () => {
  const dir = await makeTempDir("stash-cli-background-migration");

  try {
    await writeLegacyLayout(dir, {
      connections: {},
      snapshotLocal: { "note.md": "base" },
    });

    const result = await runMain(dir, ["background", "add", dir]);

    assert.deepEqual(result.config.background?.stashes, [resolve(dir)]);
    await assertMigration(dir, {
      connections: {},
      snapshotLocal: { "note.md": "base" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
