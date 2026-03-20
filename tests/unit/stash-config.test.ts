import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "../../src/types.ts";
import { makeStash } from "../helpers/make-stash.ts";

test("connect writes named provider connection config", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });

  const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
  assert.deepEqual(config, {
    connections: {
      origin: { provider: "github", repo: "user/repo" },
    },
  });
});

test("disconnect removes named connection config", async () => {
  const { stash, dir } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  await stash.disconnect("origin");

  const config = JSON.parse(await readFile(join(dir, ".stash", "config.json"), "utf8"));
  assert.deepEqual(config, { connections: {} });
});

test("connections getter reflects latest local state", async () => {
  const { stash } = await makeStash();
  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });
  assert.deepEqual(stash.connections, { origin: { provider: "github", repo: "user/repo" } });
});

test("buildProvider resolves the provider class from the provider field", async () => {
  class GitHubProvider implements Provider {
    readonly config: Record<string, string>;
    constructor(config: Record<string, string>) {
      this.config = config;
    }
    async fetch() {
      return { added: new Map(), modified: new Map(), deleted: [] };
    }
    async get(): Promise<never> {
      throw new Error("not needed");
    }
    async push(): Promise<void> {}
  }

  class OriginProvider implements Provider {
    readonly config: Record<string, string>;
    constructor(config: Record<string, string>) {
      this.config = config;
    }
    async fetch() {
      return { added: new Map(), modified: new Map(), deleted: [] };
    }
    async get(): Promise<never> {
      throw new Error("not needed");
    }
    async push(): Promise<void> {}
  }

  const { stash } = await makeStash(
    {},
    {
      globalConfig: {
        providers: {
          github: { token: "t" },
          origin: { token: "wrong" },
        },
        background: { stashes: [] },
      },
      providers: {
        github: GitHubProvider as unknown as typeof GitHubProvider,
        origin: OriginProvider as unknown as typeof OriginProvider,
      },
    },
  );

  await stash.connect({ name: "origin", provider: "github", repo: "user/repo" });

  const provider = (stash as any).buildProvider("origin") as Provider;
  assert.equal(provider instanceof GitHubProvider, true);
  assert.deepEqual((provider as GitHubProvider).config, {
    token: "t",
    provider: "github",
    repo: "user/repo",
  });
});

test("config getter merges global provider config by provider type", async () => {
  const { stash } = await makeStash(
    {},
    {
      globalConfig: {
        providers: {
          github: { token: "t" },
          origin: { token: "wrong" },
        },
        background: {
          stashes: [],
        },
      },
    },
  );
  await stash.connect({ name: "origin", provider: "github", repo: "r" });
  assert.deepEqual((stash as any).config, {
    origin: {
      token: "t",
      provider: "github",
      repo: "r",
    },
  });
});
