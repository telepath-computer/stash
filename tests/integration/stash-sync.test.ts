import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBuffer } from "../../src/utils/hash.ts";
import { GitRepoError, MultipleConnectionsError, PushConflictError, SyncLockError } from "../../src/errors.ts";
import { FakeProvider } from "../helpers/fake-provider.ts";
import { makeStash, writeFiles } from "../helpers/make-stash.ts";

function fakeRegistry(fake: FakeProvider) {
  class TestProvider {
    static spec = { setup: [], connect: [{ name: "repo", label: "Repo" }] };
    constructor() {
      return fake;
    }
  }

  return { fake: TestProvider as any };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("sync: first sync pushes all local files", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello", "notes/todo.md": "buy milk" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });

  await stash.sync();

  assert.equal(fake.files.get("hello.md"), "hello");
  assert.equal(fake.files.get("notes/todo.md"), "buy milk");
  assert.equal(typeof fake.snapshot["hello.md"]?.hash, "string");

  const localSnapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  assert.deepEqual(localSnapshot, fake.snapshot);
  assert.equal(await readFile(join(dir, ".stash", "snapshot", "hello.md"), "utf8"), "hello");
});

test("sync: first sync pulls all remote files", async () => {
  const fake = new FakeProvider({
    files: {
      "readme.md": "welcome",
      "data/config.json": "{}",
    },
    snapshot: {
      "readme.md": { hash: hashBuffer(Buffer.from("welcome", "utf8")) },
      "data/config.json": { hash: hashBuffer(Buffer.from("{}", "utf8")) },
    },
  });
  const { stash, dir } = await makeStash({}, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });

  await stash.sync();

  assert.equal(await readFile(join(dir, "readme.md"), "utf8"), "welcome");
  assert.equal(await readFile(join(dir, "data", "config.json"), "utf8"), "{}");
  const snapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  assert.deepEqual(snapshot, fake.snapshot);
});

test("sync: pulls remote files in nested directories when parent directories do not yet exist", async () => {
  const fake = new FakeProvider({
    files: {
      "a/b/c.md": "deep",
    },
    snapshot: {
      "a/b/c.md": { hash: hashBuffer(Buffer.from("deep", "utf8")) },
    },
  });
  const { stash, dir } = await makeStash({}, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });

  await stash.sync();

  assert.equal(await readFile(join(dir, "a", "b", "c.md"), "utf8"), "deep");
});

test("sync: merge cycle preserves both edits", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "line1\nline2\nline3" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  await writeFiles(dir, { "hello.md": "LINE1\nline2\nline3" });
  fake.files.set("hello.md", "line1\nline2\nLINE3");
  fake.snapshot["hello.md"] = {
    hash: hashBuffer(Buffer.from("line1\nline2\nLINE3", "utf8")),
  };

  await stash.sync();

  const merged = await readFile(join(dir, "hello.md"), "utf8");
  assert.equal(merged, "LINE1\nline2\nLINE3");
  assert.equal(fake.files.get("hello.md"), "LINE1\nline2\nLINE3");
});

test("sync: emits mutation events", async () => {
  const fake = new FakeProvider();
  const { stash } = await makeStash({ "hello.md": "hello" }, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });

  const mutations: unknown[] = [];
  stash.on("mutation", (m) => {
    mutations.push(m);
  });

  await stash.sync();
  assert.equal(mutations.length > 0, true);
});

test("sync: push payload contains expected files deletions and snapshot", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello", "remove.md": "remove-me" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  await writeFiles(dir, { "hello.md": "hello world", "new.md": "draft" });
  await unlink(join(dir, "remove.md"));
  await stash.sync();

  const lastPush = fake.pushLog.at(-1);
  assert.ok(lastPush);
  assert.equal(lastPush.files.get("hello.md"), "hello world");
  assert.equal(lastPush.files.get("new.md"), "draft");
  assert.deepEqual(lastPush.deletions, ["remove.md"]);
  assert.equal(typeof lastPush.snapshot["hello.md"]?.hash, "string");
  assert.equal(lastPush.snapshot["remove.md"], undefined);
});

