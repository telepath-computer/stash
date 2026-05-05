import { existsSync } from "node:fs";
import { access, constants, readdir, realpath, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { Daemon, UnsupportedPlatformError } from "@rupertsworld/daemon";
import { Command, Option } from "commander";
import { input, password } from "@inquirer/prompts";
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

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(`${text}\n`);
}

function getGlobalConfigItems(provider: ProviderClass): ConfigItem[] {
  return provider.configSchema.filter((item) => item.global === true);
}

function getCliValue(
  field: ConfigItem,
  valuesFromCli: Record<string, string | boolean | undefined>,
): string | undefined {
  const value = valuesFromCli[field.name];
  if (typeof value === "string") {
    return value;
  }
  if (field.name === "id" && typeof valuesFromCli.repo === "string") {
    return valuesFromCli.repo;
  }
  return undefined;
}

async function promptField(field: ConfigItem): Promise<string> {
  if (field.secret) {
    return password({ message: field.label });
  }
  return input({ message: field.label });
}

async function collectFields(
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
    values[field.name] = await promptField(field);
  }
  return values;
}

function addFieldOptions(command: Command, fields: ConfigItem[]): void {
  for (const field of fields) {
    command.addOption(new Option(`--${field.name} <value>`, field.label));
    if (field.name === "id") {
      command.addOption(new Option("--repo <value>", `${field.label} (legacy alias)`));
    }
  }
}

function getProvider(name: string): ProviderClass {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
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
    throw new Error(
      "git repository detected. Pass `--dangerously-allow-git` if you really want stash to sync this folder.",
    );
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
  if (!status?.kind) {
    return "never";
  }
  if (status.kind === "checked" || status.kind === "synced") {
    return "idle";
  }
  return status.kind;
}

async function runSetup(
  providerName: string,
  valuesFromCli: Record<string, string | boolean | undefined>,
  deps: Required<Pick<CliDependencies, "readGlobalConfig" | "writeGlobalConfig">>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const provider = getProvider(providerName);
  const globalFields = getGlobalConfigItems(provider);
  const globalConfig = await deps.readGlobalConfig();
  const values = await collectFields(
    globalFields,
    valuesFromCli,
    getProviderConfig(globalConfig, providerName),
  );
  await deps.writeGlobalConfig(setProviderConfig(globalConfig, providerName, values));
  writeLine(stdout, `Configured ${providerName}.`);
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
  deps: Required<Pick<CliDependencies, "cwd" | "readGlobalConfig" | "writeGlobalConfig">> &
    Pick<CliDependencies, "stashPath"> & {
      getService: () => Promise<ServiceHandle>;
    },
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const { pathArg, uri } = normalizeConnectArgs(first, second);
  const targetPath = pathArg ?? deps.cwd();
  const canonicalPath = await canonicalizeExistingPath(targetPath);
  ensureGitAllowed(canonicalPath, valuesFromCli.dangerouslyAllowGit === true);

  const parsed = parseUri(uri);
  const provider = getProvider(parsed.provider);
  let globalConfig = await deps.readGlobalConfig();
  const globalValues = await collectFields(
    getGlobalConfigItems(provider),
    valuesFromCli,
    getProviderConfig(globalConfig, parsed.provider),
  );

  new provider({
    ...getProviderConfig(globalConfig, parsed.provider),
    ...globalValues,
    ...parsed.config,
  });

  globalConfig = setProviderConfig(globalConfig, parsed.provider, globalValues);
  await deps.writeGlobalConfig(globalConfig);

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

      throw new Error(
        `${canonicalPath} is already connected to ${formatUri(found.record.connections[0])}. Multi-connection per stash is not yet supported. Run \`stash disconnect ${canonicalPath}\` first.`,
      );
    },
    { stashPath },
  );

  if (outcome === "already-connected") {
    writeLine(stdout, "Already connected.");
  } else {
    writeLine(stdout, `Connected ${uri} to ${canonicalPath}.`);
  }

  try {
    const status = await (await deps.getService()).status();
    if (status.running) {
      writeLine(stdout, "Background sync is on · syncing automatically");
    }
  } catch (error) {
    if (!isUnsupportedPlatformError(error)) {
      throw error;
    }
  }
}

async function runDisconnect(
  first: string | undefined,
  second: string | undefined,
  deps: Required<Pick<CliDependencies, "cwd">> & Pick<CliDependencies, "stashPath">,
  stdout: NodeJS.WriteStream,
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
        throw new Error(`No stash found at ${lookupPath}.`);
      }

      const currentUris = found.record.connections.map((connection) => formatUri(connection));
      let targetUri = uri;
      if (!targetUri) {
        if (currentUris.length !== 1) {
          throw new Error(`Multiple connections present: ${currentUris.join(", ")}`);
        }
        [targetUri] = currentUris;
      }

      const nextConnections = found.record.connections.filter(
        (connection) => formatUri(connection) !== targetUri,
      );
      if (nextConnections.length === found.record.connections.length) {
        throw new Error(`Connection not found: ${targetUri}`);
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

  writeLine(stdout, `Disconnected ${disconnectedUri} from ${disconnectedPath}.`);
}

