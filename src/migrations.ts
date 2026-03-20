import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { MigrationError } from "./errors.ts";
import { readJsonFile, writeJsonFile } from "./utils/fs.ts";

type Migration = {
  name: string;
  check(dir: string): Promise<boolean> | boolean;
  apply(dir: string): Promise<void>;
};

const OLD_LOCAL_CONFIG_PATH = ".stash/config.local.json";
const NEW_LOCAL_CONFIG_PATH = ".stash/config.json";
const OLD_SNAPSHOT_DIR = ".stash/snapshot.local";
const NEW_SNAPSHOT_DIR = ".stash/snapshot";

function resolvePath(dir: string, relativePath: string): string {
  return join(dir, relativePath);
}

function hasPath(dir: string, relativePath: string): boolean {
  return existsSync(resolvePath(dir, relativePath));
}

const renameLocalMetadataLayoutMigration: Migration = {
  name: "rename-local-metadata-layout",
  check(dir: string): boolean {
    return (
      hasPath(dir, OLD_LOCAL_CONFIG_PATH) ||
      hasPath(dir, OLD_SNAPSHOT_DIR) ||
      (hasPath(dir, OLD_LOCAL_CONFIG_PATH) && hasPath(dir, NEW_LOCAL_CONFIG_PATH)) ||
      (hasPath(dir, OLD_SNAPSHOT_DIR) && hasPath(dir, NEW_SNAPSHOT_DIR))
    );
  },
  async apply(dir: string): Promise<void> {
    const hasOldConfig: boolean = hasPath(dir, OLD_LOCAL_CONFIG_PATH);
    const hasNewConfig: boolean = hasPath(dir, NEW_LOCAL_CONFIG_PATH);
    if (hasOldConfig && hasNewConfig) {
      throw new MigrationError(
        `Both ${OLD_LOCAL_CONFIG_PATH} and ${NEW_LOCAL_CONFIG_PATH} exist. Resolve this manually before continuing.`,
      );
    }
    if (hasOldConfig) {
      await rename(
        resolvePath(dir, OLD_LOCAL_CONFIG_PATH),
        resolvePath(dir, NEW_LOCAL_CONFIG_PATH),
      );
    }

    const hasOldSnapshot: boolean = hasPath(dir, OLD_SNAPSHOT_DIR);
    const hasNewSnapshot: boolean = hasPath(dir, NEW_SNAPSHOT_DIR);
    if (hasOldSnapshot && hasNewSnapshot) {
      throw new MigrationError(
        `Both ${OLD_SNAPSHOT_DIR} and ${NEW_SNAPSHOT_DIR} exist. Resolve this manually before continuing.`,
      );
    }
    if (hasOldSnapshot) {
      await rename(resolvePath(dir, OLD_SNAPSHOT_DIR), resolvePath(dir, NEW_SNAPSHOT_DIR));
    }
  },
};

const backfillConnectionProviderMigration: Migration = {
  name: "backfill-connection-provider",
  async check(dir: string): Promise<boolean> {
    if (!hasPath(dir, NEW_LOCAL_CONFIG_PATH)) {
      return false;
    }
    const config = await readJsonFile(resolvePath(dir, NEW_LOCAL_CONFIG_PATH), {});
    const raw =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {};
    const connections =
      raw.connections && typeof raw.connections === "object" && !Array.isArray(raw.connections)
        ? (raw.connections as Record<string, unknown>)
        : {};
    return Object.values(connections).some(
      (connection) =>
        !connection ||
        typeof connection !== "object" ||
        Array.isArray(connection) ||
        typeof (connection as Record<string, unknown>).provider !== "string",
    );
  },
  async apply(dir: string): Promise<void> {
    const path = resolvePath(dir, NEW_LOCAL_CONFIG_PATH);
    const config = await readJsonFile(path, {});
    const raw =
      config && typeof config === "object" && !Array.isArray(config)
        ? ({ ...config } as Record<string, unknown>)
        : {};
    const rawConnections =
      raw.connections && typeof raw.connections === "object" && !Array.isArray(raw.connections)
        ? (raw.connections as Record<string, unknown>)
        : {};
    const connections: Record<string, Record<string, unknown>> = {};

    for (const [name, connection] of Object.entries(rawConnections)) {
      const record =
        connection && typeof connection === "object" && !Array.isArray(connection)
          ? ({ ...(connection as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      if (typeof record.provider !== "string") {
        record.provider = name;
      }
      connections[name] = record;
    }

    await writeJsonFile(path, {
      ...raw,
      connections,
    });
  },
};

const migrations: Migration[] = [
  renameLocalMetadataLayoutMigration,
  backfillConnectionProviderMigration,
];

export async function needsMigration(dir: string): Promise<boolean> {
  for (const migration of migrations) {
    if (await migration.check(dir)) {
      return true;
    }
  }
  return false;
}

export async function ensureMigration(dir: string): Promise<void> {
  for (const migration of migrations) {
    if (!(await migration.check(dir))) {
      continue;
    }
    await migration.apply(dir);
  }
}