test("sync: PushConflictError triggers retry", async () => {
  const fake = new FakeProvider();
  const { stash } = await makeStash({ "hello.md": "hello" }, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  fake.failNextPush = true;

  await stash.sync();
  assert.equal(fake.pushCalls, 2);
  assert.equal(fake.fetchCalls >= 2, true);
});

test("sync: max retries exceeded throws", async () => {
  const fake = new FakeProvider();
  const { stash } = await makeStash({ "hello.md": "hello" }, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  fake.alwaysConflict = true;

  await assert.rejects(stash.sync(), PushConflictError);
  assert.equal(fake.pushCalls, 5);
});

test("sync: no connection is a no-op", async () => {
  const { stash } = await makeStash({ "hello.md": "hello" });
  await stash.sync();
});

test("sync: single-flight guard rejects concurrent sync", async () => {
  const fake = new FakeProvider();
  const { stash } = await makeStash({ "hello.md": "hello" }, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });

  fake.push = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return FakeProvider.prototype.push.apply(fake, args as any);
  };

  const first = stash.sync();
  await assert.rejects(stash.sync(), SyncLockError);
  await first;
});

test("sync: snapshot writes text files and skips binary files", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    {
      "text.md": "hello",
      "img.bin": Buffer.from([0xff, 0xfe, 0x00]),
    },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  assert.equal(await readFile(join(dir, ".stash", "snapshot", "text.md"), "utf8"), "hello");
  assert.equal(existsSync(join(dir, ".stash", "snapshot", "img.bin")), false);
});

test("sync: deleting a file removes it from snapshot", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();
  assert.equal(existsSync(join(dir, ".stash", "snapshot", "hello.md")), true);

  await unlink(join(dir, "hello.md"));
  await stash.sync();
  assert.equal(existsSync(join(dir, ".stash", "snapshot", "hello.md")), false);
});

test("sync: first sync with identical content on both sides skips file writes", async () => {
  const fake = new FakeProvider({
    files: {
      "hello.md": "hello",
      "notes/todo.md": "buy milk",
    },
    snapshot: {
      "hello.md": { hash: hashBuffer(Buffer.from("hello", "utf8")) },
      "notes/todo.md": { hash: hashBuffer(Buffer.from("buy milk", "utf8")) },
    },
  });
  const { stash, dir } = await makeStash(
    { "hello.md": "hello", "notes/todo.md": "buy milk" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });

  await stash.sync();

  const lastPush = fake.pushLog.at(-1);
  assert.ok(lastPush, "push should have happened (snapshot needs to reach remote)");
  assert.equal(lastPush.files.size, 0, "no file content should be pushed");
  assert.deepEqual(lastPush.deletions, [], "no deletions should be pushed");

  assert.equal(await readFile(join(dir, "hello.md"), "utf8"), "hello");
  assert.equal(await readFile(join(dir, "notes/todo.md"), "utf8"), "buy milk");

  const localSnapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  assert.equal(localSnapshot["hello.md"]?.hash, hashBuffer(Buffer.from("hello", "utf8")));
  assert.equal(localSnapshot["notes/todo.md"]?.hash, hashBuffer(Buffer.from("buy milk", "utf8")));

  assert.equal(await readFile(join(dir, ".stash", "snapshot", "hello.md"), "utf8"), "hello");
  assert.equal(
    await readFile(join(dir, ".stash", "snapshot", "notes/todo.md"), "utf8"),
    "buy milk",
  );
});

test("sync: git repository without allow-git throws", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await mkdir(join(dir, ".git"), { recursive: true });

  await assert.rejects(stash.sync(), GitRepoError);
  assert.equal(fake.fetchCalls, 0);
  assert.equal(fake.pushCalls, 0);
});

