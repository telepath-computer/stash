import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Stash } from "../../src/stash.ts";
import { hashBuffer } from "../../src/utils/hash.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const token = process.env.GITHUB_TOKEN;
const E2E_OPTIONS = { skip: !token, timeout: 300_000 };

type RepoInfo = { fullName: string };
type Machine = { dir: string; stash: Stash };
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
        await sleep(500);
        continue;
      }
    }
  }
  throw lastError;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function githubRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "stash-e2e-test",
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function githubJson(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<any> {
  const response = await githubRequest(method, path, body, headers);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function isSecondaryRateLimit(status: number, message: string): boolean {
  return (
    status === 403 &&
    message.toLowerCase().includes("secondary rate limit")
  );
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
  const response = await githubRequest("DELETE", `/repos/${fullName}`);
  if (response.status !== 204 && response.status !== 404) {
    const text = await response.text();
    throw new Error(`Failed to delete ${fullName}: ${response.status} ${text}`);
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}-`));
}

async function writeLocalFiles(
  dir: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(dir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content);
  }
}

async function runCli(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("node", [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
  });
}

async function remoteFileExists(repo: string, path: string): Promise<boolean> {
  const response = await githubRequest(
    "GET",
    `/repos/${repo}/contents/${encodePath(path)}?ref=main`,
    undefined,
    { Accept: "application/vnd.github.raw+json" },
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed checking remote path ${path}: ${response.status} ${text}`);
  }
  return true;
}

