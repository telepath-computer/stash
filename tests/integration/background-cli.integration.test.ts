import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../../src/cli-main.ts";
import { Stash } from "../../src/stash.ts";
import type { GlobalConfig } from "../../src/types.ts";

type ServiceCalls = {
  install: Array<{
    name: string;
    description: string;
    command: string;
    args: string[];
  }>;
  uninstall: Array<{ name: string }>;
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
    resolveStashCommand?: () => Promise<string>;
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
    install: [],
    uninstall: [],
    status: 0,
  };

  await main(["node", "stash", ...args], {
    cwd: () => cwd,
    readGlobalConfig: async () => structuredClone(config),
    writeGlobalConfig: async (nextConfig) => {
      config = structuredClone(nextConfig);
    },
    service: {
      install: async (installOptions) => {
        calls.install.push(installOptions);
      },
      uninstall: async (uninstallOptions) => {
        calls.uninstall.push(uninstallOptions);
      },
      status: async () => {
        calls.status += 1;
        if (options?.serviceStatus instanceof Error) {
          throw options.serviceStatus;
        }
        return options?.serviceStatus ?? { installed: false, running: false };
      },
    },
    resolveStashCommand: options?.resolveStashCommand ?? (async () => "/opt/homebrew/bin/stash"),
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

    const localConfig = JSON.parse(
      await readFile(join(dir, ".stash", "config.local.json"), "utf8"),
    );

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
      serviceStatus: new Error("not supported on this platform yet"),
    });

    assert.equal(result.stdout.includes("not supported on this platform"), true);
    assert.equal(result.stdout.includes(dir), true);
    assert.equal(result.stdout.includes("1↑ 2↓"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("background install resolves the stash binary and delegates to the service module", async () => {
  const dir = await makeTempDir("stash-cli-background-install");

  try {
    const result = await runMain(dir, ["background", "install"], {
      resolveStashCommand: async () => "/custom/bin/stash",
    });

    assert.deepEqual(result.calls.install, [
      {
        name: "stash-background",
        description: "Stash background sync",
        command: "/custom/bin/stash",
        args: ["background", "watch"],
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