test("sync: multiple connections throws", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "first", provider: "fake", repo: "r1" });
  // Bypass the connect guard by writing a second connection directly
  const configPath = join(dir, ".stash", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.connections.second = { provider: "fake", repo: "r2" };
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  // Reload to pick up both connections
  const { Stash } = await import("../../src/stash.ts");
  const reloaded = await Stash.load(dir, { providers: {}, background: { stashes: [] } }, { providers: fakeRegistry(fake) });

  await assert.rejects(reloaded.sync(), MultipleConnectionsError);
  assert.equal(fake.fetchCalls, 0);
  assert.equal(fake.pushCalls, 0);
});

test("sync: allow-git permits syncing inside a git repository", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await writeFile(
    join(dir, ".stash", "config.json"),
    JSON.stringify(
      { "allow-git": true, connections: { fake: { provider: "fake", repo: "r" } } },
      null,
      2,
    ),
    "utf8",
  );
  await mkdir(join(dir, ".git"), { recursive: true });

  await stash.sync();
  assert.equal(fake.files.get("hello.md"), "hello");
});

test("sync: skip/skip mutations with changed snapshot still pushes snapshot", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  await writeFiles(dir, { "hello.md": "updated" });
  fake.files.set("hello.md", "updated");
  fake.snapshot["hello.md"] = {
    hash: hashBuffer(Buffer.from("updated", "utf8")),
  };

  await stash.sync();

  const lastPush = fake.pushLog.at(-1);
  assert.ok(lastPush, "push should happen because snapshot changed");
  assert.equal(lastPush.files.size, 0, "no file content should be pushed");
  assert.deepEqual(lastPush.deletions, [], "no deletions should be pushed");

  const localSnapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  assert.equal(localSnapshot["hello.md"]?.hash, hashBuffer(Buffer.from("updated", "utf8")));
});

test("sync: remote-source binary winner is not re-uploaded", async () => {
  const baseline = Buffer.from([0xff, 0x00, 0x03]);
  const remote = Buffer.from([0xfe, 0x00, 0x06]);
  const fake = new FakeProvider({
    files: { "img.bin": baseline },
    snapshot: {
      "img.bin": { hash: hashBuffer(baseline), modified: 1_000 },
    },
  });

  const { stash, dir } = await makeStash(
    { "img.bin": baseline },
    {
      providers: fakeRegistry(fake),
      snapshot: {
        "img.bin": { hash: hashBuffer(baseline), modified: 1_000 },
      },
    },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });

  await writeFiles(dir, { "img.bin": Buffer.from([0xfd, 0x00, 0x09]) });
  fake.files.set("img.bin", remote);
  fake.snapshot["img.bin"] = { hash: hashBuffer(remote), modified: 9_999_999_999_999 };

  await stash.sync();

  const lastPush = fake.pushLog.at(-1);
  if (lastPush) {
    assert.equal(lastPush.files.has("img.bin"), false);
  } else {
    assert.equal(fake.pushLog.length, 0);
  }
  assert.equal(fake.getCalls, 1);
});

