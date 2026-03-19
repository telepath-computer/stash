import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { MigrationError } from "./errors.ts";

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

const migrations: Migration[] = [renameLocalMetadataLayoutMigration];

export function needsMigration(dir: string): boolean {
  return migrations.some((migration) => migration.check(dir));
}

export async function ensureMigration(dir: string): Promise<void> {
  for (const migration of migrations) {
    if (!(await migration.check(dir))) {
      continue;
    }
    await migration.apply(dir);
  }
}
