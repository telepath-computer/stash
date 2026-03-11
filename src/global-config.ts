import { homedir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "./types.ts";
import { readJsonFile, writeJsonFile } from "./utils/fs.ts";

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, fieldValue]) => typeof fieldValue === "string",
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

export function normalizeGlobalConfig(value: unknown): GlobalConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const providersValue =
    raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)
      ? (raw.providers as Record<string, unknown>)
      : {};
  const backgroundValue =
    raw.background && typeof raw.background === "object" && !Array.isArray(raw.background)
      ? (raw.background as Record<string, unknown>)
      : {};
  const providers: Record<string, Record<string, string>> = {};
  for (const [name, providerConfig] of Object.entries(providersValue)) {
    providers[name] = asStringRecord(providerConfig);
  }

  return {
    providers,
    background: {
      stashes: Array.isArray(backgroundValue.stashes)
        ? backgroundValue.stashes.filter((stash): stash is string => typeof stash === "string")
        : [],
    },
  };
}

export function getGlobalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return join(xdg, "stash", "config.json");
  }
  return join(homedir(), ".stash", "config.json");
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  return normalizeGlobalConfig(await readJsonFile(getGlobalConfigPath(), {}));
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await writeJsonFile(getGlobalConfigPath(), normalizeGlobalConfig(config));
}

export function getBackgroundStashes(config: GlobalConfig): string[] {
  return [...config.background.stashes];
}

export function setBackgroundStashes(config: GlobalConfig, stashes: string[]): GlobalConfig {
  return normalizeGlobalConfig({
    ...config,
    background: {
      stashes,
    },
  });
}

export function addBackgroundStash(config: GlobalConfig, dir: string): GlobalConfig {
  const stashes = new Set(getBackgroundStashes(config));
  stashes.add(dir);
  return setBackgroundStashes(
    config,
    [...stashes].sort((a, b) => a.localeCompare(b)),
  );
}

export function removeBackgroundStash(config: GlobalConfig, dir: string): GlobalConfig {
  const stashes = getBackgroundStashes(config).filter((stash) => stash !== dir);
  return setBackgroundStashes(config, stashes);
}

export function getProviderConfig(config: GlobalConfig, provider: string): Record<string, string> {
  return { ...(config.providers[provider] ?? {}) };
}

export function setProviderConfig(
  config: GlobalConfig,
  provider: string,
  values: Record<string, string>,
): GlobalConfig {
  return normalizeGlobalConfig({
    ...config,
    providers: {
      ...config.providers,
      [provider]: values,
    },
  });
}
