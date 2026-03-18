import { existsSync } from "node:fs";
import { access, constants, readFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { Daemon, UnsupportedPlatformError } from "@rupertsworld/daemon";
import { Command, Option } from "commander";
import { input, password } from "@inquirer/prompts";
import {
  addBackgroundStash,
  getBackgroundStashes,
  getProviderConfig,
  readGlobalConfig,
  removeBackgroundStash,
  setProviderConfig,
  writeGlobalConfig,
} from "./global-config.ts";
import { runDaemon } from "./daemon.ts";
import { providers } from "./providers/index.ts";
import { Stash } from "./stash.ts";
import { createColors } from "./ui/color.ts";
import { formatTimeAgo } from "./ui/format.ts";
import { LiveLine } from "./ui/live-line.ts";
import { SyncRenderer } from "./ui/sync-renderer.ts";
import { watch as watchStash } from "./watch.ts";
import type { Field, GlobalConfig, ProviderClass } from "./types.ts";

const SERVICE_NAME = "stash-background";
const SERVICE_DESCRIPTION = "Stash background sync";

type ServiceHandle = {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<{ installed: boolean; running: boolean }>;
};

type CliDependencies = {
  cwd?: () => string;
  readGlobalConfig?: () => Promise<GlobalConfig>;
  writeGlobalConfig?: (config: GlobalConfig) => Promise<void>;
  service?: ServiceHandle;
  runDaemon?: () => Promise<void>;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
};

type PersistedBackgroundStatus = {
  kind?: string;
  lastSync?: string | null;
  summary?: string | null;
  error?: string | null;
};

function getProvider(name: string): ProviderClass {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(`${text}\n`);
}

function isUnsupportedPlatformError(error: unknown): boolean {
  return error instanceof UnsupportedPlatformError;
}

export async function resolveStashCommand(): Promise<string> {
  const argvPath = process.argv[1];
  if (argvPath && basename(argvPath) === "stash") {
    const candidate = resolve(argvPath);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    if (!pathEntry) {
      continue;
    }
    const candidate = join(pathEntry, "stash");
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find the `stash` binary on PATH");
}

async function promptField(field: Field): Promise<string> {
  if (field.secret) {
    return password({ message: field.label });
  }
  return input({ message: field.label });
}

async function collectFields(
  fields: Field[],
  valuesFromCli: Record<string, string | boolean | undefined>,
  current: Record<string, string> = {},
): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...current };
  for (const field of fields) {
    if (values[field.name]) {
      continue;
    }
    const cliValue = valuesFromCli[field.name];
    if (typeof cliValue === "string") {
      values[field.name] = cliValue;
      continue;
    }
    values[field.name] = await promptField(field);
  }
  return values;
}

async function readBackgroundStatus(dir: string): Promise<PersistedBackgroundStatus | null> {
  const statusPath = join(dir, ".stash", "status.json");
  if (!existsSync(statusPath)) {
    return null;
  }
  return JSON.parse(await readFile(statusPath, "utf8")) as PersistedBackgroundStatus;
}

async function warnIfServiceUnavailable(
  serviceHandle: ServiceHandle | undefined,
  stderr: NodeJS.WriteStream,
): Promise<void> {
  if (!serviceHandle) {
    return;
  }
  try {
    const status = await serviceHandle.status();
    if (!status.installed) {
      writeLine(stderr, "warning: background service is not installed");
    }
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      writeLine(
        stderr,
        "warning: service install is not supported on this platform yet; run `stash background watch` manually",
      );
      return;
    }
    throw error;
  }
}

async function runSetup(
  providerName: string,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: Required<Pick<CliDependencies, "readGlobalConfig" | "writeGlobalConfig">>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const provider = getProvider(providerName);
  let globalConfig = await deps.readGlobalConfig();
  const values = await collectFields(
    provider.spec.setup,
    valuesFromCli,
    getProviderConfig(globalConfig, providerName),
  );
  globalConfig = setProviderConfig(globalConfig, providerName, values);
  await deps.writeGlobalConfig(globalConfig);
  writeLine(stdout, `Configured ${providerName}.`);
}

async function runInit(
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const dir = cwd();
  const alreadyInitialized = existsSync(join(dir, ".stash"));
  await Stash.init(dir, await readConfig());
  writeLine(stdout, alreadyInitialized ? "Already initialized." : "Initialized stash.");
}

