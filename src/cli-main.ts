import { existsSync } from "node:fs";
import { access, constants, readdir, realpath, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import Table from "cli-table3";
import { Daemon, UnsupportedPlatformError } from "@rupertsworld/daemon";
import { Command, Option } from "commander";
import {
  CliCommandError,
  cliError,
  createCliUi,
  pluralize,
  shortenHomePath,
} from "./cli-ui.ts";
import {
  getProviderConfig,
  getStashDirPath,
  getStashPath,
  readGlobalConfig,
  setProviderConfig,
  writeGlobalConfig,
} from "./global-config.ts";
import { runDaemon } from "./daemon.ts";
import { writeJsonFile } from "./utils/fs.ts";
import { withRegistryLock } from "./registry-lock.ts";
import { InvalidUriError } from "./errors.ts";
import { providers } from "./providers/index.ts";
import { Stash } from "./stash.ts";
import { formatTimeAgo } from "./ui/format.ts";
import { parseUri } from "./uri.ts";
import type { ConfigItem, GlobalConfig, ProviderClass, StashRecord } from "./types.ts";

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
  stdin?: Readable;
  readGlobalConfig?: () => Promise<GlobalConfig>;
  writeGlobalConfig?: (config: GlobalConfig) => Promise<void>;
  stashPath?: string;
  service?: ServiceHandle;
  runDaemon?: () => Promise<void>;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
};

type PersistedStatus = {
  kind?: string;
  lastSync?: string | null;
  summary?: string | null;
  error?: string | null;
  currentOperation?: string | null;
  pendingChanges?: {
    added?: number;
    modified?: number;
    deleted?: number;
  } | null;
};

type RegistryEntry = {
  id: string;
  record: StashRecord;
};

type SetupDeps = Required<Pick<CliDependencies, "readGlobalConfig" | "writeGlobalConfig">>;

type ConnectDeps = Required<Pick<CliDependencies, "cwd" | "readGlobalConfig" | "writeGlobalConfig">> &
  Pick<CliDependencies, "stashPath"> & {
    getService: () => Promise<ServiceHandle>;
  };

type DisconnectDeps = Required<Pick<CliDependencies, "cwd">> & Pick<CliDependencies, "stashPath">;

type StatusDeps = Pick<CliDependencies, "stashPath"> & {
  getService: () => Promise<ServiceHandle>;
};

function getGlobalConfigItems(provider: ProviderClass): ConfigItem[] {
  return provider.configSchema.filter((item) => item.global === true);
}

function getCliValue(
  field: ConfigItem,
  valuesFromCli: Record<string, string | boolean | undefined>,
): string | undefined {
  const value = valuesFromCli[field.name];
  return typeof value === "string" ? value : undefined;
}

async function promptField(
  ui: ReturnType<typeof createCliUi>,
  field: ConfigItem,
): Promise<string> {
  if (field.secret) {
    return ui.promptPassword(field.label);
  }
  return ui.promptText(field.label);
}

async function collectFields(
  ui: ReturnType<typeof createCliUi>,
  fields: ConfigItem[],
  valuesFromCli: Record<string, string | boolean | undefined>,
  current: Record<string, string> = {},
): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...current };
  for (const field of fields) {
    if (values[field.name]) {
      continue;
    }
    const cliValue = getCliValue(field, valuesFromCli);
    if (cliValue) {
      values[field.name] = cliValue;
      continue;
    }
    values[field.name] = await promptField(ui, field);
  }
  return values;
}

function addFieldOptions(command: Command, fields: ConfigItem[]): void {
  for (const field of fields) {
    command.addOption(new Option(`--${field.name} <value>`, field.label));
  }
}

function getProvider(name: string): ProviderClass {
  const provider = providers[name];
  if (!provider) {
    throw cliError(`Unknown provider: ${name}.`);
  }
  return provider;
}

function isUnsupportedPlatformError(error: unknown): boolean {
  return error instanceof UnsupportedPlatformError;
}

function formatUri(connection: StashRecord["connections"][number]): string {
  return `${connection.provider}:${connection.config.id ?? ""}`;
}