async function runRelink(
  oldPath: string,
  newPath: string,
  dangerouslyAllowGit: boolean,
  deps: Pick<CliDependencies, "stashPath">,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const oldCanonical = await resolveLookupPath(oldPath);
  const newCanonical = await canonicalizeExistingPath(newPath);
  ensureGitAllowed(newCanonical, dangerouslyAllowGit);
  if (oldCanonical === newCanonical) {
    return;
  }

  const stashPath = deps.stashPath ?? getStashPath();
  await withRegistryLock(
    async () => {
      const entries = await readRegistry(stashPath);
      const current = entries.find((entry) => entry.record.path === oldCanonical);
      if (!current) {
        throw new Error(`No stash found at ${oldCanonical}.`);
      }
      if (entries.some((entry) => entry.id !== current.id && entry.record.path === newCanonical)) {
        throw new Error(`A stash already exists at ${newCanonical}.`);
      }
      await writeJsonFile(join(getStashDirPath(current.id, stashPath), "stash.json"), {
        ...current.record,
        path: newCanonical,
      } satisfies StashRecord);
    },
    { stashPath },
  );

  writeLine(stdout, `Relinked ${oldCanonical} -> ${newCanonical}.`);
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

async function runStatus(
  deps: Required<Pick<CliDependencies, "readGlobalConfig">> &
    Pick<CliDependencies, "stashPath"> & {
      getService: () => Promise<ServiceHandle>;
    },
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const daemonState = await deps
    .getService()
    .then((service) => service.status())
    .then((status) => (status.running ? "running" : "stopped"))
    .catch((error: unknown) => (isUnsupportedPlatformError(error) ? "unsupported" : "error"));
  writeLine(stdout, `Daemon: ${daemonState}`);

  const stashPath = deps.stashPath ?? getStashPath();
  const entries = await readRegistry(stashPath);
  if (entries.length === 0) {
    return;
  }

  writeLine(stdout, "");
  for (const entry of entries.sort((a, b) => a.record.path.localeCompare(b.record.path))) {
    const status = await readPersistedStatus(stashPath, entry.id);
    if (status?.kind === "missing" || !existsSync(entry.record.path)) {
      writeLine(
        stdout,
        `${entry.record.path}  (path missing — run \`stash relink ${entry.record.path} <new-path>\`)`,
      );
      writeLine(stdout, "");
      continue;
    }

    writeLine(stdout, entry.record.path);
    for (const connection of entry.record.connections) {
      writeLine(stdout, `  ${formatUri(connection)}`);
    }

    writeLine(stdout, `  State:        ${describeStatusKind(status)}`);
    if (status?.lastSync) {
      writeLine(stdout, `  Last sync:    ${formatTimeAgo(new Date(status.lastSync))}`);
    }
    const pending = formatPendingChanges(status);
    if (pending) {
      writeLine(stdout, `  Pending:      ${pending}`);
    }
    if (status?.error) {
      writeLine(stdout, `  Last error:   ${status.error}`);
    }
    writeLine(stdout, "");
  }
}

async function runStart(serviceHandle: ServiceHandle, stdout: NodeJS.WriteStream): Promise<void> {
  await serviceHandle.install();
  writeLine(stdout, "Daemon started.");
}

async function runStop(serviceHandle: ServiceHandle, stdout: NodeJS.WriteStream): Promise<void> {
  await serviceHandle.uninstall();
  writeLine(stdout, "Daemon stopped.");
}

export async function main(argv = process.argv, deps: CliDependencies = {}): Promise<void> {
  const cwd = deps.cwd ?? (() => process.cwd());
  const readConfig = deps.readGlobalConfig ?? readGlobalConfig;
  const writeConfig = deps.writeGlobalConfig ?? writeGlobalConfig;
  const stashPath = deps.stashPath ?? getStashPath();
  const serviceHandle = deps.service;
  const getService = async () => serviceHandle ?? (await createDefaultService(argv));
  const runDaemonCommand = deps.runDaemon ?? runDaemon;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
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
    .description("Connect a path to a provider uri")
    .argument("<first>", "URI or explicit path")
    .argument("[second]", "URI when an explicit path is provided")
    .allowUnknownOption(true)
    .option("--dangerously-allow-git", "Allow syncing a git repository")
    .action(async (first: string, second: string | undefined, _opts: unknown, command: Command) => {
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
        stdout,
      );
    });

  program
    .command("disconnect")
    .description("Disconnect a stash path or uri")
    .argument("[first]", "Path or URI")
    .argument("[second]", "URI when an explicit path is provided")
    .action(async (first: string | undefined, second: string | undefined) => {
      await runDisconnect(first, second, { cwd, stashPath }, stdout);
    });

  program
    .command("relink")
    .description("Relink a stash from one path to another")
    .argument("<oldPath>", "Current or missing path")
    .argument("<newPath>", "New existing path")
    .option("--dangerously-allow-git", "Allow relinking to a git repository")
    .action(async (oldPath: string, newPath: string, options: { dangerouslyAllowGit?: boolean }) => {
      await runRelink(oldPath, newPath, options.dangerouslyAllowGit === true, { stashPath }, stdout);
    });

  program
    .command("status")
    .description("Show registered stashes")
    .action(async () => {
      await runStatus(
        {
          readGlobalConfig: readConfig,
          stashPath,
          getService,
        },
        stdout,
      );
    });

  program
    .command("start")
    .description("Start background sync")
    .action(async () => runStart(await getService(), stdout));

  program
    .command("stop")
    .description("Stop background sync")
    .action(async () => runStop(await getService(), stdout));

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
    return;
  }

  await program.parseAsync(argv);
}
