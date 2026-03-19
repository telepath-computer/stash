import { existsSync } from "node:fs";
import { access, constants, readFile, rm } from "node:fs/promises";
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

type ServiceLaunch = {
  command: string;
  args: string[];
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

function isStashDirectory(dir: string): boolean {
  return existsSync(join(dir, ".stash"));
}

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

export async function resolveServiceLaunch(argv = process.argv): Promise<ServiceLaunch> {
  const invokedPath = argv[1];
  if (invokedPath) {
    const candidate = resolve(invokedPath);
    if (await isExecutable(candidate)) {
      return { command: candidate, args: ["daemon"] };
    }
    if (existsSync(candidate)) {
      return { command: process.execPath, args: [candidate, "daemon"] };
    }
  }

  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    if (!pathEntry) {
      continue;
    }
    const candidate = join(pathEntry, "stash");
    if (await isExecutable(candidate)) {
      return { command: candidate, args: ["daemon"] };
    }
  }

  throw new Error("Could not resolve a command to run `stash daemon`");
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

async function runConnect(
  providerName: string,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: Required<Pick<CliDependencies, "cwd" | "readGlobalConfig" | "writeGlobalConfig">> & {
    getService?: () => Promise<ServiceHandle>;
  },
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, green } = createColors(stdout);
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
  globalConfig = await deps.readGlobalConfig();
  await deps.writeGlobalConfig(addBackgroundStash(globalConfig, resolve(dir)));

  writeLine(stdout, `Connected ${providerName}.`);

  if (!deps.getService) {
    return;
  }

  try {
    const status = await (await deps.getService()).status();
    if (status.running) {
      writeLine(stdout, `${green("Background sync is on")} ${dim("·")} ${dim("This stash is now syncing automatically")}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Could not resolve a command to run `stash daemon`") {
      return;
    }
    if (!isUnsupportedPlatformError(error)) {
      throw error;
    }
  }
}

async function runDisconnect(
  providerName: string | undefined,
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  writeConfig: (config: GlobalConfig) => Promise<void>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const dir = cwd();
  const globalConfig = await readConfig();
  const stash = await Stash.load(dir, globalConfig);

  if (!providerName) {
    for (const name of Object.keys(stash.connections)) {
      await stash.disconnect(name);
    }
    await writeConfig(removeBackgroundStash(globalConfig, resolve(dir)));
    await rm(join(dir, ".stash"), { recursive: true, force: true });
    writeLine(stdout, "Disconnected stash.");
    return;
  }

  await stash.disconnect(providerName);
  if (Object.keys(stash.connections).length === 0) {
    await writeConfig(removeBackgroundStash(globalConfig, resolve(dir)));
    await rm(join(dir, ".stash"), { recursive: true, force: true });
  }
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

function formatStashCount(count: number): string {
  return `${count} ${count === 1 ? "stash" : "stashes"}`;
}

async function runStatusAll(
  readConfig: () => Promise<GlobalConfig>,
  serviceHandle: ServiceHandle,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, green, red } = createColors(stdout);
  const globalConfig = await readConfig();
  const stashes = getBackgroundStashes(globalConfig);

  if (stashes.length === 0) {
    writeLine(stdout, "No stashes connected yet — run `stash connect <provider>` in a directory to add one");
    return;
  }

  try {
    const current = await serviceHandle.status();
    if (current.running) {
      writeLine(stdout, `${green("Background sync is on")} ${dim("·")} ${dim(`watching ${formatStashCount(stashes.length)}`)}`);
    } else {
      writeLine(stdout, red("Background sync is off"));
      writeLine(stdout, dim(`Run \`stash start\` to resume syncing ${formatStashCount(stashes.length)}`));
    }
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      writeLine(stdout, red("Background sync is not supported on this platform"));
    } else {
      throw error;
    }
  }

  writeLine(stdout, "");

  for (const dir of stashes) {
    const title = basename(dir);
    if (!existsSync(dir)) {
      writeLine(stdout, `${red("✗")} ${title}`);
      writeLine(stdout, dim(`  ${dir}`));
      writeLine(stdout, dim("  Directory not found"));
      continue;
    }

    if (!isStashDirectory(dir)) {
      writeLine(stdout, `${red("✗")} ${title}`);
      writeLine(stdout, dim(`  ${dir}`));
      writeLine(stdout, dim("  Not a stash"));
      continue;
    }

    const stash = await Stash.load(dir, globalConfig);
    const persistedStatus = await readBackgroundStatus(dir);
    const localStatus = stash.status();
    const connectionNames = Object.keys(stash.connections);

    if (persistedStatus?.kind === "error") {
      writeLine(stdout, `${red("✗")} ${title}`);
      writeLine(stdout, dim(`  ${dir}`));
      for (const providerName of connectionNames) {
        const conn = stash.connections[providerName];
        const label = conn.repo ?? Object.values(conn).join(", ");
        writeLine(stdout, `  ${providerName}  ${label} ${dim("·")} ${red(persistedStatus.error ?? "unknown error")}`);
      }
      continue;
    }

    writeLine(stdout, `${green("●")} ${title}`);
    writeLine(stdout, dim(`  ${dir}`));

    for (const providerName of connectionNames) {
      const conn = stash.connections[providerName];
      const label = conn.repo ?? Object.values(conn).join(", ");
      if (persistedStatus === null || localStatus.lastSync === null) {
        writeLine(stdout, `  ${providerName}  ${label} ${dim("·")} ${dim("Waiting for first sync")}`);
        continue;
      }

      const parts = formatChangeParts(localStatus);
      if (parts.length > 0) {
        writeLine(
          stdout,
          `  ${providerName}  ${label} ${dim("·")} Local changes: ${parts.join(", ")} ${dim("·")} ${dim(`synced ${formatTimeAgo(localStatus.lastSync)}`)}`,
        );
      } else {
        writeLine(
          stdout,
          `  ${providerName}  ${label} ${dim("·")} ${dim(`Up to date · synced ${formatTimeAgo(localStatus.lastSync)}`)}`,
        );
      }
    }
  }
}