async function registerBackgroundStash(
  dir: string,
  readConfig: () => Promise<GlobalConfig>,
  writeConfig: (config: GlobalConfig) => Promise<void>,
  serviceHandle: ServiceHandle | undefined,
  stderr: NodeJS.WriteStream,
): Promise<void> {
  const globalConfig = await readConfig();
  const stash = await Stash.load(dir, globalConfig);
  if (Object.keys(stash.connections).length === 0) {
    writeLine(stderr, "warning: this stash won't sync until a provider is connected");
  }
  await writeConfig(addBackgroundStash(globalConfig, dir));
  await warnIfServiceUnavailable(serviceHandle, stderr);
}

async function runConnect(
  providerName: string,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: Required<Pick<CliDependencies, "cwd" | "readGlobalConfig" | "writeGlobalConfig">> & {
    service?: ServiceHandle;
  },
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): Promise<void> {
  const provider = getProvider(providerName);
  let globalConfig = await deps.readGlobalConfig();
  const setupValues = await collectFields(
    provider.spec.setup,
    valuesFromCli,
    getProviderConfig(globalConfig, providerName),
  );
  globalConfig = setProviderConfig(globalConfig, providerName, setupValues);
  await deps.writeGlobalConfig(globalConfig);

  const dir = deps.cwd();
  const stash = await Stash.init(dir, globalConfig);
  const connectValues = await collectFields(provider.spec.connect, valuesFromCli);
  await stash.connect(providerName, connectValues);

  if (valuesFromCli.background === true) {
    await registerBackgroundStash(
      dir,
      deps.readGlobalConfig,
      deps.writeGlobalConfig,
      deps.service,
      stderr,
    );
  }

  writeLine(stdout, `Connected ${providerName}.`);
}

async function runDisconnect(
  providerName: string,
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const stash = await Stash.load(cwd(), await readConfig());
  await stash.disconnect(providerName);
  writeLine(stdout, `Disconnected ${providerName}.`);
}

