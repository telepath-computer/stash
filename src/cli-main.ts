import { existsSync } from "node:fs";
import { access, constants, mkdir, readdir, realpath, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { input as promptInput, password as promptPasswordInput } from "@inquirer/prompts";
import Table from "cli-table3";
import { Daemon, UnsupportedPlatformError } from "@rupertsworld/daemon";
import { Command, Option } from "commander";
import picocolors from "picocolors";
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
const URI_PATTERN = /\b[a-z][a-z0-9-]*:[^\s]+/g;

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

type Colors = ReturnType<typeof createColors>;

type PromptIo = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

export class CliCommandError extends Error {
  readonly summary: string;
  readonly details: string[];

  constructor(summary: string, details: string[] = []) {
    super(summary);
    this.name = "CliCommandError";
    this.summary = summary;
    this.details = details;
  }
}

export function cliError(summary: string, details: string[] = []): CliCommandError {
  return new CliCommandError(summary, details);
}

export function shortenHomePath(path: string, home = process.env.HOME): string {
  if (!home) {
    return path;
  }
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function createColors(isTTY: boolean): ReturnType<typeof picocolors.createColors> {
  return picocolors.createColors(isTTY);
}

export function writeLine(stream: NodeJS.WritableStream, text = ""): void {
  stream.write(`${text}\n`);
}

function writeBlankLine(stream: NodeJS.WritableStream): void {
  writeLine(stream);
}

function isPromptCancelled(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "ExitPromptError" ||
    error.name === "AbortPromptError" ||
    /cancelled|canceled|force closed|sigint/i.test(error.message)
  );
}

export async function promptText(label: string, io: PromptIo = {}): Promise<string> {
  try {
    return await promptInput(
      {
        message: label,
        validate: (candidate) => {
          if (!candidate || candidate.trim().length === 0) {
            return `${label} is required`;
          }
          return true;
        },
      },
      io,
    );
  } catch (error) {
    if (isPromptCancelled(error)) {
      throw cliError("Prompt cancelled.");
    }
    throw error;
  }
}

export async function promptPassword(label: string, io: PromptIo = {}): Promise<string> {
  try {
    return await promptPasswordInput(
      {
        message: label,
        validate: (candidate) => {
          if (!candidate || candidate.trim().length === 0) {
            return `${label} is required`;
          }
          return true;
        },
      },
      io,
    );
  } catch (error) {
    if (isPromptCancelled(error)) {
      throw cliError("Prompt cancelled.");
    }
    throw error;
  }
}

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
  io: PromptIo,
  field: ConfigItem,
): Promise<string> {
  if (field.secret) {
    return promptPassword(field.label, io);
  }
  return promptText(field.label, io);
}

async function collectFields(
  io: PromptIo,
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
    values[field.name] = await promptField(io, field);
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

function colorizeUris(text: string, colors: Colors): string {
  return text.replace(URI_PATTERN, (uri) => {
    const punctuation = /[.,!?]$/.test(uri) ? uri.slice(-1) : "";
    const bareUri = punctuation ? uri.slice(0, -1) : uri;
    return `${colors.cyan(bareUri)}${punctuation}`;
  });
}

function renderCliError(stream: NodeJS.WritableStream, error: CliCommandError, colors: Colors): void {
  writeLine(stream, `${colors.red("Error:")} ${colorizeUris(error.summary, colors)}`);
  for (const detail of error.details) {
    writeLine(stream, colorizeUris(detail, colors));
  }
}

function formatConfigured(providerName: string, colors: Colors): string {
  return `${colors.green("Configured")} ${providerName}`;
}

function formatAlreadyConnected(uri: string, colors: Colors): string {
  return `${colors.green("Already connected")} — ${uri}`;
}

function formatConnected(uri: string, path: string, colors: Colors): string {
  return `${colors.green("Connected")} ${uri} to ${path}`;
}

function formatDisconnected(uri: string, path: string, colors: Colors): string {
  return `${colors.green("Disconnected")} ${uri} from ${path}`;
}

function formatRelinked(oldPath: string, newPath: string, colors: Colors): string {
  return `${colors.green("Relinked")} ${oldPath} → ${newPath}`;
}

function formatAlreadyLinked(path: string, colors: Colors): string {
  return `${colors.green("Already linked")} — ${path}`;
}

function formatConnectHint(colors: Colors): string {
  return colors.gray("Background sync is on. Run `stash status` to check.");
}

function formatDaemonState(state: "running" | "stopped" | "unsupported" | "error", colors: Colors): string {
  if (state === "running") {
    return `Daemon: ${colors.green("running")}`;
  }
  if (state === "stopped") {
    return `Daemon: ${colors.yellow("stopped")}`;
  }
  if (state === "unsupported") {
    return `Daemon: ${colors.yellow("unsupported")}`;
  }
  return `Daemon: ${colors.red("error")}`;
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

function renderStatusTable(
  entry: RegistryEntry,
  status: PersistedStatus | null,
  colors: Colors,
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
    colors.gray("Connection"),
    entry.record.connections.map((connection) => colors.cyan(formatUri(connection))).join("\n"),
  ]);
  const statusKind = describeStatusKind(status);
  table.push([colors.gray("State"), statusKind === "error" ? colors.red(statusKind) : statusKind]);

  if (status?.lastSync) {
    table.push([colors.gray("Last sync"), colors.gray(formatTimeAgo(new Date(status.lastSync)))]);
  }

  const pending = formatPendingChanges(status);
  if (pending) {
    table.push([colors.gray("Pending"), pending]);
  }

  if (status?.error) {
    table.push([colors.gray("Message"), colors.red(status.error)]);
  } else if (status?.summary) {
    table.push([colors.gray("Message"), status.summary]);
  }

  return table.toString();
}