async function runStatus(
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  serviceHandle: ServiceHandle,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, green, yellow, red } = createColors(stdout);
  const dir = cwd();
  if (!isStashDirectory(dir)) {
    throw new Error("Not in a stash directory — run `stash status --all` to view all stashes");
  }

  const globalConfig = await readConfig();
  const stash = await Stash.load(dir, globalConfig);
  const connectionNames = Object.keys(stash.connections);

  if (connectionNames.length === 0) {
    writeLine(stdout, dim("No connections — run `stash connect <provider>` to get started"));
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
        writeLine(stdout, `  Local changes: ${parts.join(", ")} ${dim("·")} ${dim(`synced ${ago}`)}`);
      } else {
        writeLine(stdout, dim(`  Up to date · synced ${ago}`));
      }
    } else if (parts.length > 0) {
      writeLine(stdout, `  Local changes: ${parts.join(", ")} ${dim("·")} ${dim("Never synced")}`);
    } else {
      writeLine(stdout, dim("  Never synced"));
    }
  }

  if (!getBackgroundStashes(globalConfig).includes(resolve(dir))) {
    return;
  }

  try {
    const current = await serviceHandle.status();
    if (current.running) {
      writeLine(stdout, `  ${green("Background sync is on")} ${dim("·")} ${dim("Use `stash status --all` to view all stashes")}`);
    } else {
      writeLine(stdout, `  ${red("Background sync is off")} ${dim("·")} ${dim("Run `stash start` to keep connected stashes in sync")}`);
    }
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      writeLine(stdout, `  ${red("Background sync is not supported on this platform")}`);
      return;
    }
    throw error;
  }
}

async function runStart(
  serviceHandle: ServiceHandle,
  readConfig: () => Promise<GlobalConfig>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, green, red } = createColors(stdout);
  try {
    const current = await serviceHandle.status();
    if (current.installed && current.running) {
      writeLine(stdout, green("Background sync is already running"));
      return;
    }
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      writeLine(stdout, red("Background sync is not supported on this platform"));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  await serviceHandle.install();
  const count = getBackgroundStashes(await readConfig()).length;
  writeLine(stdout, green("Background sync is on"));
  writeLine(stdout, dim(`Watching ${formatStashCount(count)} · starts on startup`));
}

async function runStop(
  serviceHandle: ServiceHandle,
  readConfig: () => Promise<GlobalConfig>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, red } = createColors(stdout);
  try {
    const current = await serviceHandle.status();
    if (!current.installed && !current.running) {
      writeLine(stdout, red("Background sync is not running"));
      return;
    }
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      writeLine(stdout, red("Background sync is not running"));
      return;
    }
    throw error;
  }

  await serviceHandle.uninstall();
  const count = getBackgroundStashes(await readConfig()).length;
  writeLine(stdout, red("Background sync is off"));
  writeLine(stdout, dim(`Run \`stash start\` to resume syncing ${formatStashCount(count)}`));
}

function addFieldOptions(command: Command, fields: Field[]): void {
  for (const field of fields) {
    command.addOption(new Option(`--${field.name} <value>`, field.label));
  }
}

async function createDefaultService(argv = process.argv): Promise<ServiceHandle> {
  const launch = await resolveServiceLaunch(argv);
  return new Daemon({
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    command: launch.command,
    args: launch.args,
    env: process.env.PATH ? { PATH: process.env.PATH } : undefined,
  });
}

export async function main(argv = process.argv, deps: CliDependencies = {}): Promise<void> {
  const cwd = deps.cwd ?? (() => process.cwd());
  const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
  const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
  const serviceHandle = deps.service;
  const getService = async () => serviceHandle ?? (await createDefaultService(argv));
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
    .allowUnknownOption(true)
    .action(async (providerName: string, _opts: unknown, command: Command) => {
      const opts = command.opts() as Record<string, string | boolean | undefined>;
      await runConnect(
        providerName,
        opts,
        {
          cwd,
          readGlobalConfig: readConfig,
          writeGlobalConfig: writeConfig,
          getService,
        },
        stdout,
      );
    });

  program
    .command("disconnect")
    .description("Disconnect provider from this stash")
    .argument("[provider]", "Provider name")
    .action(async (providerName?: string) => {
      await runDisconnect(providerName, cwd, readConfig, writeConfig, stdout);
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
    .option("--all", "Show all connected stashes")
    .action(async (_opts: unknown, command: Command) => {
      const opts = command.opts() as { all?: boolean };
      if (opts.all) {
        await runStatusAll(readConfig, await getService(), stdout);
        return;
      }
      await runStatus(cwd, readConfig, await getService(), stdout);
    });

  program
    .command("start")
    .description("Start background sync")
    .action(async () => runStart(await getService(), readConfig, stdout));

  program
    .command("stop")
    .description("Stop background sync")
    .action(async () => runStop(await getService(), readConfig, stdout));

  program
    .command("daemon", { hidden: true })
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
