import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ServiceInstallOptions = {
  name: string;
  description: string;
  command: string;
  args: string[];
};

type ServiceUninstallOptions = {
  name: string;
};

type ServiceStatus = {
  installed: boolean;
  running: boolean;
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

type ControllerOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  exec?: ExecFn;
};

function unsupportedPlatformError(): Error {
  return new Error("not supported on this platform yet");
}

function plistPath(home: string, name: string): string {
  return join(home, "Library", "LaunchAgents", `${name}.plist`);
}

function unitPath(home: string, name: string): string {
  return join(home, ".config", "systemd", "user", `${name}.service`);
}

function renderLaunchdPlist(options: ServiceInstallOptions, env?: Record<string, string>): string {
  const programArguments = [options.command, ...options.args]
    .map((arg) => `    <string>${arg}</string>`)
    .join("\n");

  let envBlock = "";
  if (env && Object.keys(env).length > 0) {
    const entries = Object.entries(env)
      .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
      .join("\n");
    envBlock = `\n  <key>EnvironmentVariables</key>\n  <dict>\n${entries}\n  </dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${options.name}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>${envBlock}
</dict>
</plist>
`;
}

function quoteSystemdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderSystemdUnit(options: ServiceInstallOptions): string {
  const execStart = [options.command, ...options.args].map(quoteSystemdArg).join(" ");
  return `[Unit]
Description=${options.description}

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function defaultExec(command: string, args: string[]): Promise<ExecResult> {
  const result = await execFileAsync(command, args);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function createServiceController(options: ControllerOptions = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const exec = options.exec ?? defaultExec;

  return {
    async install(service: ServiceInstallOptions): Promise<void> {
      if (platform === "darwin") {
        const path = plistPath(home, service.name);
        if (existsSync(path)) {
          await exec("launchctl", ["unload", "-w", path]).catch(() => undefined);
        }
        await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
        const env = process.env.PATH ? { PATH: process.env.PATH } : undefined;
        await writeFile(path, renderLaunchdPlist(service, env), "utf8");
        await exec("launchctl", ["load", "-w", path]);
        return;
      }

      if (platform === "linux") {
        const path = unitPath(home, service.name);
        if (existsSync(path)) {
          await exec("systemctl", ["--user", "disable", "--now", `${service.name}.service`]).catch(
            () => undefined,
          );
        }
        await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
        await writeFile(path, renderSystemdUnit(service), "utf8");
        await exec("systemctl", ["--user", "daemon-reload"]);
        await exec("systemctl", ["--user", "enable", "--now", `${service.name}.service`]);
        return;
      }

      throw unsupportedPlatformError();
    },

    async uninstall(service: ServiceUninstallOptions): Promise<void> {
      if (platform === "darwin") {
        const path = plistPath(home, service.name);
        if (existsSync(path)) {
          await exec("launchctl", ["unload", "-w", path]).catch(() => undefined);
          await rm(path, { force: true });
        }
        return;
      }

      if (platform === "linux") {
        const path = unitPath(home, service.name);
        await exec("systemctl", ["--user", "disable", "--now", `${service.name}.service`]).catch(
          () => undefined,
        );
        await rm(path, { force: true });
        await exec("systemctl", ["--user", "daemon-reload"]);
        return;
      }

      throw unsupportedPlatformError();
    },

    async status(service: { name: string }): Promise<ServiceStatus> {
      if (platform === "darwin") {
        const path = plistPath(home, service.name);
        const installed = existsSync(path);
        if (!installed) {
          return { installed: false, running: false };
        }
        try {
          await exec("launchctl", ["list", service.name]);
          return { installed: true, running: true };
        } catch {
          return { installed: true, running: false };
        }
      }

      if (platform === "linux") {
        const path = unitPath(home, service.name);
        const installed = existsSync(path);
        if (!installed) {
          return { installed: false, running: false };
        }
        try {
          const result = await exec("systemctl", [
            "--user",
            "is-active",
            `${service.name}.service`,
          ]);
          return {
            installed: true,
            running: result.stdout.trim() === "" || result.stdout.trim() === "active",
          };
        } catch {
          return { installed: true, running: false };
        }
      }

      throw unsupportedPlatformError();
    },
  };
}
