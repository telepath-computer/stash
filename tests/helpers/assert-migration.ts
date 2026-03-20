import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotEntry } from "../../src/types.ts";

type LegacyConnectionConfig = Record<string, string> & { provider?: string };

type LegacyLayoutOptions = {
  connections?: Record<string, LegacyConnectionConfig>;
  snapshot?: Record<string, SnapshotEntry>;
  snapshotLocal?: Record<string, string>;
  "allow-git"?: boolean;
};

export async function writeLegacyLayout(
  dir: string,
  options: LegacyLayoutOptions = {},
): Promise<void> {
  await mkdir(join(dir, ".stash"), { recursive: true });
  await writeFile(
    join(dir, ".stash", "config.local.json"),
    JSON.stringify(
      {
        connections: options.connections ?? {},
        ...(options["allow-git"] === undefined ? {} : { "allow-git": options["allow-git"] }),
      },
      null,
      2,
    ),
    "utf8",
  );

  if (options.snapshot) {
    await writeFile(
      join(dir, ".stash", "snapshot.json"),
      JSON.stringify(options.snapshot, null, 2),
      "utf8",
    );
  }

  if (options.snapshotLocal) {
    for (const [path, content] of Object.entries(options.snapshotLocal)) {
      const target: string = join(dir, ".stash", "snapshot.local", path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }
}

export async function assertMigration(
  dir: string,
  expected: LegacyLayoutOptions = {},
): Promise<void> {
  assert.equal(existsSync(join(dir, ".stash", "config.local.json")), false);
  assert.equal(existsSync(join(dir, ".stash", "snapshot.local")), false);
  assert.equal(existsSync(join(dir, ".stash", "config.json")), true);

  const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(config.connections, expected.connections ?? {});
  if (expected["allow-git"] !== undefined) {
    assert.equal(config["allow-git"], expected["allow-git"]);
  }

  for (const [path, content] of Object.entries(expected.snapshotLocal ?? {})) {
    assert.equal(await readFile(join(dir, ".stash", "snapshot", path), "utf8"), content);
  }
}
