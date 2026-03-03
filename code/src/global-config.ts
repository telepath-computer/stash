import { homedir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "./types.ts";
import { readJsonFile, writeJsonFile } from "./utils/fs.ts";

export function getGlobalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return join(xdg, "stash", "config.json");
  }
  return join(homedir(), ".stash", "config.json");
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  return readJsonFile(getGlobalConfigPath(), {});
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await writeJsonFile(getGlobalConfigPath(), config);
}
