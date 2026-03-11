#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command, Option } from "commander";
import { input, password } from "@inquirer/prompts";
import { readGlobalConfig, writeGlobalConfig } from "./global-config.ts";
import { providers } from "./providers/index.ts";
import { Stash } from "./stash.ts";
import { LiveLine } from "./ui/live-line.ts";
import { SyncRenderer } from "./ui/sync-renderer.ts";
import { watch as watchStash } from "./watch.ts";
import type { Field, ProviderClass } from "./types.ts";

function getProvider(name: string): ProviderClass {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

async function promptField(field: Field): Promise<string> {
  if (field.secret) {
    return password({ message: field.label });
  }
  return input({ message: field.label });
}

async function collectFields(
  fields: Field[],
  valuesFromCli: Record<string, string | undefined>,
  current: Record<string, string> = {},
): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...current };
  for (const field of fields) {
    if (values[field.name]) {
      continue;
    }
    if (valuesFromCli[field.name]) {
      values[field.name] = valuesFromCli[field.name]!;
      continue;
    }
    values[field.name] = await promptField(field);
  }
  return values;
}

async function runSetup(
  providerName: string,
  valuesFromCli: Record<string, string | undefined>,
): Promise<void> {
  const provider = getProvider(providerName);
  const globalConfig = await readGlobalConfig();
  const values = await collectFields(
    provider.spec.setup,
    valuesFromCli,
    globalConfig[providerName] ?? {},
  );
  globalConfig[providerName] = values;
  await writeGlobalConfig(globalConfig);
  console.log(`Configured ${providerName}.`);
}

async function runInit(): Promise<void> {
  const dir = process.cwd();
  const alreadyInitialized = existsSync(join(dir, ".stash"));
  await Stash.init(dir, await readGlobalConfig());
  console.log(alreadyInitialized ? "Already initialized." : "Initialized stash.");
}

async function runConnect(
  providerName: string,
  valuesFromCli: Record<string, string | undefined>,
): Promise<void> {
  const provider = getProvider(providerName);
  const globalConfig = await readGlobalConfig();
  const setupValues = await collectFields(
    provider.spec.setup,
    valuesFromCli,
    globalConfig[providerName] ?? {},
  );
  globalConfig[providerName] = setupValues;
  await writeGlobalConfig(globalConfig);

  const stash = await Stash.init(process.cwd(), globalConfig);
  const connectValues = await collectFields(provider.spec.connect, valuesFromCli);
  await stash.connect(providerName, connectValues);
  console.log(`Connected ${providerName}.`);
}

async function runDisconnect(providerName: string): Promise<void> {
  const stash = await Stash.load(process.cwd(), await readGlobalConfig());
  await stash.disconnect(providerName);
  console.log(`Disconnected ${providerName}.`);
}

async function runSync(): Promise<void> {
  const stash = await Stash.load(process.cwd(), await readGlobalConfig());
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
    line.print(`${red("✗")} sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    subscription.dispose();
    renderer.dispose();
    line.dispose();
  }
}

async function runWatch(): Promise<void> {
  const dir = process.cwd();
  const stash = await Stash.load(dir, await readGlobalConfig());
  if (Object.keys(stash.connections).length === 0) {
    throw new Error("no connection configured — run `stash connect <provider>` first");
  }
  await watchStash(stash, { dir, stdin: process.stdin, stdout: process.stdout });
}

async function runStatus(): Promise<void> {
  const stash = await Stash.load(process.cwd(), await readGlobalConfig());
  const status = stash.status();
  console.log("Connections:");
  console.log(JSON.stringify(stash.connections, null, 2));
  console.log("Changes:");
  console.log(JSON.stringify(status, null, 2));
}

function addFieldOptions(command: Command, fields: Field[]): void {
  for (const field of fields) {
    command.addOption(new Option(`--${field.name} <value>`, field.label));
  }
}

async function main(argv = process.argv): Promise<void> {
  const program = new Command()
    .name("stash")
    .description("Conflict-free synced folders")
    .showHelpAfterError();

  const setupCommand = program
    .command("setup")
    .description("Configure global provider settings")
    .argument("<provider>", "Provider name")
    .allowUnknownOption(true)
    .action(async (providerName: string, _opts: unknown, command: Command) => {
      await runSetup(providerName, command.opts() as Record<string, string | undefined>);
    });

  const connectCommand = program
    .command("connect")
    .description("Connect this stash to a provider")
    .argument("<provider>", "Provider name")
    .allowUnknownOption(true)
    .action(async (providerName: string, _opts: unknown, command: Command) => {
      await runConnect(providerName, command.opts() as Record<string, string | undefined>);
    });

  const disconnectCommand = program
    .command("disconnect")
    .description("Disconnect provider from this stash")
    .argument("<provider>", "Provider name")
    .action(async (providerName: string) => {
      await runDisconnect(providerName);
    });

  program.command("init").description("Initialize the current directory as a stash").action(runInit);
  program.command("sync").description("Sync local files with connections").action(runSync);
  program.command("watch").description("Watch and sync continuously").action(runWatch);
  program.command("status").description("Show local stash status").action(runStatus);

  const commandName = argv[2];
  const providerName = argv[3];
  if (providerName && (commandName === "setup" || commandName === "connect")) {
    const provider = providers[providerName];
    if (provider) {
      if (commandName === "setup") {
        addFieldOptions(setupCommand, provider.spec.setup);
      } else {
        addFieldOptions(connectCommand, [
          ...provider.spec.setup,
          ...provider.spec.connect,
        ]);
      }
    }
  }

  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
