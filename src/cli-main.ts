import { existsSync } from "node:fs";
import { access, constants, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
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
import type { LocalConfig } from "./local-config.ts";
import { readLocalConfig, writeLocalConfig } from "./local-config.ts";
import { runDaemon } from "./daemon.ts";
import { needsMigration } from "./migrations.ts";
import { providers } from "./providers/index.ts";
import { Stash } from "./stash.ts";
import { createColors } from "./ui/color.ts";
import { formatTimeAgo } from "./ui/format.ts";
import { LiveLine } from "./ui/live-line.ts";
import { SyncRenderer } from "./ui/sync-renderer.ts";
import { watch as watchStash } from "./watch.ts";
import type { Field, GlobalConfig, ProviderClass, StatusResult } from "./types.ts";

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

const STASH_CONFIG_KEYS = new Set(["allow-git"]);

function isStashConfigKey(key: string): key is "allow-git" {
  return STASH_CONFIG_KEYS.has(key);
}

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

async function bounceDaemonIfMigrationNeeded(
  dir: string,
  getService: () => Promise<ServiceHandle>,
): Promise<boolean> {
  if (!isStashDirectory(dir) || !(await needsMigration(dir))) {
    return false;
  }
  try {
    const service = await getService();
    const status = await service.status();
    if (!status.running) {
      return false;
    }
    await service.uninstall();
    return true;
  } catch {
    return false;
  }
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

function renderGitWarning(stdout: NodeJS.WriteStream): void {
  const { dim, yellow } = createColors(stdout);
  writeLine(
    stdout,
    `${yellow("Warning:")} ${dim("This directory contains .git. Stash will not sync until you either:")}`,
  );
  writeLine(stdout, dim("  - remove .git, or"));
  writeLine(
    stdout,
    dim('  - run `stash config set allow-git true` (see "Using stash with git" in the README)'),
  );
}

async function warnIfGitSyncBlocked(dir: string, stdout: NodeJS.WriteStream): Promise<void> {
  if (!existsSync(join(dir, ".git"))) {
    return;
  }
  const localConfig = await readLocalConfig(dir);
  if (localConfig["allow-git"] === true) {
    return;
  }
  renderGitWarning(stdout);
}

function parseConfigValue(key: "allow-git", value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid value for ${key}: expected true or false`);
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
  connectionName: string | undefined,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: Required<Pick<CliDependencies, "cwd" | "readGlobalConfig" | "writeGlobalConfig">> & {
    getService?: () => Promise<ServiceHandle>;
  },
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { dim, green } = createColors(stdout);
  const provider = getProvider(providerName);
  const resolvedConnectionName = connectionName ?? providerName;
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
  if (stash.connections[resolvedConnectionName]) {
    throw new Error(`Connection already exists: ${resolvedConnectionName}`);
  }
  const connectValues = await collectFields(provider.spec.connect, valuesFromCli);
  await stash.connect({
    name: resolvedConnectionName,
    provider: providerName,
    ...connectValues,
  });
  globalConfig = await deps.readGlobalConfig();
  await deps.writeGlobalConfig(addBackgroundStash(globalConfig, resolve(dir)));

  writeLine(stdout, `Connected ${resolvedConnectionName}.`);
  await warnIfGitSyncBlocked(dir, stdout);

  if (!deps.getService) {
    return;
  }

  try {
    const status = await (await deps.getService()).status();
    if (status.running) {
      writeLine(
        stdout,
        `${green("Background sync is on")} ${dim("·")} ${dim("This stash is now syncing automatically")}`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Could not resolve a command to run `stash daemon`"
    ) {
      return;
    }
    if (!isUnsupportedPlatformError(error)) {
      throw error;
    }
  }
}

function formatConnectionLabel(name: string, provider: string): string {
  return `${name} (${provider})`;
}

function validateDisconnectSelection(
  name: string | undefined,
  all: boolean,
  targetPath: string | undefined,
): { name?: string; all: boolean; targetPath?: string } {
  const selected = [name ? "name" : null, all ? "all" : null, targetPath ? "path" : null].filter(
    (value): value is string => value !== null,
  );
  if (selected.length === 0) {
    throw new Error(
      "argument required — run `stash disconnect <name>`, `stash disconnect --all`, or `stash disconnect --path <path>`",
    );
  }
  if (selected.length > 1) {
    throw new Error(
      "disconnect modes are mutually exclusive — use only one of `<name>`, `--all`, or `--path <path>`",
    );
  }
  return { name, all, targetPath };
}

function formatConnectionSummary(status: StatusResult): string {
  const parts = formatChangeParts(status);
  if (status.lastSync) {
    const ago = formatTimeAgo(status.lastSync);
    return parts.length > 0
      ? `Local changes: ${parts.join(", ")} · synced ${ago}`
      : `Up to date · synced ${ago}`;
  }
  if (parts.length > 0) {
    return `Local changes: ${parts.join(", ")} · Never synced`;
  }
  return "Waiting for first sync";
}

async function runDisconnect(
  name: string | undefined,
  all: boolean,
  targetPath: string | undefined,
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  writeConfig: (config: GlobalConfig) => Promise<void>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const selection = validateDisconnectSelection(name, all, targetPath);
  const globalConfig = await readConfig();
  if (selection.targetPath) {
    const resolvedPath = resolve(selection.targetPath);
    const wasRegistered = getBackgroundStashes(globalConfig).includes(resolvedPath);
    if (!wasRegistered) {
      writeLine(stdout, "No stash registered at that path.");
      return;
    }
    await writeConfig(removeBackgroundStash(globalConfig, resolvedPath));
    if (existsSync(resolvedPath)) {
      await rm(join(resolvedPath, ".stash"), { recursive: true, force: true });
    }
    writeLine(stdout, "Disconnected stash.");
    return;
  }

  const dir = cwd();
  const stash = await Stash.load(dir, globalConfig);

  if (selection.all) {
    for (const name of Object.keys(stash.connections)) {
      await stash.disconnect(name);
    }
    await writeConfig(removeBackgroundStash(globalConfig, resolve(dir)));
    await rm(join(dir, ".stash"), { recursive: true, force: true });
    writeLine(stdout, "Disconnected stash.");
    return;
  }

  const connectionName = selection.name!;
  if (!stash.connections[connectionName]) {
    throw new Error(`Connection not found: ${connectionName}`);
  }

  await stash.disconnect(connectionName);
  if (Object.keys(stash.connections).length === 0) {
    await writeConfig(removeBackgroundStash(globalConfig, resolve(dir)));
    await rm(join(dir, ".stash"), { recursive: true, force: true });
  }
  writeLine(stdout, `Disconnected ${connectionName}.`);
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
    throw new Error("no connection configured — run `stash connect <provider> <name>` first");
  }
  await watchStash(stash, { dir, stdin: process.stdin, stdout: process.stdout });
}

function formatChangeParts(status: {
  added: string[];
  modified: string[];
  deleted: string[];
}): string[] {
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
    writeLine(
      stdout,
      "No stashes connected yet — run `stash connect <provider> <name>` in a directory to get started",
    );
    return;
  }

  try {
    const current = await serviceHandle.status();
    if (current.running) {
      writeLine(
        stdout,
        `${green("Background sync is on")} ${dim("·")} ${dim(`watching ${formatStashCount(stashes.length)}`)}`,
      );
    } else {
      writeLine(stdout, red("Background sync is off"));
      writeLine(
        stdout,
        dim(`Run \`stash start\` to resume syncing ${formatStashCount(stashes.length)}`),
      );
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
      for (const connectionName of connectionNames) {
        const connection = stash.connections[connectionName];
        writeLine(
          stdout,
          `  ${formatConnectionLabel(connectionName, connection.provider)} ${dim("·")} ${red(persistedStatus.error ?? "unknown error")}`,
        );
      }
      continue;
    }

    writeLine(stdout, `${green("●")} ${title}`);
    writeLine(stdout, dim(`  ${dir}`));

    for (const connectionName of connectionNames) {
      const connection = stash.connections[connectionName];
      if (persistedStatus === null || localStatus.lastSync === null) {
        writeLine(
          stdout,
          `  ${formatConnectionLabel(connectionName, connection.provider)} ${dim("·")} ${dim("Waiting for first sync")}`,
        );
        continue;
      }

      writeLine(
        stdout,
        `  ${formatConnectionLabel(connectionName, connection.provider)} ${dim("·")} ${dim(formatConnectionSummary(localStatus))}`,
      );
    }
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