test("sync: preserves local edits made after scan but before push (pre-push race window)", async () => {
  const baseline = "line1\nline2\nline3\n";
  const aliceEarly = "ALICE_EARLY line1\nline2\nline3\n";
  const aliceLate = "ALICE_LATE line1\nline2\nline3\n";
  const bobRemote = "line1\nline2\nline3\nBOB_END\n";

  const fake = new FakeProvider();
  const { stash, dir } = await makeStash({ "doc.md": baseline }, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  // Bob's change exists remotely before Alice starts this sync.
  fake.files.set("doc.md", bobRemote);
  fake.snapshot["doc.md"] = { hash: hashBuffer(Buffer.from(bobRemote, "utf8")) };

  // Alice starts with an early local edit that should participate in merge.
  await writeFiles(dir, { "doc.md": aliceEarly });

  // Pause fetch so we can mutate local file after scan() has already run.
  const gate = deferred();
  const fetchStarted = deferred();
  const originalFetch = fake.fetch.bind(fake);
  fake.fetch = async (...args) => {
    fetchStarted.resolve();
    await gate.promise;
    return originalFetch(...args);
  };

  const syncPromise = stash.sync();
  await fetchStarted.promise;

  // This edit happens in-flight and is not represented in localChanges.
  await writeFiles(dir, { "doc.md": aliceLate });
  gate.resolve();
  await syncPromise;

  const final = await readFile(join(dir, "doc.md"), "utf8");
  assert.equal(final.includes("ALICE_LATE"), true);
  assert.equal(final.includes("BOB_END"), true);
});

test("sync: preserves local edits made after push but before apply (post-push race window)", async () => {
  const baseline = "line1\nline2\nline3\n";
  const aliceEarly = "ALICE_EARLY line1\nline2\nline3\n";
  const aliceLate = "ALICE_LATE line1\nline2\nline3\n";
  const bobRemote = "line1\nline2\nline3\nBOB_END\n";

  const fake = new FakeProvider();
  const { stash, dir } = await makeStash({ "doc.md": baseline }, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  // Bob's change exists remotely before Alice starts this sync.
  fake.files.set("doc.md", bobRemote);
  fake.snapshot["doc.md"] = { hash: hashBuffer(Buffer.from(bobRemote, "utf8")) };

  // Alice starts with an early local edit that should participate in merge.
  await writeFiles(dir, { "doc.md": aliceEarly });

  // Pause right after provider.push() has applied remote state, but before sync proceeds to apply().
  const gate = deferred();
  const pushCompleted = deferred();
  const originalPush = fake.push.bind(fake);
  fake.push = async (payload) => {
    await originalPush(payload);
    pushCompleted.resolve();
    await gate.promise;
  };

  const syncPromise = stash.sync();
  await pushCompleted.promise;

  // This edit happens after remote push, before local apply writes merged content.
  await writeFiles(dir, { "doc.md": aliceLate });
  gate.resolve();
  await syncPromise;

  const immediate = await readFile(join(dir, "doc.md"), "utf8");
  assert.equal(immediate.includes("ALICE_LATE"), true);

  await stash.sync();
  const converged = await readFile(join(dir, "doc.md"), "utf8");
  assert.equal(converged.includes("ALICE_LATE"), true);
  assert.equal(converged.includes("BOB_END"), true);
});

test("sync: drift retries are bounded and failed cycle does not apply/save", async () => {
  const baseline = "line1\nline2\nline3\n";
  const aliceEarly = "ALICE_EARLY line1\nline2\nline3\n";
  const bobRemote = "line1\nline2\nline3\nBOB_END\n";

  const fake = new FakeProvider();
  const { stash, dir } = await makeStash({ "doc.md": baseline }, { providers: fakeRegistry(fake) });
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  fake.files.set("doc.md", bobRemote);
  fake.snapshot["doc.md"] = { hash: hashBuffer(Buffer.from(bobRemote, "utf8")) };
  await writeFiles(dir, { "doc.md": aliceEarly });

  const beforeSnapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  fake.fetchCalls = 0;
  fake.pushCalls = 0;

  (stash as any).hasAnyPathDrift = () => true;

  await assert.rejects(stash.sync(), /local files changed during sync/i);
  assert.equal(fake.fetchCalls, 5);
  assert.equal(fake.pushCalls, 0);
  assert.equal(await readFile(join(dir, "doc.md"), "utf8"), aliceEarly);

  const afterSnapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  assert.deepEqual(afterSnapshot, beforeSnapshot);
});

test("sync: case-only rename syncs successfully", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "notes/Arabella.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  // Rename to lowercase on disk (two-step for case-insensitive FS)
  const tmp = join(dir, "notes", "Arabella.md.tmp");
  await rename(join(dir, "notes", "Arabella.md"), tmp);
  await rename(tmp, join(dir, "notes", "arabella.md"));

  await stash.sync();

  // Remote should have the new-case file
  assert.equal(fake.files.has("notes/arabella.md"), true);
  assert.equal(fake.files.get("notes/arabella.md"), "hello");
  // Old-case path should be gone from remote
  assert.equal(fake.files.has("notes/Arabella.md"), false);
  // Snapshot updated to new casing
  const snapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  assert.ok(snapshot["notes/arabella.md"]);
  assert.equal(snapshot["notes/Arabella.md"], undefined);
});

test("sync: case-only rename with content change syncs successfully", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "notes/Arabella.md": "v1" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  // Rename and change content
  const tmp = join(dir, "notes", "Arabella.md.tmp");
  await rename(join(dir, "notes", "Arabella.md"), tmp);
  await rename(tmp, join(dir, "notes", "arabella.md"));
  await writeFiles(dir, { "notes/arabella.md": "v2" });

  await stash.sync();

  assert.equal(fake.files.get("notes/arabella.md"), "v2");
  assert.equal(fake.files.has("notes/Arabella.md"), false);
});

