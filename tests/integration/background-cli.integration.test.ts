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
    tty?: boolean;
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
      isTTY: options?.tty === true,
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      isTTY: options?.tty === true,
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
    const result = await runMain(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);
    assert.deepEqual(result.config.background?.stashes, [resolve(dir)]);
    assert.equal(result.stdout.includes("Connected origin."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect defaults the connection name to the provider when omitted", async () => {
  const dir = await makeTempDir("stash-cli-connect-default-name");

  try {
    const result = await runMain(dir, [
      "connect",
      "github",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    assert.deepEqual(result.config.background?.stashes, [resolve(dir)]);
    assert.equal(result.stdout.includes("Connected github."), true);
    const localConfig = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
    assert.deepEqual(localConfig, {
      connections: {
        github: { provider: "github", repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect reports that the stash is now syncing when background sync is already running", async () => {
  const dir = await makeTempDir("stash-cli-connect-running");

  try {
    const result = await runMain(
      dir,
      ["connect", "github", "origin", "--token", "test-token", "--repo", "user/repo"],
      {
        serviceStatus: { installed: true, running: true },
      },
    );

    assert.equal(result.stdout.includes("Connected origin."), true);
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
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);

    assert.equal(result.stdout.includes("Connected origin."), true);
    assert.equal(result.stdout.includes("Warning:"), true);
    assert.equal(result.stdout.includes("remove .git"), true);
    assert.equal(result.stdout.includes("stash config set allow-git true"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connecting a second named connection is rejected", async () => {
  const dir = await makeTempDir("stash-cli-connect-multi");

  try {
    const first = await runMain(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);
    const error = await runMain(
      dir,
      ["connect", "github", "backup", "--token", "test-token", "--repo", "user/other"],
      {
        config: first.config,
      },
    ).catch((e: Error) => e);
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('already has connection "origin"'), true);
    assert.equal(error.message.includes("stash disconnect origin"), true);
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
            origin: { provider: "github", repo: "user/repo" },
            backup: { provider: "fake", repo: "other/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runMain(dir, ["disconnect", "origin"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
    });

    assert.deepEqual(result.config.background?.stashes, [resolve(dir)]);
    const localConfig = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
    assert.deepEqual(localConfig, {
      connections: {
        backup: { provider: "fake", repo: "other/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect --all disconnects the stash completely", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-all");

  try {
    const connected = await runMain(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);
    const disconnected = await runMain(dir, ["disconnect", "--all"], {
      config: connected.config,
    });

    assert.deepEqual(disconnected.config.background?.stashes, []);
    assert.equal(existsSync(join(dir, ".stash")), false);
    assert.equal(disconnected.stdout.includes("Disconnected stash."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect with no arguments errors with actionable guidance", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-missing");

  try {
    const result = await main(["node", "stash", "disconnect"], {
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
      "argument required — run `stash disconnect <name>`, `stash disconnect --all`, or `stash disconnect --path <path>`",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect removes .stash and unregisters when it was the last connection", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-remove");

  try {
    const connected = await runMain(dir, [
      "connect",
      "github",
      "origin",
      "--token",
      "test-token",
      "--repo",
      "user/repo",
    ]);
    const disconnected = await runMain(dir, ["disconnect", "origin"], {
      config: connected.config,
    });

    assert.deepEqual(disconnected.config.background?.stashes, []);
    assert.equal(existsSync(join(dir, ".stash")), false);
    assert.equal(disconnected.stdout.includes("Disconnected origin."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect --path deregisters the path and removes .stash when the directory exists", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-path");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [resolve(dir)] } });

    const result = await runMain(dir, ["disconnect", "--path", dir], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
    });

    assert.deepEqual(result.config.background?.stashes, []);
    assert.equal(existsSync(join(dir, ".stash")), false);
    assert.equal(result.stdout.includes("Disconnected stash."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect --path no-ops cleanly when the path is not registered", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-path-missing");
  const missing = join(dir, "missing-stash");

  try {
    const result = await runMain(dir, ["disconnect", "--path", missing], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
    });

    assert.deepEqual(result.config.background?.stashes, [resolve(dir)]);
    assert.equal(result.stdout.includes("No stash registered at that path."), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect errors when the named connection does not exist", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-missing-name");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [resolve(dir)] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            origin: { provider: "github", repo: "user/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await main(["node", "stash", "disconnect", "backup"], {
      cwd: () => dir,
      readGlobalConfig: async () => ({ providers: {}, background: { stashes: [resolve(dir)] } }),
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
    assert.equal((result as Error).message, "Connection not found: backup");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect flags are mutually exclusive", async () => {
  const dir = await makeTempDir("stash-cli-disconnect-exclusive");

  try {
    const result = await main(["node", "stash", "disconnect", "origin", "--all"], {
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
      "disconnect modes are mutually exclusive — use only one of `<name>`, `--all`, or `--path <path>`",
    );
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

test("status prints unsupported-platform state and per-stash summaries", async () => {
  const dir = await makeTempDir("stash-cli-status-all");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            origin: { provider: "github", repo: "user/repo" },
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

    const result = await runMain(dir, ["status"], {
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
    assert.equal(result.stdout.includes("origin (github)"), true);
    assert.equal(result.stdout.includes("user/repo"), false);
    assert.equal(result.stdout.includes("Up to date"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status shows the git safety error message", async () => {
  const dir = await makeTempDir("stash-cli-status-all-git-error");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            origin: { provider: "github", repo: "user/repo" },
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

    const result = await runMain(dir, ["status"], {
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

test("status shows the current stash when background sync is running", async () => {
  const dir = await makeTempDir("stash-cli-status-local");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [resolve(dir)] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            origin: { provider: "github", repo: "user/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(join(dir, ".stash", "snapshot.json"), JSON.stringify({}, null, 2), "utf8");

    const result = await runMain(dir, ["status"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
      serviceStatus: { installed: true, running: true },
    });

    assert.equal(result.stdout.includes("origin (github)"), true);
    assert.equal(result.stdout.includes("user/repo"), false);
    assert.equal(result.stdout.includes("Background sync is on"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status shows waiting for first sync when no snapshot exists", async () => {
  const dir = await makeTempDir("stash-cli-status-waiting");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            origin: { provider: "github", repo: "user/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runMain(dir, ["status"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
      tty: true,
    });

    assert.equal(result.stdout.includes("origin (github)"), true);
    assert.equal(result.stdout.includes("Waiting for first sync"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status outside a stash shows no stashes connected", async () => {
  const dir = await makeTempDir("stash-cli-status-outside");

  try {
    const result = await runMain(dir, ["status"], {
      config: { providers: {}, background: { stashes: [] } },
      serviceStatus: { installed: false, running: false },
    });

    assert.equal(result.stdout.includes("No stashes connected yet"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration stops the running daemon before migrating and restarts it after", async () => {
  const dir = await makeTempDir("stash-cli-migrate-bounce");

  try {
    await writeLegacyLayout(dir, {
      connections: { github: { repo: "user/repo" } },
      snapshotLocal: { "note.md": "base" },
    });

    const result = await runMain(dir, ["status"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
      serviceStatus: { installed: true, running: true },
    });

    assert.equal(result.calls.uninstall, 1, "daemon should be stopped before migration");
    assert.equal(result.calls.install, 1, "daemon should be restarted after migration");
    await assertMigration(dir, {
      connections: { github: { provider: "github", repo: "user/repo" } },
      snapshotLocal: { "note.md": "base" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration does not bounce the daemon when it is not running", async () => {
  const dir = await makeTempDir("stash-cli-migrate-no-bounce");

  try {
    await writeLegacyLayout(dir, {
      connections: { github: { repo: "user/repo" } },
    });

    const result = await runMain(dir, ["status"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
      serviceStatus: { installed: false, running: false },
    });

    assert.equal(result.calls.uninstall, 0, "daemon should not be stopped when not running");
    assert.equal(result.calls.install, 0, "daemon should not be installed when it was not running");
    await assertMigration(dir, {
      connections: { github: { provider: "github", repo: "user/repo" } },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration bounces daemon for status when a background stash needs migration", async () => {
  const dir = await makeTempDir("stash-cli-migrate-status-all");

  try {
    await writeLegacyLayout(dir, {
      connections: { github: { repo: "user/repo" } },
      snapshotLocal: { "note.md": "base" },
    });
    await writeFile(join(dir, ".stash", "snapshot.json"), JSON.stringify({}, null, 2), "utf8");

    const result = await runMain(dir, ["status"], {
      config: {
        providers: {},
        background: { stashes: [dir] },
      },
      serviceStatus: { installed: true, running: true },
    });

    assert.equal(result.calls.uninstall, 1, "daemon should be stopped before migration");
    assert.equal(result.calls.install, 1, "daemon should be restarted after migration");
    await assertMigration(dir, {
      connections: { github: { provider: "github", repo: "user/repo" } },
      snapshotLocal: { "note.md": "base" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration does not restart daemon after stash stop", async () => {
  const dir = await makeTempDir("stash-cli-migrate-stop");

  try {
    await writeLegacyLayout(dir, {
      connections: { github: { repo: "user/repo" } },
    });

    const result = await runMain(dir, ["stop"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
      serviceStatus: { installed: true, running: true },
    });

    assert.equal(result.calls.uninstall >= 1, true, "daemon should be stopped");
    assert.equal(result.calls.install, 0, "daemon should not be restarted after stop command");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status prints background sync line above provider connections with a blank line gap", async () => {
  const dir = await makeTempDir("stash-cli-status-layout");

  try {
    await Stash.init(dir, { providers: {}, background: { stashes: [resolve(dir)] } });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        {
          connections: {
            origin: { provider: "github", repo: "user/repo" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(join(dir, ".stash", "snapshot.json"), JSON.stringify({}, null, 2), "utf8");

    const result = await runMain(dir, ["status"], {
      config: {
        providers: {},
        background: { stashes: [resolve(dir)] },
      },
      serviceStatus: { installed: true, running: true },
    });

    const lines = result.stdout.split("\n");
    const bgLine = lines.findIndex((line) => line.includes("Background sync is on"));
    const providerLine = lines.findIndex((line) => line.includes("origin (github)"));
    assert.notEqual(bgLine, -1, "should contain background sync line");
    assert.notEqual(providerLine, -1, "should contain provider line");
    assert.equal(
      bgLine < providerLine,
      true,
      "background sync line should appear before provider line",
    );
    assert.equal(
      lines[bgLine + 1]?.trim(),
      "",
      "blank line should follow the background sync line",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
