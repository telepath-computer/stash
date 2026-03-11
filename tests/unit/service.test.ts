import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceController } from "../../src/service/controller.ts";

type ExecCall = {
  command: string;
  args: string[];
};

async function makeTempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

test("service install: macOS writes launchd plist and loads the service", async () => {
  const home = await makeTempHome("stash-service-darwin");
  const calls: ExecCall[] = [];

  try {
    const service = createServiceController({
      platform: "darwin",
      homeDir: home,
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    await service.install({
      name: "com.example.stash",
      description: "Stash background sync",
      command: "/usr/local/bin/stash",
      args: ["background", "watch"],
    });

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.stash.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.equal(plist.includes("<string>/usr/local/bin/stash</string>"), true);
    assert.equal(plist.includes("<string>background</string>"), true);
    assert.equal(plist.includes("<string>watch</string>"), true);
    assert.equal(
      calls.some(
        ({ command, args }) =>
          command === "launchctl" &&
          args[0] === "load" &&
          args[1] === "-w" &&
          args[2] === plistPath,
      ),
      true,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service uninstall: linux removes the systemd unit and disables the service", async () => {
  const home = await makeTempHome("stash-service-linux");
  const calls: ExecCall[] = [];
  const unitPath = join(home, ".config", "systemd", "user", "stash-background.service");

  try {
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath, "[Unit]\nDescription=old\n", "utf8");

    const service = createServiceController({
      platform: "linux",
      homeDir: home,
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    await service.uninstall({ name: "stash-background" });

    assert.equal(existsSync(unitPath), false);
    assert.equal(
      calls.some(
        ({ command, args }) =>
          command === "systemctl" &&
          args.join(" ") === "--user disable --now stash-background.service",
      ),
      true,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service status: reports installed and running for active macOS service", async () => {
  const home = await makeTempHome("stash-service-status");

  try {
    const plistPath = join(home, "Library", "LaunchAgents", "com.example.stash.plist");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist />", "utf8");

    const service = createServiceController({
      platform: "darwin",
      homeDir: home,
      exec: async (command, args) => {
        assert.equal(command, "launchctl");
        assert.deepEqual(args, ["list", "com.example.stash"]);
        return { stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(await service.status({ name: "com.example.stash" }), {
      installed: true,
      running: true,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service install: macOS reinstall unloads before reloading (idempotent)", async () => {
  const home = await makeTempHome("stash-service-darwin-reinstall");
  const calls: ExecCall[] = [];

  try {
    const plistFile = join(home, "Library", "LaunchAgents", "com.example.stash.plist");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistFile, "<plist />", "utf8");

    const service = createServiceController({
      platform: "darwin",
      homeDir: home,
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    await service.install({
      name: "com.example.stash",
      description: "Stash background sync",
      command: "/usr/local/bin/stash",
      args: ["background", "watch"],
    });

    assert.equal(calls[0].command, "launchctl");
    assert.deepEqual(calls[0].args, ["unload", "-w", plistFile]);
    assert.equal(calls[1].command, "launchctl");
    assert.deepEqual(calls[1].args, ["load", "-w", plistFile]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service install: linux reinstall disables before re-enabling (idempotent)", async () => {
  const home = await makeTempHome("stash-service-linux-reinstall");
  const calls: ExecCall[] = [];

  try {
    const unitFile = join(home, ".config", "systemd", "user", "stash-background.service");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitFile, "[Unit]\nDescription=old\n", "utf8");

    const service = createServiceController({
      platform: "linux",
      homeDir: home,
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    await service.install({
      name: "stash-background",
      description: "Stash background sync",
      command: "/usr/local/bin/stash",
      args: ["background", "watch"],
    });

    assert.deepEqual(calls[0], {
      command: "systemctl",
      args: ["--user", "disable", "--now", "stash-background.service"],
    });
    assert.deepEqual(calls[1], { command: "systemctl", args: ["--user", "daemon-reload"] });
    assert.deepEqual(calls[2], {
      command: "systemctl",
      args: ["--user", "enable", "--now", "stash-background.service"],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service install: unsupported platforms fail clearly", async () => {
  const home = await makeTempHome("stash-service-unsupported");

  try {
    const service = createServiceController({
      platform: "win32",
      homeDir: home,
      exec: async () => {
        throw new Error("exec should not be called");
      },
    });

    await assert.rejects(
      service.install({
        name: "stash-background",
        description: "Stash background sync",
        command: "/usr/local/bin/stash",
        args: ["background", "watch"],
      }),
      /not supported on this platform yet/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service module: source files do not import stash code", async () => {
  const serviceDir = join(process.cwd(), "src", "service");
  const files = await readdir(serviceDir);

  for (const file of files) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = await readFile(join(serviceDir, file), "utf8");
    assert.equal(source.includes("../stash.ts"), false, file);
    assert.equal(source.includes("./../stash.ts"), false, file);
    assert.equal(source.includes('"../stash.ts"'), false, file);
    assert.equal(source.includes("'../stash.ts'"), false, file);
  }
});