async function runSetup(
  providerName: string,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: SetupDeps,
  io: PromptIo,
  stdout: NodeJS.WritableStream,
  colors: Colors,
): Promise<void> {
  const provider = getProvider(providerName);
  const globalFields = getGlobalConfigItems(provider);
  const globalConfig = await deps.readGlobalConfig();
  const values = await collectFields(io, globalFields, valuesFromCli);
  await deps.writeGlobalConfig(setProviderConfig(globalConfig, providerName, values));
  writeLine(stdout, formatConfigured(providerName, colors));
}

async function runConnect(
  pathArg: string,
  uri: string,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: ConnectDeps,
  io: PromptIo,
  stdout: NodeJS.WritableStream,
  colors: Colors,
): Promise<void> {
  const targetPath = resolve(deps.cwd(), pathArg);
  await mkdir(targetPath, { recursive: true });
  const canonicalPath = await canonicalizeExistingPath(targetPath);
  ensureGitAllowed(canonicalPath, valuesFromCli.dangerouslyAllowGit === true);

  const parsed = parseUri(uri);
  const provider = getProvider(parsed.provider);
  let globalConfig = await deps.readGlobalConfig();
  const existingGlobalValues = getProviderConfig(globalConfig, parsed.provider);
  const globalValues = await collectFields(
    io,
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
    writeLine(stdout, formatAlreadyConnected(uri, colors));
    return;
  }

  const displayPath = shortenHomePath(canonicalPath);
  writeLine(stdout, formatConnected(uri, displayPath, colors));

  let daemonRunning = false;
  try {
    daemonRunning = (await (await deps.getService()).status()).running;
  } catch (error) {
    if (!isUnsupportedPlatformError(error)) {
      throw error;
    }
  }

  if (daemonRunning) {
    writeLine(stdout, formatConnectHint(colors));
  }
}

async function runDisconnect(
  pathArg: string,
  uri: string | undefined,
  deps: DisconnectDeps,
  stdout: NodeJS.WritableStream,
  colors: Colors,
): Promise<void> {
  const lookupPath = await resolveLookupPath(resolve(deps.cwd(), pathArg));
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
            ...currentUris.map((currentUri) => `  ${currentUri}`),
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

  writeLine(stdout, formatDisconnected(disconnectedUri, shortenHomePath(disconnectedPath), colors));
}

