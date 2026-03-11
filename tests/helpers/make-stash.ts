import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeGlobalConfig } from "../../src/global-config.ts";
import { Stash } from "../../src/stash.ts";
import type { GlobalConfig, ProviderClass, SnapshotEntry } from "../../src/types.ts";

export async function writeFiles(
  dir: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(dir, relPath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content);
  }
}

export async function makeTempDir(prefix = "stash-test"): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}-`));
}

export async function makeStash(
  files?: Record<string, string | Buffer>,
  opts?: {
    snapshot?: Record<string, SnapshotEntry>;
    snapshotLocal?: Record<string, string>;
    globalConfig?: GlobalConfig;
    providers?: Record<string, ProviderClass>;
  },
): Promise<{ stash: Stash; dir: string }> {
  const dir = await makeTempDir();
  const globalConfig = normalizeGlobalConfig(opts?.globalConfig ?? {});
  if (files) {
    await writeFiles(dir, files);
  }

  await Stash.init(dir, globalConfig, {
    providers: opts?.providers,
  });

  if (opts?.snapshot) {
    await writeFile(
      join(dir, ".stash", "snapshot.json"),
      JSON.stringify(opts.snapshot, null, 2),
      "utf8",
    );
  }

  if (opts?.snapshotLocal) {
    for (const [path, content] of Object.entries(opts.snapshotLocal)) {
      const target = join(dir, ".stash", "snapshot.local", path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }

  const loaded = await Stash.load(dir, globalConfig, {
    providers: opts?.providers,
  });
  return { stash: loaded, dir };
}
