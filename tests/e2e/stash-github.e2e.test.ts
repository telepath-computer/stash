import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stash } from "../../src/stash.ts";

const token = process.env.GITHUB_TOKEN;

type RepoInfo = { fullName: string };
let cachedUsername: string | null = null;
let lastRepoCreateAt = 0;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncWithRetry(stash: Stash, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await stash.sync();
      return;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(400);
        continue;
      }
    }
  }
  throw lastError;
}

async function githubRequest(method: string, path: string, body?: unknown): Promise<Response> {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "stash-e2e-test",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

async function githubJson(method: string, path: string, body?: unknown): Promise<any> {
  const res = await githubRequest(method, path, body);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) {
    return null;
  }
  return res.json();
}

function isSecondaryRateLimit(status: number, message: string): boolean {
  return status === 403 && message.toLowerCase().includes("secondary rate limit");
}

async function getUsername(): Promise<string> {
  if (cachedUsername) {
    return cachedUsername;
  }
  const user = await githubJson("GET", "/user");
  cachedUsername = user.login as string;
  return cachedUsername;
}

async function createRepo(): Promise<RepoInfo> {
  const username = await getUsername();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const waitForPacing = lastRepoCreateAt + 1_500 - Date.now();
    if (waitForPacing > 0) {
      await sleep(waitForPacing);
    }

    const name = `stash-test-${randomUUID().slice(0, 8)}`;
    const response = await githubRequest("POST", "/user/repos", {
      name,
      private: true,
      auto_init: false,
    });

    if (response.ok) {
      lastRepoCreateAt = Date.now();
      const repo = await response.json();
      return { fullName: `${username}/${repo.name}` };
    }

    const text = await response.text();
    if (isSecondaryRateLimit(response.status, text) && attempt < 7) {
      await sleep(Math.min(60_000, 5_000 * (attempt + 1)));
      continue;
    }
    throw new Error(`POST /user/repos failed (${response.status}): ${text}`);
  }

  throw new Error("Unable to create repository after retries");
}

async function deleteRepo(fullName: string): Promise<void> {
  const res = await githubRequest("DELETE", `/repos/${fullName}`);
  if (res.status !== 204 && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Failed to delete repo ${fullName}: ${res.status} ${text}`);
  }
}

async function getRawFile(repo: string, path: string): Promise<string> {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=main`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "stash-e2e-test",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to read ${path}: ${res.status} ${text}`);
  }
  return res.text();
}

async function makeDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}-`));
}

test(
  "e2e: first sync pushes local files and second machine pulls",
  { skip: !token, timeout: 180_000 },
  async () => {
    let repo: RepoInfo | null = null;
    const dirs: string[] = [];
    try {
      repo = await createRepo();
      const machineA = await makeDir("machine-a");
      const machineB = await makeDir("machine-b");
      dirs.push(machineA, machineB);

      await writeFile(join(machineA, "hello.md"), "hello", "utf8");
      await writeFile(join(machineA, "notes.md"), "note", "utf8");

      const globalConfig = { github: { token: token! } };
      const stashA = await Stash.init(machineA, globalConfig);
      await stashA.connect("github", { repo: repo.fullName });
      await syncWithRetry(stashA);

      assert.equal(await getRawFile(repo.fullName, "hello.md"), "hello");
      assert.equal(await getRawFile(repo.fullName, "notes.md"), "note");
      assert.ok(await getRawFile(repo.fullName, ".stash/snapshot.json"));

      const stashB = await Stash.init(machineB, globalConfig);
      await stashB.connect("github", { repo: repo.fullName });
      await syncWithRetry(stashB);

      assert.equal(await readFile(join(machineB, "hello.md"), "utf8"), "hello");
      assert.equal(await readFile(join(machineB, "notes.md"), "utf8"), "note");
    } finally {
      if (repo) {
        await deleteRepo(repo.fullName);
      }
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  },
);

test(
  "e2e: two-machine text edits in different regions merge and converge",
  { skip: !token, timeout: 240_000 },
  async () => {
    let repo: RepoInfo | null = null;
    const dirs: string[] = [];
    try {
      repo = await createRepo();
      const machineA = await makeDir("machine-a");
      const machineB = await makeDir("machine-b");
      dirs.push(machineA, machineB);

      const globalConfig = { github: { token: token! } };
      await writeFile(join(machineA, "hello.md"), "line1\nline2\nline3", "utf8");

      const stashA = await Stash.init(machineA, globalConfig);
      await stashA.connect("github", { repo: repo.fullName });
      await syncWithRetry(stashA);

      const stashB = await Stash.init(machineB, globalConfig);
      await stashB.connect("github", { repo: repo.fullName });
      await syncWithRetry(stashB);

      await writeFile(join(machineA, "hello.md"), "LINE1\nline2\nline3", "utf8");
      await syncWithRetry(stashA);
      await sleep(300);

      await writeFile(join(machineB, "hello.md"), "line1\nline2\nLINE3", "utf8");
      await syncWithRetry(stashB);
      let mergedB = await readFile(join(machineB, "hello.md"), "utf8");
      if (mergedB !== "LINE1\nline2\nLINE3") {
        await sleep(300);
        await syncWithRetry(stashB);
        mergedB = await readFile(join(machineB, "hello.md"), "utf8");
      }
      assert.equal(mergedB, "LINE1\nline2\nLINE3");

      await syncWithRetry(stashA);
      const mergedA = await readFile(join(machineA, "hello.md"), "utf8");
      assert.equal(mergedA, "LINE1\nline2\nLINE3");
    } finally {
      if (repo) {
        await deleteRepo(repo.fullName);
      }
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  },
);
