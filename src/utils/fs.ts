import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const JSON_READ_RETRIES = 5;
const JSON_READ_RETRY_MS = 2;

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  for (let attempt = 0; attempt < JSON_READ_RETRIES; attempt += 1) {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallback;
      }
      if (error instanceof SyntaxError && attempt < JSON_READ_RETRIES - 1) {
        await delay(JSON_READ_RETRY_MS);
        continue;
      }
      throw error;
    }
  }

  return fallback;
}

export async function writeJsonFile(
  path: string,
  value: unknown,
  options?: { mode?: number },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;

  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    if (options?.mode !== undefined) {
      await chmod(tempPath, options.mode);
    }
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