async function ensureInitializedStash(
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
): Promise<string> {
  const dir = cwd();
  await Stash.load(dir, await readConfig());
  return dir;
}

async function runConfigSet(
  key: string,
  value: string,
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  if (!isStashConfigKey(key)) {
    throw new Error(`Unknown config key: ${key}`);
  }
  const dir = await ensureInitializedStash(cwd, readConfig);
  const currentConfig = await readLocalConfig(dir);
  const nextConfig: LocalConfig = {
    ...currentConfig,
    [key]: parseConfigValue(key, value),
  };
  await writeLocalConfig(dir, nextConfig);
  writeLine(stdout, `${key}=${String(nextConfig[key])}`);
}

async function runConfigGet(
  key: string,
  cwd: () => string,
  readConfig: () => Promise<GlobalConfig>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  if (!isStashConfigKey(key)) {
    throw new Error(`Unknown config key: ${key}`);
  }
  const dir = await ensureInitializedStash(cwd, readConfig);
  const localConfig = await readLocalConfig(dir);
  const value = localConfig[key];
  writeLine(stdout, value === undefined ? "" : String(value));
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

  const dirsToCheck = [cwd()];
  try {
    const config = await readConfig();
    dirsToCheck.push(...getBackgroundStashes(config));
  } catch {
    // Global config unreadable — skip migration check.
  }
  let daemonBounced = false;
  for (const dir of dirsToCheck) {
    if (await bounceDaemonIfMigrationNeeded(dir, getService)) {
      daemonBounced = true;
      break;
    }
  }

  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

  const program = new Command()
    .name("stash")
    .description("Conflict-free synced folders")
    .version(version, "-v, --version")
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
    .argument("[name]", "Connection name")
    .allowUnknownOption(true)
    .action(
      async (
        providerName: string,
        connectionName: string | undefined,
        _opts: unknown,
        command: Command,
      ) => {
        const opts = command.opts() as Record<string, string | boolean | undefined>;
        await runConnect(
          providerName,
          connectionName,
          opts,
          {
            cwd,
            readGlobalConfig: readConfig,
            writeGlobalConfig: writeConfig,
            getService,
          },
          stdout,
        );
      },
    );

  program
    .command("disconnect")
    .description("Disconnect a named connection or stash")
    .argument("[name]", "Connection name")
    .option("--all", "Disconnect all connections in the current stash")
    .option("--path <path>", "Disconnect a stash by path")
    .action(async (name: string | undefined, options: { all?: boolean; path?: string }) => {
      await runDisconnect(
        name,
        options.all === true,
        options.path,
        cwd,
        readConfig,
        writeConfig,
        stdout,
      );
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
    .description("Show all connected stashes")
    .action(async () => {
      await runStatusAll(readConfig, await getService(), stdout);
    });

  const configCommand = program.command("config").description("Manage stash config");

  configCommand
    .command("set")
    .description("Set a stash config value")
    .argument("<key>", "Config key")
    .argument("<value>", "Config value")
    .action((key: string, value: string) => runConfigSet(key, value, cwd, readConfig, stdout));

  configCommand
    .command("get")
    .description("Get a stash config value")
    .argument("<key>", "Config key")
    .action((key: string) => runConfigGet(key, cwd, readConfig, stdout));

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

  const skipRestart = commandName === "stop" || commandName === "daemon";
  if (daemonBounced && !skipRestart) {
    try {
      await (await getService()).install();
    } catch {
      // Best-effort restart — service may be unsupported or unavailable.
    }
  }
}
