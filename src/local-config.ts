import { join } from "node:path";
import type { ConnectionConfig } from "./types.ts";
import { readJsonFile, writeJsonFile } from "./utils/fs.ts";

export type LocalConfig = {
  connections: Record<string, ConnectionConfig>;
  "allow-git"?: boolean;
};

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, fieldValue]) => typeof fieldValue === "string",
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

export function normalizeLocalConfig(value: unknown): LocalConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const connectionsValue =
    raw.connections && typeof raw.connections === "object" && !Array.isArray(raw.connections)
      ? (raw.connections as Record<string, unknown>)
      : {};
  const connections: Record<string, ConnectionConfig> = {};
  for (const [name, connectionConfig] of Object.entries(connectionsValue)) {
    connections[name] = asStringRecord(connectionConfig);
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