async function runRelink(
  oldPath: string,
  newPath: string,
  dangerouslyAllowGit: boolean,
  deps: Pick<CliDependencies, "stashPath">,
  stdout: NodeJS.WritableStream,
  colors: Colors,
): Promise<void> {
  const oldCanonical = await resolveLookupPath(oldPath);
  const newCanonical = await canonicalizeExistingPath(newPath);
  ensureGitAllowed(newCanonical, dangerouslyAllowGit);
  const displayOld = shortenHomePath(oldCanonical);
  const displayNew = shortenHomePath(newCanonical);

  if (oldCanonical === newCanonical) {
    writeLine(stdout, formatAlreadyLinked(displayNew, colors));
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

  writeLine(stdout, formatRelinked(displayOld, displayNew, colors));
}

async function runStatus(
  deps: StatusDeps,
  stdout: NodeJS.WritableStream,
  colors: Colors,
): Promise<void> {
  const daemonState = await deps
    .getService()
    .then((service) => service.status())
    .then((status) => (status.running ? "running" : "stopped"))
    .catch((error: unknown) => (isUnsupportedPlatformError(error) ? "unsupported" : "error"));

  writeLine(stdout, formatDaemonState(daemonState, colors));
  writeBlankLine(stdout);

  const stashPath = deps.stashPath ?? getStashPath();
  const entries = (await readRegistry(stashPath))
    .filter((entry) => entry.record.connections.length > 0)
    .sort((a, b) => a.record.path.localeCompare(b.record.path));

  if (entries.length === 0) {
    writeLine(stdout, "No stashes registered. Run `stash connect <path> <uri>` to add one (e.g. `stash connect . github:owner/repo`).");
    return;
  }

  for (const [index, entry] of entries.entries()) {
    if (index > 0) {
      writeBlankLine(stdout);
    }
    const displayPath = shortenHomePath(entry.record.path);
    const status = await readPersistedStatus(stashPath, entry.id);
    if (status?.kind === "missing" || !existsSync(entry.record.path)) {
      writeLine(stdout, `${displayPath} ${colors.yellow("(path missing)")}`);
      writeLine(stdout, colors.gray(`Run: stash relink ${displayPath} <new-path>`));
      continue;
    }

    writeLine(stdout, displayPath);
    writeLine(stdout, renderStatusTable(entry, status, colors));
  }

  writeBlankLine(stdout);
  writeLine(stdout, pluralize(entries.length, "stash"));
}

async function runStart(
  serviceHandle: ServiceHandle,
  stdout: NodeJS.WritableStream,
  colors: Colors,
): Promise<void> {
  try {
    await serviceHandle.install();
  } catch (error) {
    if (isUnsupportedPlatformError(error)) {
      throw cliError("This platform does not support background services yet.");
    }
    throw error;
  }
  writeLine(stdout, `Daemon installed and ${colors.green("running")}`);
}

async function runStop(
  serviceHandle: ServiceHandle,
  stdout: NodeJS.WritableStream,
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
  writeLine(stdout, "Daemon stopped");
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
  const colors = createColors(Boolean(stdout.isTTY));
  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
  let exitCode = 0;

  async function runCommand(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      writeBlankLine(stdout);
    } catch (error) {
      exitCode = 1;
      renderCliError(stderr, toCliCommandError(error), colors);
      writeBlankLine(stderr);
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
      await runCommand(async () => {
        await runSetup(
          providerName,
          command.opts() as Record<string, string | boolean | undefined>,
          { readGlobalConfig: readConfig, writeGlobalConfig: writeConfig },
          { input, output: stdout },
          stdout,
          colors,
        );
      });
    });

  const connectCommand = program
    .command("connect")
    .description("Connect a folder to a provider URI")
    .argument("<path>", "Folder to connect (created if it does not exist)")
    .argument("<uri>", "Provider URI (e.g. github:owner/repo)")
    .allowUnknownOption(true)
    .option("--dangerously-allow-git", "Allow syncing a git repository")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ stash connect . github:owner/repo               # current directory\n" +
        "  $ stash connect ~/Notes github:owner/notes        # existing folder\n" +
        "  $ stash connect ./inbox github:owner/inbox        # creates ./inbox if missing\n",
    )
    .action(async (pathArg: string, uri: string, _opts: unknown, command: Command) => {
      await runCommand(async () => {
        await runConnect(
          pathArg,
          uri,
          command.opts() as Record<string, string | boolean | undefined>,
          {
            cwd,
            readGlobalConfig: readConfig,
            writeGlobalConfig: writeConfig,
            stashPath,
            getService,
          },
          { input, output: stdout },
          stdout,
          colors,
        );
      });
    });

  program
    .command("disconnect")
    .description("Disconnect a stash")
    .argument("<path>", "Folder to disconnect")
    .argument("[uri]", "Connection URI to drop (required when the stash has multiple connections)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ stash disconnect .                             # current directory\n" +
        "  $ stash disconnect ~/Notes                       # only connection\n" +
        "  $ stash disconnect ~/Notes github:owner/notes    # explicit URI\n",
    )
    .action(async (pathArg: string, uri: string | undefined) => {
      await runCommand(async () => {
        await runDisconnect(pathArg, uri, { cwd, stashPath }, stdout, colors);
      });
    });

  program
    .command("relink")
    .description("Move a stash to a new path (use after renaming or moving the folder)")
    .argument("<old-path>", "Current path of the stash (may no longer exist)")
    .argument("<new-path>", "New path of the folder")
    .option("--dangerously-allow-git", "Allow relinking to a git repository")
    .action(async (oldPath: string, newPath: string, options: { dangerouslyAllowGit?: boolean }) => {
      await runCommand(async () => {
        await runRelink(
          oldPath,
          newPath,
          options.dangerouslyAllowGit === true,
          { stashPath },
          stdout,
          colors,
        );
      });
    });

  program
    .command("status")
    .description("Show registered stashes")
    .action(async () => {
      await runCommand(async () => {
        await runStatus(
          {
            stashPath,
            getService,
          },
          stdout,
          colors,
        );
      });
    });

  program
    .command("start")
    .description("Start background sync")
    .action(async () =>
      runCommand(async () => runStart(await getService(), stdout, colors)),
    );

  program
    .command("stop")
    .description("Stop background sync")
    .action(async () =>
      runCommand(async () => runStop(await getService(), stdout)),
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