async function runSync(cwd: () => string, readConfig: () => Promise<GlobalConfig>): Promise<void> {
  const stash = await Stash.load(cwd(), await readConfig());
  const line = new LiveLine(process.stdout);
  const { green, red } = line.colors;
  const renderer = new SyncRenderer(line);
  const subscription = stash.on("mutation", (mutation) => {
    renderer.onMutation(mutation);
  });

  line.startSpinner("checking...");

  try {
    await stash.sync();
    const summary = renderer.done();
    line.print(summary ? `${green("✓")} synced (${summary})` : `${green("✓")} up to date`);
  } catch (error) {
    renderer.error(error as Error);
    line.print(
      `${red("✗")} sync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    subscription.dispose();
    renderer.dispose();
    line.dispose();
  }
}

async function runWatch(cwd: () => string, readConfig: () => Promise<GlobalConfig>): Promise<void> {
  const dir = cwd();
  const stash = await Stash.load(dir, await readConfig());
  if (Object.keys(stash.connections).length === 0) {
    throw new Error("no connection configured — run `stash connect <provider>` first");
  }
  await watchStash(stash, { dir, stdin: process.stdin, stdout: process.stdout });
}

function formatChangeParts(status: { added: string[]; modified: string[]; deleted: string[] }): string[] {
  const parts: string[] = [];
  if (status.added.length > 0) parts.push(`${status.added.length} added`);
  if (status.modified.length > 0) parts.push(`${status.modified.length} modified`);
  if (status.deleted.length > 0) parts.push(`${status.deleted.length} deleted`);
  return parts;
}

async function runStatus(
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, green, yellow } = createColors(stdout);
  const stash = await Stash.load(cwd(), await readConfig());
  const connectionNames = Object.keys(stash.connections);

  if (connectionNames.length === 0) {
    writeLine(stdout, dim("no connections — run `stash connect <provider>` to get started"));
    return;
  }

  const status = stash.status();
  const parts = formatChangeParts(status);

  for (const name of connectionNames) {
    const conn = stash.connections[name];
    const label = conn.repo ?? Object.values(conn).join(", ");
    const dot = parts.length > 0 ? yellow("●") : green("●");
    writeLine(stdout, `${dot} ${name}  ${dim(label)}`);

    if (status.lastSync) {
      const ago = formatTimeAgo(status.lastSync);
      if (parts.length > 0) {
        writeLine(stdout, `  ${parts.join(", ")} ${dim("·")} ${dim(`synced ${ago}`)}`);
      } else {
        writeLine(stdout, dim(`  up to date · synced ${ago}`));
      }
    } else if (parts.length > 0) {
      writeLine(stdout, `  ${parts.join(", ")} ${dim("·")} ${dim("never synced")}`);
    } else {
      writeLine(stdout, dim("  never synced"));
    }
  }
}

async function runBackgroundInstall(
  serviceHandle: ServiceHandle,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  await serviceHandle.install();
  writeLine(stdout, "Installed background service.");
}

async function runBackgroundUninstall(
  serviceHandle: ServiceHandle,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  await serviceHandle.uninstall();
  writeLine(stdout, "Uninstalled background service.");
}

async function runBackgroundAdd(
  dirArg: string | undefined,
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  writeConfig: (config: GlobalConfig) => Promise<void>,
  serviceHandle: ServiceHandle | undefined,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): Promise<void> {
  const dir = resolve(dirArg ?? cwd());
  await registerBackgroundStash(dir, readConfig, writeConfig, serviceHandle, stderr);
  writeLine(stdout, `Registered ${dir} for background sync.`);
}

async function runBackgroundRemove(
  dirArg: string | undefined,
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  writeConfig: (config: GlobalConfig) => Promise<void>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const dir = resolve(dirArg ?? cwd());
  const globalConfig = await readConfig();
  await writeConfig(removeBackgroundStash(globalConfig, dir));
  writeLine(stdout, `Removed ${dir} from background sync.`);
}

async function runBackgroundStatus(
  readConfig: () => Promise<GlobalConfig>,
  serviceHandle: ServiceHandle,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, green, red } = createColors(stdout);

  let serviceRunning = false;
  let serviceMessage: string | null = null;
  try {
    const current = await serviceHandle.status();
    if (!current.installed) {
      serviceMessage = dim("service not installed — run `stash background install`");
    } else if (current.running) {
      serviceRunning = true;
    } else {
      serviceMessage = red("background service is stopped — run `stash background install` to restart");
    }
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      serviceMessage = dim("service install not supported on this platform — run `stash background watch` manually");
    } else {
      throw error;
    }
  }

  const globalConfig = await readConfig();
  const stashes = getBackgroundStashes(globalConfig);
  if (serviceRunning) {
    writeLine(stdout, dim("stash is syncing in the background"));
  } else if (serviceMessage) {
    writeLine(stdout, serviceMessage);
  }

  if (stashes.length === 0) {
    writeLine(stdout, dim("\nno stashes registered — run `stash background add` to add one"));
    return;
  }

  writeLine(stdout, "");

  for (const dir of stashes) {
    if (!existsSync(dir)) {
      writeLine(stdout, `${red("✗")} ${dir}`);
      writeLine(stdout, dim("  directory not found"));
      continue;
    }

    const status = await readBackgroundStatus(dir);
    if (!status) {
      writeLine(stdout, `${dim("○")} ${dir}`);
      writeLine(stdout, dim("  waiting for first sync"));
      continue;
    }

    if (status.kind === "error") {
      writeLine(stdout, `${red("✗")} ${dir}`);
      const ago = status.lastSync ? formatTimeAgo(new Date(status.lastSync)) : null;
      const errorMsg = status.error ?? "unknown error";
      writeLine(stdout, ago ? `  ${red(errorMsg)} ${dim("·")} ${dim(`synced ${ago}`)}` : `  ${red(errorMsg)}`);
      continue;
    }

    const ago = status.lastSync ? formatTimeAgo(new Date(status.lastSync)) : null;
    if (status.summary) {
      writeLine(stdout, `${green("●")} ${dir}`);
      writeLine(stdout, `  ${status.summary} ${dim("·")} ${dim(`synced ${ago ?? "unknown"}`)}`);
    } else {
      writeLine(stdout, `${green("●")} ${dir}`);
      writeLine(stdout, dim(`  up to date · synced ${ago ?? "unknown"}`));
    }
  }

}

function addFieldOptions(command: Command, fields: Field[]): void {
  for (const field of fields) {
    command.addOption(new Option(`--${field.name} <value>`, field.label));
  }
}

async function createDefaultService(): Promise<ServiceHandle> {
  const command = await resolveStashCommand();
  return new Daemon({
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    command,
    args: ["background", "watch"],
    env: process.env.PATH ? { PATH: process.env.PATH } : undefined,
  });
}

export async function main(argv = process.argv, deps: CliDependencies = {}): Promise<void> {
  const cwd = deps.cwd ?? (() => process.cwd());
  const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
  const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
  const serviceHandle = deps.service;
  const getService = async () => serviceHandle ?? (await createDefaultService());
  const runDaemonCommand = deps.runDaemon ?? runDaemon;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const program = new Command()
    .name("stash")
    .description("Conflict-free synced folders")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: (text) => {
        stderr.write(text);
      },
    });

  const setupCommand = program
    .command("setup")
    .description("Configure global provider settings")
    .argument("<provider>", "Provider name")
    .allowUnknownOption(true)
    .action(async (providerName: string, _opts: unknown, command: Command) => {
      await runSetup(
        providerName,
        command.opts() as Record<string, string | boolean | undefined>,
        { readGlobalConfig: readConfig, writeGlobalConfig: writeConfig },
        stdout,
      );
    });

  const connectCommand = program
    .command("connect")
    .description("Connect this stash to a provider")
    .argument("<provider>", "Provider name")
    .option("--background", "Register this stash for background syncing")
    .allowUnknownOption(true)
    .action(async (providerName: string, _opts: unknown, command: Command) => {
      const opts = command.opts() as Record<string, string | boolean | undefined>;
      const svc = opts.background === true ? await getService() : undefined;
      await runConnect(
        providerName,
        opts,
        {
          cwd,
          readGlobalConfig: readConfig,
          writeGlobalConfig: writeConfig,
          service: svc,
        },
        stdout,
        stderr,
      );
    });

  program
    .command("disconnect")
    .description("Disconnect provider from this stash")
    .argument("<provider>", "Provider name")
    .action(async (providerName: string) => {
      await runDisconnect(providerName, cwd, readConfig, stdout);
    });

  program
    .command("init")
    .description("Initialize the current directory as a stash")
    .action(() => {
      return runInit(cwd, readConfig, stdout);
    });
  program
    .command("sync")
    .description("Sync local files with connections")
    .action(() => runSync(cwd, readConfig));
  program
    .command("watch")
    .description("Watch and sync continuously")
    .action(() => runWatch(cwd, readConfig));
  program
    .command("status")
    .description("Show local stash status")
    .action(() => runStatus(cwd, readConfig, stdout));

  const backgroundCommand = program.command("background").description("Manage background syncing");

  backgroundCommand
    .command("install")
    .description("Install the background service")
    .action(async () => runBackgroundInstall(await getService(), stdout));

  backgroundCommand
    .command("uninstall")
    .description("Remove the background service")
    .action(async () => runBackgroundUninstall(await getService(), stdout));

  backgroundCommand
    .command("add")
    .description("Register a stash for background syncing")
    .argument("[dir]", "Stash directory")
    .action(async (dirArg?: string) => {
      const svc = await getService().catch(() => undefined);
      await runBackgroundAdd(dirArg, cwd, readConfig, writeConfig, svc, stdout, stderr);
    });

  backgroundCommand
    .command("remove")
    .description("Unregister a stash from background syncing")
    .argument("[dir]", "Stash directory")
    .action((dirArg?: string) => runBackgroundRemove(dirArg, cwd, readConfig, writeConfig, stdout));

  backgroundCommand
    .command("status")
    .description("Show background service and stash status")
    .action(async () => runBackgroundStatus(readConfig, await getService(), stdout));

  backgroundCommand
    .command("watch", { hidden: true })
    .description("Run the background daemon")
    .action(() => runDaemonCommand());

  const commandName = argv[2];
  const providerName = argv[3];
  if (providerName && (commandName === "setup" || commandName === "connect")) {
    const provider = providers[providerName];
    if (provider) {
      if (commandName === "setup") {
        addFieldOptions(setupCommand, provider.spec.setup);
      } else {
        addFieldOptions(connectCommand, [...provider.spec.setup, ...provider.spec.connect]);
      }
    }
  }

  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(argv);
}
