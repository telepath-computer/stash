import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { UnsupportedPlatformError } from "@rupertsworld/daemon";
import { main } from "../../src/cli-main.ts";
import { Stash } from "../../src/stash.ts";
import type { GlobalConfig } from "../../src/types.ts";

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

test("connect registers the current stash path in the background registry", async () => {
  const dir = await makeTempDir("stash-cli-connect-register");

  try {
    const result = await runMain(dir, ["connect", "github", "--token", "test-token", "--repo", "user/repo"]);
    assert.deepEqual(result.config.background?.stashes, [resolve(dir)]);
    assert.equal(result.stdout.includes("Connected github."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect reports that the stash is now syncing when background sync is already running", async () => {
  const dir = await makeTempDir("stash-cli-connect-running");

  try {
    const result = await runMain(
      dir,
      ["connect", "github", "--token", "test-token", "--repo", "user/repo"],
      {
        serviceStatus: { installed: true, running: true },
      },
    );

    assert.equal(result.stdout.includes("Connected github."), true);
    assert.equal(result.stdout.includes("Background sync is on"), true);
    assert.equal(result.stdout.includes("This stash is now syncing automatically"), true);
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

test("reconnecting an already-registered stash is a registry no-op", async () => {
  const dir = await makeTempDir("stash-cli-connect-reregister");

  try {
    const first = await runMain(dir, ["connect", "github", "--token", "test-token", "--repo", "user/repo"]);
    const second = await runMain(dir, ["connect", "github", "--token", "test-token", "--repo", "user/repo"], {
      config: first.config,
    });
    assert.deepEqual(second.config, {
      providers: {
        github: { token: "test-token" },
      },
      background: {
        stashes: [resolve(dir)],
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect keeps the stash registered while other providers remain", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-keep");

  try {
    await Stash.init(dir, {
      providers: {},
      background: { stashes: [resolve(dir)] },
    });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            github: { repo: "user/repo" },
            fake: { repo: "other/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runMain(dir, ["disconnect", "github"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
    });

    assert.deepEqual(result.config.background?.stashes, [resolve(dir)]);
    const localConfig = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
    assert.deepEqual(localConfig, {
      connections: {
        fake: { repo: "other/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect with no provider disconnects the stash completely", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-all");

  try {
    const connected = await runMain(dir, ["connect", "github", "--token", "test-token", "--repo", "user/repo"]);
    const disconnected = await runMain(dir, ["disconnect"], {
      config: connected.config,
    });

    assert.deepEqual(disconnected.config.background?.stashes, []);
    assert.equal(existsSync(join(dir, ".stash")), false);
    assert.equal(disconnected.stdout.includes("Disconnected stash."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect provider removes .stash and unregisters when it was the last provider", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-remove");

  try {
    const connected = await runMain(dir, ["connect", "github", "--token", "test-token", "--repo", "user/repo"]);
    const disconnected = await runMain(dir, ["disconnect", "github"], {
      config: connected.config,
    });

    assert.deepEqual(disconnected.config.background?.stashes, []);
    assert.equal(existsSync(join(dir, ".stash")), false);
    assert.equal(disconnected.stdout.includes("Disconnected github."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("start delegates to install and reports the service is on", async () => {
  const dir = await makeTempDir("stash-cli-start");

  try {
    const result = await runMain(dir, ["start"], {
      config: {
        providers: {},
        background: { stashes: ["/a", "/b", "/c"] },
      },
    });

    assert.equal(result.calls.install, 1);
    assert.equal(result.stdout.includes("Background sync is on"), true);
    assert.equal(result.stdout.includes("Watching 3 stashes"), true);
    assert.equal(result.stdout.includes("starts on startup"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop delegates to uninstall and reports how to resume syncing", async () => {
  const dir = await makeTempDir("stash-cli-stop");

  try {
    const result = await runMain(dir, ["stop"], {
      config: {
        providers: {},
        background: { stashes: ["/a", "/b", "/c"] },
      },
      serviceStatus: { installed: true, running: true },
    });

    assert.equal(result.calls.uninstall, 1);
    assert.equal(result.stdout.includes("Background sync is off"), true);
    assert.equal(result.stdout.includes("Run `stash start` to resume syncing 3 stashes"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status --all prints unsupported-platform state and per-stash summaries", async () => {
  const dir = await makeTempDir("stash-cli-status-all");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            github: { repo: "user/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
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
    await writeFile(join(dir, ".stash", "snapshot.json"), JSON.stringify({}, null, 2), "utf8");

    const result = await runMain(dir, ["status", "--all"], {
      config: {
        providers: {},
        background: {
          stashes: [dir],
        },
      },
      serviceStatus: new UnsupportedPlatformError(),
    });

    assert.equal(result.stdout.includes("not supported on this platform"), true);
    assert.equal(result.stdout.includes(basename(dir)), true);
    assert.equal(result.stdout.includes(dir), true);
    assert.equal(result.stdout.includes("github  user/repo"), true);
    assert.equal(result.stdout.includes("Up to date"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status --all shows the git safety error message", async () => {
  const dir = await makeTempDir("stash-cli-status-all-git-error");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            github: { repo: "user/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
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

    const result = await runMain(dir, ["status", "--all"], {
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

test("status shows the current stash and hints toward --all when background sync is running", async () => {
  const dir = await makeTempDir("stash-cli-status-local");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [resolve(dir)] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            github: { repo: "user/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(dir, ".stash", "snapshot.json"),
      JSON.stringify({}, null, 2),
      "utf8",
    );

    const result = await runMain(dir, ["status"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
      serviceStatus: { installed: true, running: true },
    });

    assert.equal(result.stdout.includes("github"), true);
    assert.equal(result.stdout.includes("user/repo"), true);
    assert.equal(result.stdout.includes("Use `stash status --all` to view all stashes"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status outside a stash tells the user to use --all", async () => {
  const dir = await makeTempDir("stash-cli-status-outside");

  try {
    const result = await main(["node", "stash", "status"], {
      cwd: () => dir,
      readGlobalConfig: async () => ({ providers: {}, background: { stashes: [] } }),
      writeGlobalConfig: async () => {},
      service: {
        install: async () => {},
        uninstall: async () => {},
        status: async () => ({ installed: false, running: false }),
      },
      stdout: {
        isTTY: false,
        write() {
          return true;
        },
      } as NodeJS.WriteStream,
      stderr: {
        isTTY: false,
        write() {
          return true;
        },
      } as NodeJS.WriteStream,
    }).catch((error) => error as Error);

    assert.equal(result instanceof Error, true);
    assert.equal(
      (result as Error).message,
      "Not in a stash directory — run `stash status --all` to view all stashes",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
