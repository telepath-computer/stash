import { join } from "node:path";
import type { ConnectionConfig } from "./types.ts";
import { readJsonFile, writeJsonFile } from "./utils/fs.ts";

export type LocalConfig = {
  connections: Record<string, ConnectionConfig>;
  "allow-git"?: boolean;
};

function asConnectionConfig(value: unknown): ConnectionConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, fieldValue]) => typeof fieldValue === "string",
  );
  const config = Object.fromEntries(entries) as Record<string, string>;
  return typeof config.provider === "string" ? (config as ConnectionConfig) : null;
}

export function normalizeLocalConfig(value: unknown): LocalConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const connectionsValue =
    raw.connections && typeof raw.connections === "object" && !Array.isArray(raw.connections)
      ? (raw.connections as Record<string, unknown>)
      : {};
  const connections: Record<string, ConnectionConfig> = {};
  for (const [name, connectionConfig] of Object.entries(connectionsValue)) {
    const normalized = asConnectionConfig(connectionConfig);
    if (normalized) {
      connections[name] = normalized;
    }
  }

  const allowGit = typeof raw["allow-git"] === "boolean" ? raw["allow-git"] : undefined;
  return {
    connections,
    ...(allowGit === undefined ? {} : { "allow-git": allowGit }),
  };
}

export function getLocalConfigPath(dir: string): string {
  return join(dir, ".stash", "config.json");
}

export async function readLocalConfig(dir: string): Promise<LocalConfig> {
  return normalizeLocalConfig(await readJsonFile(getLocalConfigPath(dir), { connections: {} }));
}

export async function writeLocalConfig(dir: string, config: LocalConfig): Promise<void> {
  await writeJsonFile(getLocalConfigPath(dir), normalizeLocalConfig(config));
}
