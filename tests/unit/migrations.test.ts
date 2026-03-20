import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MigrationError } from "../../src/errors.ts";
import { ensureMigration } from "../../src/migrations.ts";
import { Stash } from "../../src/stash.ts";
import type { ChangeSet, Provider, ProviderClass } from "../../src/types.ts";
import { makeTempDir, writeFiles } from "../helpers/make-stash.ts";

test("ensureMigration: moves config.local.json to config.json", async () => {
  const dir = await makeTempDir("migrate-config");
  try {
    await mkdir(join(dir, ".stash"), { recursive: true });
    await writeFile(
      join(dir, ".stash", "config.local.json"),
      JSON.stringify({ connections: { github: { repo: "user/repo" } } }, null, 2),
      "utf8",
    );

    await ensureMigration(dir);

    assert.equal(existsSync(join(dir, ".stash", "config.local.json")), false);
    assert.deepEqual(JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8")), {
      connections: {
        github: { provider: "github", repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMigration: moves snapshot.local to snapshot", async () => {
  const dir = await makeTempDir("migrate-snapshot");
  try {
    await mkdir(join(dir, ".stash", "snapshot.local"), { recursive: true });
    await writeFile(join(dir, ".stash", "snapshot.local", "hello.md"), "hello", "utf8");

    await ensureMigration(dir);

    assert.equal(existsSync(join(dir, ".stash", "snapshot.local")), false);
    assert.equal(await readFile(join(dir, ".stash", "snapshot", "hello.md"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMigration: no-ops when the new layout already exists", async () => {
  const dir = await makeTempDir("migrate-noop");
  try {
    await mkdir(join(dir, ".stash", "snapshot"), { recursive: true });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify({ connections: {} }, null, 2),
      "utf8",
    );

    await ensureMigration(dir);

    assert.equal(existsSync(join(dir, ".stash", "config.json")), true);
    assert.equal(existsSync(join(dir, ".stash", "snapshot")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMigration: backfills provider when config.json connection is missing it", async () => {
  const dir = await makeTempDir("migrate-provider");
  try {
    await mkdir(join(dir, ".stash"), { recursive: true });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify({ connections: { github: { repo: "user/repo" } } }, null, 2),
      "utf8",
    );

    await ensureMigration(dir);

    assert.deepEqual(JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8")), {
      connections: {
        github: { provider: "github", repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMigration: does not rewrite connections that already have a provider", async () => {
  const dir = await makeTempDir("migrate-provider-noop");
  try {
    await mkdir(join(dir, ".stash"), { recursive: true });
    await writeFile(
      join(dir, ".stash", "config.json"),
      JSON.stringify(
        { connections: { origin: { provider: "github", repo: "user/repo" } } },
        null,
        2,
      ),
      "utf8",
    );

    await ensureMigration(dir);

    assert.deepEqual(JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8")), {
      connections: {
        origin: { provider: "github", repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMigration: throws when both old and new config paths exist", async () => {
  const dir = await makeTempDir("migrate-config-conflict");
  try {
    await mkdir(join(dir, ".stash"), { recursive: true });
    await writeFile(join(dir, ".stash", "config.local.json"), "{}", "utf8");
    await writeFile(join(dir, ".stash", "config.json"), "{}", "utf8");

    await assert.rejects(ensureMigration(dir), MigrationError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMigration: throws when both old and new snapshot paths exist", async () => {
  const dir = await makeTempDir("migrate-snapshot-conflict");
  try {
    await mkdir(join(dir, ".stash", "snapshot.local"), { recursive: true });
    await mkdir(join(dir, ".stash", "snapshot"), { recursive: true });

    await assert.rejects(ensureMigration(dir), MigrationError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Stash.load migrates old config.local.json", async () => {
  const dir = await makeTempDir("migrate-load");
  try {
    await mkdir(join(dir, ".stash"), { recursive: true });
    await writeFile(
      join(dir, ".stash", "config.local.json"),
      JSON.stringify({ connections: { github: { repo: "user/repo" } } }, null, 2),
      "utf8",
    );

    const stash = await Stash.load(dir, { providers: {}, background: { stashes: [] } });

    assert.deepEqual(stash.connections, {
      github: { provider: "github", repo: "user/repo" },
    });
    assert.equal(existsSync(join(dir, ".stash", "config.local.json")), false);
    assert.equal(existsSync(join(dir, ".stash", "config.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Stash.load preserves old snapshot.local merge bases through migration", async () => {
  const dir = await makeTempDir("migrate-merge-base");
  const baseline: string = "hello world";
  const remote: string = "hello cruel world";
  const local: string = "hello brave world";

  class TestProvider implements Provider {
    static spec = { setup: [], connect: [{ name: "repo", label: "Repo" }] };
    async fetch(): Promise<ChangeSet> {
      return {
        added: new Map(),
        modified: new Map([["note.md", { type: "text" as const, content: remote }]]),
        deleted: [],
      };
    }
    async get(): Promise<never> {
      throw new Error("not needed");
    }
    async push(): Promise<void> {}
  }

  try {
    await writeFiles(dir, { "note.md": local });
    await mkdir(join(dir, ".stash", "snapshot.local"), { recursive: true });
    await writeFile(
      join(dir, ".stash", "config.local.json"),
      JSON.stringify({ connections: { fake: { repo: "r" } } }, null, 2),
      "utf8",
    );
    await writeFile(
      join(dir, ".stash", "snapshot.json"),
      JSON.stringify({ "note.md": { hash: "sha256-old" } }, null, 2),
      "utf8",
    );
    await writeFile(join(dir, ".stash", "snapshot.local", "note.md"), baseline, "utf8");

    const stash = await Stash.load(
      dir,
      { providers: {}, background: { stashes: [] } },
      { providers: { fake: TestProvider as unknown as ProviderClass } },
    );
    await stash.sync();

    const merged = await readFile(join(dir, "note.md"), "utf8");
    assert.equal(merged.includes("brave"), true);
    assert.equal(merged.includes("cruel"), true);
    assert.equal(existsSync(join(dir, ".stash", "snapshot.local")), false);
    assert.equal(existsSync(join(dir, ".stash", "snapshot", "note.md")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