async function readRemoteText(repo: string, path: string): Promise<string> {
  const response = await githubRequest(
    "GET",
    `/repos/${repo}/contents/${encodePath(path)}?ref=main`,
    undefined,
    { Accept: "application/vnd.github.raw+json" },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed reading remote ${path}: ${response.status} ${text}`);
  }
  return response.text();
}

async function readRemoteBuffer(repo: string, path: string): Promise<Buffer> {
  const response = await githubRequest(
    "GET",
    `/repos/${repo}/contents/${encodePath(path)}?ref=main`,
    undefined,
    { Accept: "application/vnd.github.raw+json" },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed reading remote buffer ${path}: ${response.status} ${text}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function upsertRemoteFile(
  repo: string,
  path: string,
  content: string | Buffer,
  message = `seed ${path}`,
): Promise<void> {
  let sha: string | undefined;
  const current = await githubRequest(
    "GET",
    `/repos/${repo}/contents/${encodePath(path)}?ref=main`,
  );
  if (current.ok) {
    const body = await current.json();
    sha = body.sha as string;
  } else if (current.status !== 404) {
    const text = await current.text();
    throw new Error(`Failed loading existing ${path}: ${current.status} ${text}`);
  }

  const payload: Record<string, unknown> = {
    message,
    content: Buffer.isBuffer(content)
      ? content.toString("base64")
      : Buffer.from(content, "utf8").toString("base64"),
    branch: "main",
  };
  if (sha) {
    payload.sha = sha;
  }

  await githubJson(
    "PUT",
    `/repos/${repo}/contents/${encodePath(path)}`,
    payload,
  );
}

async function createMachine(
  dir: string,
  repo: string,
  globalConfig: { github: { token: string } },
): Promise<Machine> {
  const stash = await Stash.init(dir, globalConfig);
  await stash.connect("github", { repo });
  return { dir, stash };
}

async function setupTwoMachineBaseline(
  initialFiles: Record<string, string | Buffer>,
): Promise<{
  repo: RepoInfo;
  machineA: Machine;
  machineB: Machine;
  dirs: string[];
}> {
  const repo = await createRepo();
  const machineADir = await makeTempDir("machine-a");
  const machineBDir = await makeTempDir("machine-b");
  const globalConfig = { github: { token: token! } };

  const machineA = await createMachine(machineADir, repo.fullName, globalConfig);
  const machineB = await createMachine(machineBDir, repo.fullName, globalConfig);
  await writeLocalFiles(machineA.dir, initialFiles);
  await syncWithRetry(machineA.stash);
  await syncWithRetry(machineB.stash);

  return { repo, machineA, machineB, dirs: [machineADir, machineBDir] };
}

test("scenario 1: init creates stash and keeps existing files", E2E_OPTIONS, async () => {
  const dir = await makeTempDir("init");
  try {
    await writeFile(join(dir, "hello.md"), "hello", "utf8");
    await runCli(dir, ["init"]);
    assert.equal(existsSync(join(dir, ".stash")), true);
    assert.equal(await readFile(join(dir, "hello.md"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scenario 2: init on existing stash is a no-op", E2E_OPTIONS, async () => {
  const dir = await makeTempDir("init-idempotent");
  try {
    await runCli(dir, ["init"]);
    const second = await runCli(dir, ["init"]);
    assert.equal(second.stdout.includes("Already initialized"), true);
    assert.equal(existsSync(join(dir, ".stash")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scenario 3: setup stores provider credentials globally", E2E_OPTIONS, async () => {
  const dir = await makeTempDir("setup");
  const xdg = await makeTempDir("xdg");
  try {
    await runCli(dir, ["setup", "github", "--token", "test-token"], {
      XDG_CONFIG_HOME: xdg,
    });
    const configPath = join(xdg, "stash", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config, { github: { token: "test-token" } });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("scenario 4: connect stores stash connection config", E2E_OPTIONS, async () => {
  const dir = await makeTempDir("connect");
  const xdg = await makeTempDir("xdg");
  try {
    await runCli(dir, ["init"]);
    await runCli(dir, ["setup", "github", "--token", "test-token"], {
      XDG_CONFIG_HOME: xdg,
    });
    await runCli(dir, ["connect", "github", "--repo", "user/repo"], {
      XDG_CONFIG_HOME: xdg,
    });
    const config = JSON.parse(
      await readFile(join(dir, ".stash", "config.local.json"), "utf8"),
    );
    assert.deepEqual(config, { connections: { github: { repo: "user/repo" } } });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("scenario 5: connect auto-writes setup config when missing", E2E_OPTIONS, async () => {
  const dir = await makeTempDir("connect-autosetup");
  const xdg = await makeTempDir("xdg");
  try {
    await runCli(dir, ["init"]);
    await runCli(
      dir,
      ["connect", "github", "--repo", "user/repo", "--token", "from-connect"],
      { XDG_CONFIG_HOME: xdg },
    );

    const globalConfig = JSON.parse(
      await readFile(join(xdg, "stash", "config.json"), "utf8"),
    );
    assert.deepEqual(globalConfig, { github: { token: "from-connect" } });

    const localConfig = JSON.parse(
      await readFile(join(dir, ".stash", "config.local.json"), "utf8"),
    );
    assert.deepEqual(localConfig, {
      connections: {
        github: { repo: "user/repo" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("scenario 6: disconnect removes connection and sync becomes no-op", E2E_OPTIONS, async () => {
  const dir = await makeTempDir("disconnect");
  const xdg = await makeTempDir("xdg");
  try {
    await runCli(dir, ["init"]);
    await writeFile(join(dir, "hello.md"), "hello", "utf8");
    await runCli(dir, ["setup", "github", "--token", "test-token"], {
      XDG_CONFIG_HOME: xdg,
    });
    await runCli(dir, ["connect", "github", "--repo", "user/repo"], {
      XDG_CONFIG_HOME: xdg,
    });
    await runCli(dir, ["disconnect", "github"], { XDG_CONFIG_HOME: xdg });

    const localConfig = JSON.parse(
      await readFile(join(dir, ".stash", "config.local.json"), "utf8"),
    );
    assert.deepEqual(localConfig, { connections: {} });

    await runCli(dir, ["sync"], { XDG_CONFIG_HOME: xdg });
    assert.equal(await readFile(join(dir, "hello.md"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("scenario 8: first sync pulls remote files to empty local", E2E_OPTIONS, async () => {
  let repo: RepoInfo | null = null;
  const dirs: string[] = [];
  try {
    repo = await createRepo();
    await upsertRemoteFile(repo.fullName, "readme.md", "welcome");
    await upsertRemoteFile(repo.fullName, "data/config.json", "{}");
    await upsertRemoteFile(
      repo.fullName,
      ".stash/snapshot.json",
      JSON.stringify({
        "readme.md": { hash: hashBuffer(Buffer.from("welcome", "utf8")) },
        "data/config.json": { hash: hashBuffer(Buffer.from("{}", "utf8")) },
      }),
    );

    const machine = await makeTempDir("machine");
    dirs.push(machine);
    const stash = await Stash.init(machine, { github: { token: token! } });
    await stash.connect("github", { repo: repo.fullName });
    await syncWithRetry(stash);

    assert.equal(await readFile(join(machine, "readme.md"), "utf8"), "welcome");
    assert.equal(await readFile(join(machine, "data/config.json"), "utf8"), "{}");
    assert.equal(existsSync(join(machine, ".stash", "snapshot.json")), true);
    assert.equal(existsSync(join(machine, ".stash", "snapshot.local", "readme.md")), true);
  } finally {
    if (repo) await deleteRepo(repo.fullName);
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("scenario 9: first sync merges when local and remote both populated", E2E_OPTIONS, async () => {
  let repo: RepoInfo | null = null;
  const dirs: string[] = [];
  try {
    repo = await createRepo();
    await upsertRemoteFile(repo.fullName, "shared.md", "remote content");

    const machine = await makeTempDir("machine");
    dirs.push(machine);
    await writeFile(join(machine, "local.md"), "local content", "utf8");
    const stash = await Stash.init(machine, { github: { token: token! } });
    await stash.connect("github", { repo: repo.fullName });
    await syncWithRetry(stash);

    assert.equal(await readFile(join(machine, "shared.md"), "utf8"), "remote content");
    assert.equal(await readFile(join(machine, "local.md"), "utf8"), "local content");
    assert.equal(await remoteFileExists(repo.fullName, "shared.md"), true);
    assert.equal(await remoteFileExists(repo.fullName, "local.md"), true);
    const snapshot = JSON.parse(
      await readFile(join(machine, ".stash", "snapshot.json"), "utf8"),
    );
    assert.equal(typeof snapshot["shared.md"]?.hash, "string");
    assert.equal(typeof snapshot["local.md"]?.hash, "string");
  } finally {
    if (repo) await deleteRepo(repo.fullName);
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("scenario 10: local edit with unchanged remote pushes local", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await writeFile(join(setup.machineA.dir, "hello.md"), "hello world", "utf8");
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await readRemoteText(setup.repo.fullName, "hello.md"), "hello world");
    await syncWithRetry(setup.machineB.stash);
    assert.equal(await readFile(join(setup.machineB.dir, "hello.md"), "utf8"), "hello world");
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 11: remote edit with unchanged local pulls remote", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await writeFile(join(setup.machineA.dir, "hello.md"), "hello world", "utf8");
    await syncWithRetry(setup.machineA.stash);
    await syncWithRetry(setup.machineB.stash);
    assert.equal(await readFile(join(setup.machineB.dir, "hello.md"), "utf8"), "hello world");
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 13: overlapping text edits preserve both versions", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello world" });
    await writeFile(join(setup.machineA.dir, "hello.md"), "hello brave world", "utf8");
    await syncWithRetry(setup.machineA.stash);
    await sleep(300);
    await writeFile(join(setup.machineB.dir, "hello.md"), "hello cruel world", "utf8");
    await syncWithRetry(setup.machineB.stash);
    let merged = await readFile(join(setup.machineB.dir, "hello.md"), "utf8");
    if (!merged.includes("brave") || !merged.includes("cruel")) {
      await sleep(300);
      await syncWithRetry(setup.machineB.stash);
      merged = await readFile(join(setup.machineB.dir, "hello.md"), "utf8");
    }
    assert.equal(merged.includes("brave"), true);
    assert.equal(merged.includes("cruel"), true);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 14: one-side file create pushes then pulls", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await writeFile(join(setup.machineA.dir, "new.md"), "draft", "utf8");
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await readRemoteText(setup.repo.fullName, "new.md"), "draft");
    await syncWithRetry(setup.machineB.stash);
    assert.equal(await readFile(join(setup.machineB.dir, "new.md"), "utf8"), "draft");
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 15: both create same path converges on a single result", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await writeFile(join(setup.machineA.dir, "notes.md"), "from A", "utf8");
    await writeFile(join(setup.machineB.dir, "notes.md"), "from B", "utf8");
    await syncWithRetry(setup.machineA.stash);
    await syncWithRetry(setup.machineB.stash);
    await syncWithRetry(setup.machineA.stash);

    const a = await readFile(join(setup.machineA.dir, "notes.md"), "utf8");
    const b = await readFile(join(setup.machineB.dir, "notes.md"), "utf8");
    assert.equal(a, b);
    assert.equal(await readRemoteText(setup.repo.fullName, "notes.md"), a);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 16: one-side delete with other unchanged deletes everywhere", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await unlink(join(setup.machineA.dir, "hello.md"));
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await remoteFileExists(setup.repo.fullName, "hello.md"), false);
    await syncWithRetry(setup.machineB.stash);
    assert.equal(existsSync(join(setup.machineB.dir, "hello.md")), false);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 17: local delete and remote edit keeps content", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await unlink(join(setup.machineA.dir, "hello.md"));
    await writeFile(join(setup.machineB.dir, "hello.md"), "hello world", "utf8");
    await syncWithRetry(setup.machineB.stash);
    await syncWithRetry(setup.machineA.stash);
    let restored = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (existsSync(join(setup.machineA.dir, "hello.md"))) {
        const content = await readFile(join(setup.machineA.dir, "hello.md"), "utf8");
        if (content === "hello world") {
          restored = true;
          break;
        }
      }
      await sleep(300);
      await syncWithRetry(setup.machineA.stash);
    }
    assert.equal(restored, true);
    assert.equal(await readRemoteText(setup.repo.fullName, "hello.md"), "hello world");
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 18: local edit and remote delete keeps local content", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await writeFile(join(setup.machineA.dir, "hello.md"), "hello world", "utf8");
    await unlink(join(setup.machineB.dir, "hello.md"));
    await syncWithRetry(setup.machineB.stash);
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await readFile(join(setup.machineA.dir, "hello.md"), "utf8"), "hello world");
    assert.equal(await readRemoteText(setup.repo.fullName, "hello.md"), "hello world");
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 19: both delete keeps file deleted", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await unlink(join(setup.machineA.dir, "hello.md"));
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await remoteFileExists(setup.repo.fullName, "hello.md"), false);
    if (existsSync(join(setup.machineB.dir, "hello.md"))) {
      await unlink(join(setup.machineB.dir, "hello.md"));
    }
    await syncWithRetry(setup.machineB.stash);
    assert.equal(await remoteFileExists(setup.repo.fullName, "hello.md"), false);
    assert.equal(existsSync(join(setup.machineB.dir, "hello.md")), false);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 20: binary file round-trip remains byte-identical", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({});
    const bytes = Buffer.from([0xff, 0x00, ...randomBytes(32)]);
    await writeFile(join(setup.machineA.dir, "image.png"), bytes);
    await syncWithRetry(setup.machineA.stash);
    await syncWithRetry(setup.machineB.stash);
    const pulled = await readFile(join(setup.machineB.dir, "image.png"));
    assert.deepEqual(pulled, bytes);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 21: concurrent binary edits resolve to last writer", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "image.png": Buffer.from([0xff, 0x00, 1]) });

    const bytesA = Buffer.from([0xff, 0x00, 2, ...randomBytes(8)]);
    const bytesB = Buffer.from([0xff, 0x00, 3, ...randomBytes(8)]);
    await writeFile(join(setup.machineA.dir, "image.png"), bytesA);
    await syncWithRetry(setup.machineA.stash);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(join(setup.machineB.dir, "image.png"), bytesB);
    await syncWithRetry(setup.machineB.stash);
    await syncWithRetry(setup.machineA.stash);

    const a = await readFile(join(setup.machineA.dir, "image.png"));
    const b = await readFile(join(setup.machineB.dir, "image.png"));
    assert.deepEqual(a, bytesB);
    assert.deepEqual(b, bytesB);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 22: sync with no connection is a no-op", E2E_OPTIONS, async () => {
  const dir = await makeTempDir("no-connection");
  try {
    await writeFile(join(dir, "hello.md"), "hello", "utf8");
    const stash = await Stash.init(dir, { github: { token: token! } });
    await syncWithRetry(stash);
    assert.equal(await readFile(join(dir, "hello.md"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scenario 23: nested directory paths are preserved", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({});
    await writeLocalFiles(setup.machineA.dir, { "a/b/c.md": "deep" });
    await syncWithRetry(setup.machineA.stash);
    await syncWithRetry(setup.machineB.stash);
    assert.equal(await readFile(join(setup.machineB.dir, "a/b/c.md"), "utf8"), "deep");
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 24: empty files sync correctly", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({});
    await writeFile(join(setup.machineA.dir, "empty.md"), "", "utf8");
    await syncWithRetry(setup.machineA.stash);
    await syncWithRetry(setup.machineB.stash);
    assert.equal(await readFile(join(setup.machineB.dir, "empty.md"), "utf8"), "");
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 25: multiple sync cycles converge to identical state", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({
      "a.md": "a",
      "b.md": "b",
      "c.md": "c",
    });
    await writeFile(join(setup.machineA.dir, "a.md"), "a2", "utf8");
    await unlink(join(setup.machineA.dir, "b.md"));
    await writeFile(join(setup.machineA.dir, "d.md"), "d", "utf8");

    await writeFile(join(setup.machineB.dir, "b.md"), "b2", "utf8");
    await writeFile(join(setup.machineB.dir, "c.md"), "c2", "utf8");
    await writeFile(join(setup.machineB.dir, "e.md"), "e", "utf8");

    await syncWithRetry(setup.machineA.stash);
    await syncWithRetry(setup.machineB.stash);
    await syncWithRetry(setup.machineA.stash);

    const expected = {
      "a.md": "a2",
      "b.md": "b2",
      "c.md": "c2",
      "d.md": "d",
      "e.md": "e",
    };
    let validated = false;
    for (let attempt = 0; attempt < 3 && !validated; attempt += 1) {
      try {
        for (const [path, content] of Object.entries(expected)) {
          assert.equal(await readFile(join(setup.machineA.dir, path), "utf8"), content);
          assert.equal(await readFile(join(setup.machineB.dir, path), "utf8"), content);
        }
        validated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 2) {
          throw error;
        }
        await syncWithRetry(setup.machineB.stash);
        await syncWithRetry(setup.machineA.stash);
      }
    }

    if (!validated) {
      throw new Error("Failed to validate converged file set");
    }
    const snapA = JSON.parse(
      await readFile(join(setup.machineA.dir, ".stash", "snapshot.json"), "utf8"),
    );
    const snapB = JSON.parse(
      await readFile(join(setup.machineB.dir, ".stash", "snapshot.json"), "utf8"),
    );
    assert.deepEqual(snapA, snapB);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 26: status shows local changes since last sync", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello", "old.md": "old" });
    await writeFile(join(setup.machineA.dir, "new.md"), "new", "utf8");
    await writeFile(join(setup.machineA.dir, "hello.md"), "hello world", "utf8");
    await unlink(join(setup.machineA.dir, "old.md"));
    const status = setup.machineA.stash.status();
    assert.deepEqual(status.added, ["new.md"]);
    assert.deepEqual(status.modified, ["hello.md"]);
    assert.deepEqual(status.deleted, ["old.md"]);
    assert.ok(status.lastSync instanceof Date);
    assert.equal(setup.machineA.stash.connections.github.repo, setup.repo.fullName);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 27: status before first sync has null lastSync", E2E_OPTIONS, async () => {
  let repo: RepoInfo | null = null;
  const dirs: string[] = [];
  try {
    repo = await createRepo();
    const dir = await makeTempDir("status-first");
    dirs.push(dir);
    await writeFile(join(dir, "hello.md"), "hello", "utf8");
    const stash = await Stash.init(dir, { github: { token: token! } });
    await stash.connect("github", { repo: repo.fullName });
    const status = stash.status();
    assert.deepEqual(status.added, ["hello.md"]);
    assert.deepEqual(status.modified, []);
    assert.deepEqual(status.deleted, []);
    assert.equal(status.lastSync, null);
  } finally {
    if (repo) await deleteRepo(repo.fullName);
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("scenario 28: dotfiles are ignored", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({});
    await writeFile(join(setup.machineA.dir, ".hidden"), "secret", "utf8");
    await writeFile(join(setup.machineA.dir, "visible.md"), "public", "utf8");
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await remoteFileExists(setup.repo.fullName, "visible.md"), true);
    assert.equal(await remoteFileExists(setup.repo.fullName, ".hidden"), false);
    await syncWithRetry(setup.machineB.stash);
    assert.equal(existsSync(join(setup.machineB.dir, "visible.md")), true);
    assert.equal(existsSync(join(setup.machineB.dir, ".hidden")), false);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 29: dot-directories are ignored", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({});
    await writeLocalFiles(setup.machineA.dir, {
      ".config/settings.json": "{}",
      "notes.md": "note",
    });
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await remoteFileExists(setup.repo.fullName, "notes.md"), true);
    assert.equal(await remoteFileExists(setup.repo.fullName, ".config/settings.json"), false);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 30: symlinks are ignored", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({});
    await writeFile(join(setup.machineA.dir, "real.md"), "content", "utf8");
    await symlink(join(setup.machineA.dir, "real.md"), join(setup.machineA.dir, "link.md"));
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await remoteFileExists(setup.repo.fullName, "real.md"), true);
    assert.equal(await remoteFileExists(setup.repo.fullName, "link.md"), false);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 31: .stash local metadata is ignored remotely", E2E_OPTIONS, async () => {
  let setup: Awaited<ReturnType<typeof setupTwoMachineBaseline>> | null = null;
  try {
    setup = await setupTwoMachineBaseline({ "hello.md": "hello" });
    await syncWithRetry(setup.machineA.stash);
    assert.equal(await remoteFileExists(setup.repo.fullName, ".stash/config.local.json"), false);
    assert.equal(await remoteFileExists(setup.repo.fullName, ".stash/snapshot.local/hello.md"), false);
    assert.equal(await remoteFileExists(setup.repo.fullName, ".stash/snapshot.json"), true);
  } finally {
    if (setup) {
      await deleteRepo(setup.repo.fullName);
      await Promise.all(setup.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
});

test("scenario 32: first sync with identical local and remote content skips redundant writes", E2E_OPTIONS, async () => {
  let repo: RepoInfo | null = null;
  const dirs: string[] = [];
  try {
    repo = await createRepo();
    await upsertRemoteFile(repo.fullName, "hello.md", "hello");

    const machine = await makeTempDir("identical-first-sync");
    dirs.push(machine);
    await writeLocalFiles(machine, { "hello.md": "hello" });
    const stash = await Stash.init(machine, { github: { token: token! } });
    await stash.connect("github", { repo: repo.fullName });
    await syncWithRetry(stash);

    assert.equal(await readFile(join(machine, "hello.md"), "utf8"), "hello");
    assert.equal(await remoteFileExists(repo.fullName, ".stash/snapshot.json"), true);
    assert.equal(await readRemoteText(repo.fullName, "hello.md"), "hello");

    const localSnapshot = JSON.parse(
      await readFile(join(machine, ".stash", "snapshot.json"), "utf8"),
    );
    assert.equal(typeof localSnapshot["hello.md"]?.hash, "string");
    assert.equal(
      localSnapshot["hello.md"].hash,
      hashBuffer(Buffer.from("hello", "utf8")),
    );

    await syncWithRetry(stash);
    assert.equal(await readFile(join(machine, "hello.md"), "utf8"), "hello");
  } finally {
    if (repo) await deleteRepo(repo.fullName);
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("scenario 36: case-only rename syncs to remote and back", E2E_OPTIONS, async () => {
  let repo: RepoInfo | null = null;
  const dirs: string[] = [];
  try {
    const result = await setupTwoMachineBaseline({
      "notes/Arabella.md": "hello",
    });
    repo = result.repo;
    dirs.push(...result.dirs);
    const { machineA, machineB } = result;

    // Machine A: rename to lowercase (two-step for case-insensitive FS)
    const tmp = join(machineA.dir, "notes", "Arabella.md.tmp");
    await rename(join(machineA.dir, "notes", "Arabella.md"), tmp);
    await rename(tmp, join(machineA.dir, "notes", "arabella.md"));

    await syncWithRetry(machineA.stash);

    // Verify remote has new-case file, not old-case
    assert.equal(await remoteFileExists(repo.fullName, "notes/arabella.md"), true);
    assert.equal(await readRemoteText(repo.fullName, "notes/arabella.md"), "hello");
    assert.equal(await remoteFileExists(repo.fullName, "notes/Arabella.md"), false);

    // Machine B: sync should pull the rename
    await syncWithRetry(machineB.stash);
    assert.equal(
      await readFile(join(machineB.dir, "notes", "arabella.md"), "utf8"),
      "hello",
    );
  } finally {
    if (repo) await deleteRepo(repo.fullName);
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});