test("sync: case-only rename does not trigger drift retry", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "notes/Arabella.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();
  fake.fetchCalls = 0;

  const tmp = join(dir, "notes", "Arabella.md.tmp");
  await rename(join(dir, "notes", "Arabella.md"), tmp);
  await rename(tmp, join(dir, "notes", "arabella.md"));

  await stash.sync();

  // Only 1 fetch call — no drift retries
  assert.equal(fake.fetchCalls, 1);
});

test("sync: directory case rename applies correctly on pull", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "Notes/draft.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  // Simulate remote rename: Notes/draft.md → notes/draft.md
  fake.files.delete("Notes/draft.md");
  fake.files.set("notes/draft.md", "hello");
  delete fake.snapshot["Notes/draft.md"];
  fake.snapshot["notes/draft.md"] = {
    hash: hashBuffer(Buffer.from("hello")),
    type: "text",
  };

  await stash.sync();

  // Verify disk has lowercase directory
  const dirs = readdirSync(dir).filter((e) => e.toLowerCase() === "notes");
  assert.deepEqual(dirs, ["notes"]);
  assert.equal(await readFile(join(dir, "notes", "draft.md"), "utf8"), "hello");
});

test("sync: nested directory case rename applies correctly", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "Docs/Notes/draft.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  // Simulate remote rename: Docs/Notes/ → docs/notes/
  fake.files.delete("Docs/Notes/draft.md");
  fake.files.set("docs/notes/draft.md", "hello");
  delete fake.snapshot["Docs/Notes/draft.md"];
  fake.snapshot["docs/notes/draft.md"] = {
    hash: hashBuffer(Buffer.from("hello")),
    type: "text",
  };

  await stash.sync();

  // Verify both directory segments renamed
  const topDirs = readdirSync(dir).filter((e) => e.toLowerCase() === "docs");
  assert.deepEqual(topDirs, ["docs"]);
  const nestedDirs = readdirSync(join(dir, "docs")).filter((e) => e.toLowerCase() === "notes");
  assert.deepEqual(nestedDirs, ["notes"]);
  assert.equal(await readFile(join(dir, "docs", "notes", "draft.md"), "utf8"), "hello");
});

test("sync: true deletion still works alongside casing check", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "notes/Arabella.md": "hello", "other.md": "keep" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect({ name: "fake", provider: "fake", repo: "r" });
  await stash.sync();

  await unlink(join(dir, "notes", "Arabella.md"));

  await stash.sync();

  assert.equal(fake.files.has("notes/Arabella.md"), false);
  assert.equal(fake.files.get("other.md"), "keep");
  const snapshot = JSON.parse(await readFile(join(dir, ".stash", "snapshot.json"), "utf8"));
  assert.equal(snapshot["notes/Arabella.md"], undefined);
});