function sameConnection(
  left: StashRecord["connections"][number],
  right: StashRecord["connections"][number],
): boolean {
  return left.provider === right.provider && JSON.stringify(left.config) === JSON.stringify(right.config);
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort((a, b) => a.localeCompare(b));
  const rightKeys = Object.keys(right).sort((a, b) => a.localeCompare(b));
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function asSentence(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return "Unknown error.";
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function toCliCommandError(error: unknown): CliCommandError {
  if (error instanceof CliCommandError) {
    return error;
  }
  if (error instanceof Error) {
    return cliError(asSentence(error.message));
  }
  return cliError(asSentence(String(error)));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
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

async function canonicalizeExistingPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function resolveLookupPath(path: string): Promise<string> {
  try {
    return await canonicalizeExistingPath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return resolve(path);
    }
    throw error;
  }
}

function ensureGitAllowed(path: string, dangerouslyAllowGit: boolean): void {
  if (dangerouslyAllowGit) {
    return;
  }
  if (existsSync(join(path, ".git"))) {
    throw cliError(`${shortenHomePath(path)} is a git repository.`, [
      "Pass --dangerously-allow-git if you really want stash to sync this folder.",
    ]);
  }
}

async function readRegistry(stashPath: string): Promise<RegistryEntry[]> {
  if (!existsSync(stashPath)) {
    return [];
  }
  const entries = await readdir(stashPath, { withFileTypes: true });
  const records: RegistryEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const recordPath = join(stashPath, entry.name, "stash.json");
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8")) as StashRecord;
      records.push({ id: entry.name, record });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return records;
}

async function readPersistedStatus(stashPath: string, id: string): Promise<PersistedStatus | null> {
  try {
    return JSON.parse(
      await readFile(join(getStashDirPath(id, stashPath), "status.json"), "utf8"),
    ) as PersistedStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function describeStatusKind(status: PersistedStatus | null): string {
  if (status?.currentOperation) {
    return status.currentOperation;
  }
  if (!status?.kind) {
    return "never";
  }
  if (status.kind === "checked" || status.kind === "synced") {
    return "idle";
  }
  return status.kind;
}

function formatPendingChanges(status: PersistedStatus | null): string | null {
  const pending = status?.pendingChanges;
  if (!pending) {
    return null;
  }
  const parts: string[] = [];
  if ((pending.modified ?? 0) > 0) {
    parts.push(`${pending.modified} modified`);
  }
  if ((pending.added ?? 0) > 0) {
    parts.push(`${pending.added} added`);
  }
  if ((pending.deleted ?? 0) > 0) {
    parts.push(`${pending.deleted} deleted`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatDaemonState(
  state: "running" | "stopped" | "unsupported" | "error",
  ui: ReturnType<typeof createCliUi>,
): string {
  const { colors } = ui;
  if (state === "running") {
    return `Daemon: ${colors.green("running")}`;
  }
  if (state === "stopped") {
    return `Daemon: ${colors.yellow("stopped")}`;
  }
  return `Daemon: ${colors.red(state)}`;
}

function renderStatusTable(
  entry: RegistryEntry,
  status: PersistedStatus | null,
): string {
  const table = new Table({
    style: {
      head: [],
      border: [],
      compact: true,
    },
    wordWrap: true,
  });

  table.push([
    "Connection",
    entry.record.connections.map((connection) => formatUri(connection)).join("\n"),
  ]);
  table.push(["State", describeStatusKind(status)]);

  if (status?.lastSync) {
    table.push(["Last sync", formatTimeAgo(new Date(status.lastSync))]);
  }

  const pending = formatPendingChanges(status);
  if (pending) {
    table.push(["Pending", pending]);
  }

  if (status?.error) {
    table.push(["Last error", status.error]);
  }

  return table.toString();
}

async function runSetup(
  providerName: string,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: SetupDeps,
  ui: ReturnType<typeof createCliUi>,
): Promise<void> {
  const provider = getProvider(providerName);
  const globalFields = getGlobalConfigItems(provider);
  const globalConfig = await deps.readGlobalConfig();
  const values = await collectFields(
    ui,
    globalFields,
    valuesFromCli,
    getProviderConfig(globalConfig, providerName),
  );
  await deps.writeGlobalConfig(setProviderConfig(globalConfig, providerName, values));
  ui.step(providerName);
  ui.outro(`Configured ${providerName}`);
}

function normalizeConnectArgs(first: string, second?: string): { pathArg?: string; uri: string } {
  if (second) {
    return { pathArg: first, uri: second };
  }
  return { uri: first };
}

function normalizeDisconnectArgs(
  first?: string,
  second?: string,
): { pathArg?: string; uri?: string } {
  if (first && second) {
    return { pathArg: first, uri: second };
  }
  if (first?.includes(":")) {
    return { uri: first };
  }
  return { pathArg: first };
}

async function runConnect(
  first: string,
  second: string | undefined,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: ConnectDeps,
  ui: ReturnType<typeof createCliUi>,
): Promise<void> {
  const { pathArg, uri } = normalizeConnectArgs(first, second);
  const targetPath = pathArg ?? deps.cwd();
  const canonicalPath = await canonicalizeExistingPath(targetPath);
  ensureGitAllowed(canonicalPath, valuesFromCli.dangerouslyAllowGit === true);

  const parsed = parseUri(uri);
  const provider = getProvider(parsed.provider);
  let globalConfig = await deps.readGlobalConfig();
  const existingGlobalValues = getProviderConfig(globalConfig, parsed.provider);
  const globalValues = await collectFields(
    ui,
    getGlobalConfigItems(provider),
    valuesFromCli,
    existingGlobalValues,
  );

  new provider({
    ...existingGlobalValues,
    ...globalValues,
    ...parsed.config,
  });

  if (!sameStringRecord(globalValues, existingGlobalValues)) {
    globalConfig = setProviderConfig(globalConfig, parsed.provider, globalValues);
    await deps.writeGlobalConfig(globalConfig);
  }

  const stashPath = deps.stashPath ?? getStashPath();
  const outcome = await withRegistryLock(
    async () => {
      const entries = await readRegistry(stashPath);
      const found = entries.find((entry) => entry.record.path === canonicalPath);
      const connection = {
        provider: parsed.provider,
        config: parsed.config,
      };

      if (!found) {
        await Stash.create(
          {
            path: canonicalPath,
            connections: [connection],
          },
          globalConfig,
          { stashPath },
        );
        return "connected" as const;
      }

      if (found.record.connections.length === 0) {
        await writeJsonFile(join(getStashDirPath(found.id, stashPath), "stash.json"), {
          ...found.record,
          connections: [connection],
        } satisfies StashRecord);
        return "connected" as const;
      }

      if (found.record.connections.some((existing) => sameConnection(existing, connection))) {
        return "already-connected" as const;
      }

      const displayPath = shortenHomePath(found.record.path);
      throw cliError(`${displayPath} is already connected to ${formatUri(found.record.connections[0])}.`, [
        `Multi-connection per stash is not yet supported. Run \`stash disconnect ${displayPath}\` first.`,
      ]);
    },
    { stashPath },
  );

  if (outcome === "already-connected") {
    ui.outro(`Already connected — ${uri}`);
    return;
  }

  const displayPath = shortenHomePath(canonicalPath);
  ui.step(`${displayPath} → ${uri}`);

  let daemonRunning = false;
  try {
    daemonRunning = (await (await deps.getService()).status()).running;
  } catch (error) {
    if (!isUnsupportedPlatformError(error)) {
      throw error;
    }
  }

  if (daemonRunning) {
    ui.outro("Background sync is on. Run `stash status` to check.");
    return;
  }

  ui.outro(`Connected ${uri} to ${displayPath}`);
}

async function runDisconnect(
  first: string | undefined,
  second: string | undefined,
  deps: DisconnectDeps,
  ui: ReturnType<typeof createCliUi>,
): Promise<void> {
  const { pathArg, uri } = normalizeDisconnectArgs(first, second);
  const lookupPath = await resolveLookupPath(pathArg ?? deps.cwd());
  const stashPath = deps.stashPath ?? getStashPath();

  let disconnectedPath = lookupPath;
  let disconnectedUri = uri ?? "";

  await withRegistryLock(
    async () => {
      const entries = await readRegistry(stashPath);
      const found = entries.find((entry) => entry.record.path === lookupPath);
      if (!found) {
        throw cliError(`No stash found at ${shortenHomePath(lookupPath)}.`);
      }

      const currentUris = found.record.connections.map((connection) => formatUri(connection));
      const displayPath = shortenHomePath(found.record.path);
      let targetUri = uri;
      if (!targetUri) {
        if (currentUris.length === 0) {
          throw cliError(`No active connections at ${displayPath}.`);
        }
        if (currentUris.length !== 1) {
          throw cliError(`Multiple connections at ${displayPath}:`, [
            ...currentUris,
            `Pass the URI to disconnect: stash disconnect ${displayPath} <uri>`,
          ]);
        }
        [targetUri] = currentUris;
      }

      const nextConnections = found.record.connections.filter(
        (connection) => formatUri(connection) !== targetUri,
      );
      if (nextConnections.length === found.record.connections.length) {
        throw cliError(`Connection not found: ${targetUri}.`);
      }

      disconnectedPath = found.record.path;
      disconnectedUri = targetUri;
      await writeJsonFile(join(getStashDirPath(found.id, stashPath), "stash.json"), {
        ...found.record,
        connections: nextConnections,
      } satisfies StashRecord);
    },
    { stashPath },
  );

  ui.outro(`Disconnected ${disconnectedUri} from ${shortenHomePath(disconnectedPath)}`);
}

async function runRelink(
  oldPath: string,
  newPath: string,
  dangerouslyAllowGit: boolean,
  deps: Pick<CliDependencies, "stashPath">,
  ui: ReturnType<typeof createCliUi>,
): Promise<void> {
  const oldCanonical = await resolveLookupPath(oldPath);
  const newCanonical = await canonicalizeExistingPath(newPath);
  ensureGitAllowed(newCanonical, dangerouslyAllowGit);
  const displayOld = shortenHomePath(oldCanonical);
  const displayNew = shortenHomePath(newCanonical);

  if (oldCanonical === newCanonical) {
    ui.outro(`Already linked — ${displayNew}`);
    return;
  }

  const stashPath = deps.stashPath ?? getStashPath();
  await withRegistryLock(
    async () => {
      const entries = await readRegistry(stashPath);
      const current = entries.find((entry) => entry.record.path === oldCanonical);
      if (!current) {
        throw cliError(`No stash found at ${displayOld}.`);
      }
      if (entries.some((entry) => entry.id !== current.id && entry.record.path === newCanonical)) {
        throw cliError(`A stash already exists at ${displayNew}.`);
      }
      await writeJsonFile(join(getStashDirPath(current.id, stashPath), "stash.json"), {
        ...current.record,
        path: newCanonical,
      } satisfies StashRecord);
    },
    { stashPath },
  );

  ui.outro(`${displayOld} → ${displayNew}`);
}

async function runStatus(
  deps: StatusDeps,
  ui: ReturnType<typeof createCliUi>,
): Promise<void> {
  const daemonState = await deps
    .getService()
    .then((service) => service.status())
    .then((status) => (status.running ? "running" : "stopped"))
    .catch((error: unknown) => (isUnsupportedPlatformError(error) ? "unsupported" : "error"));

  ui.step(formatDaemonState(daemonState, ui));

  const stashPath = deps.stashPath ?? getStashPath();
  const entries = (await readRegistry(stashPath))
    .filter((entry) => entry.record.connections.length > 0)
    .sort((a, b) => a.record.path.localeCompare(b.record.path));

  if (entries.length === 0) {
    ui.outro("No stashes registered. Run `stash connect <path> <uri>` to add one.");
    return;
  }

  for (const entry of entries) {
    const displayPath = shortenHomePath(entry.record.path);
    const status = await readPersistedStatus(stashPath, entry.id);
    if (status?.kind === "missing" || !existsSync(entry.record.path)) {
      ui.message([
        `${displayPath} (path missing)`,
        `Run: stash relink ${displayPath} <new-path>`,
      ]);
      continue;
    }

    ui.message([displayPath, renderStatusTable(entry, status)]);
  }

  ui.outro(pluralize(entries.length, "stash"));
}

async function runStart(
  serviceHandle: ServiceHandle,
  ui: ReturnType<typeof createCliUi>,
): Promise<void> {
  try {
    await serviceHandle.install();
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      throw cliError("This platform does not support background services yet.");
    }
    throw error;
  }
  ui.outro("Daemon installed and running");
}

async function runStop(
  serviceHandle: ServiceHandle,
  ui: ReturnType<typeof createCliUi>,
): Promise<void> {
  try {
    const status = await serviceHandle.status();
    if (!status.running) {
      throw cliError("Daemon is not running.");
    }
    await serviceHandle.uninstall();
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      throw cliError("This platform does not support background services yet.");
    }
    throw error;
  }
  ui.outro("Daemon stopped");
}

export async function main(argv = process.argv, deps: CliDependencies = {}): Promise<number> {
  const cwd = deps.cwd ?? (() => process.cwd());
  const input = deps.stdin ?? process.stdin;
  const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
  const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
  const stashPath = deps.stashPath ?? getStashPath();
  const serviceHandle = deps.service;
  const getService = async () => serviceHandle ?? (await createDefaultService(argv));
  const runDaemonCommand = deps.runDaemon ?? runDaemon;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const ui = createCliUi({ input, output: stdout });
  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
  let exitCode = 0;

  async function runCommand(title: string, action: () => Promise<void>): Promise<void> {
    ui.intro(`stash ${title}`);
    try {
      await action();
    } catch (error) {
      exitCode = 1;
      ui.renderError(toCliCommandError(error));
    }
  }

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
    .description("Configure provider settings")
    .argument("<provider>", "Provider name")
    .allowUnknownOption(true)
    .action(async (providerName: string, _opts: unknown, command: Command) => {
      await runCommand("setup", async () => {
        await runSetup(
          providerName,
          command.opts() as Record<string, string | boolean | undefined>,
          { readGlobalConfig: readConfig, writeGlobalConfig: writeConfig },
          ui,
        );
      });
    });

  const connectCommand = program
    .command("connect")
    .description("Connect a path to a provider URI")
    .argument("<first>", "URI or explicit path")
    .argument("[second]", "URI when an explicit path is provided")
    .allowUnknownOption(true)
    .option("--dangerously-allow-git", "Allow syncing a git repository")
    .action(async (first: string, second: string | undefined, _opts: unknown, command: Command) => {
      await runCommand("connect", async () => {
        await runConnect(
          first,
          second,
          command.opts() as Record<string, string | boolean | undefined>,
          {
            cwd,
            readGlobalConfig: readConfig,
            writeGlobalConfig: writeConfig,
            stashPath,
            getService,
          },
          ui,
        );
      });
    });

  program
    .command("disconnect")
    .description("Disconnect a stash path or URI")
    .argument("[first]", "Path or URI")
    .argument("[second]", "URI when an explicit path is provided")
    .action(async (first: string | undefined, second: string | undefined) => {
      await runCommand("disconnect", async () => {
        await runDisconnect(first, second, { cwd, stashPath }, ui);
      });
    });

  program
    .command("relink")
    .description("Relink a stash from one path to another")
    .argument("<oldPath>", "Current or missing path")
    .argument("<newPath>", "New existing path")
    .option("--dangerously-allow-git", "Allow relinking to a git repository")
    .action(async (oldPath: string, newPath: string, options: { dangerouslyAllowGit?: boolean }) => {
      await runCommand("relink", async () => {
        await runRelink(
          oldPath,
          newPath,
          options.dangerouslyAllowGit === true,
          { stashPath },
          ui,
        );
      });
    });

  program
    .command("status")
    .description("Show registered stashes")
    .action(async () => {
      await runCommand("status", async () => {
        await runStatus(
          {
            stashPath,
            getService,
          },
          ui,
        );
      });
    });

  program
    .command("start")
    .description("Start background sync")
    .action(async () =>
      runCommand("start", async () => runStart(await getService(), ui)),
    );

  program
    .command("stop")
    .description("Stop background sync")
    .action(async () =>
      runCommand("stop", async () => runStop(await getService(), ui)),
    );

  program
    .command("daemon", { hidden: true })
    .description("Run the background daemon")
    .action(() => runDaemonCommand());

  const commandName = argv[2];
  const providerToken =
    commandName === "connect" && argv[4] && !argv[3]?.includes(":") ? argv[4] : argv[3];
  if (providerToken && (commandName === "setup" || commandName === "connect")) {
    try {
      const uriProvider =
        commandName === "connect" && providerToken.includes(":")
          ? parseUri(providerToken).provider
          : providerToken;
      const provider = providers[uriProvider];
      if (provider) {
        if (commandName === "setup") {
          addFieldOptions(setupCommand, getGlobalConfigItems(provider));
        } else {
          addFieldOptions(connectCommand, getGlobalConfigItems(provider));
        }
      }
    } catch (error) {
      if (!(error instanceof InvalidUriError)) {
        throw error;
      }
    }
  }

  if (argv.length <= 2) {
    program.outputHelp();
    return exitCode;
  }

  await program.parseAsync(argv);
  return exitCode;
}
