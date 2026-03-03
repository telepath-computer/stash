import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hashBuffer } from "../../src/utils/hash.ts";
import { PushConflictError, SyncLockError } from "../../src/errors.ts";
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

test("sync: first sync pushes all local files", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello", "notes/todo.md": "buy milk" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });

  await stash.sync();

  assert.equal(fake.files.get("hello.md"), "hello");
  assert.equal(fake.files.get("notes/todo.md"), "buy milk");
  assert.equal(typeof fake.snapshot["hello.md"]?.hash, "string");

  const localSnapshot = JSON.parse(
    await readFile(join(dir, ".stash", "snapshot.json"), "utf8"),
  );
  assert.deepEqual(localSnapshot, fake.snapshot);
  assert.equal(
    await readFile(join(dir, ".stash", "snapshot.local", "hello.md"), "utf8"),
    "hello",
  );
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
  await stash.connect("fake", { repo: "r" });

  await stash.sync();

  assert.equal(await readFile(join(dir, "readme.md"), "utf8"), "welcome");
  assert.equal(await readFile(join(dir, "data", "config.json"), "utf8"), "{}");
  const snapshot = JSON.parse(
    await readFile(join(dir, ".stash", "snapshot.json"), "utf8"),
  );
  assert.deepEqual(snapshot, fake.snapshot);
});

test("sync: merge cycle preserves both edits", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "line1\nline2\nline3" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });
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
  await stash.connect("fake", { repo: "r" });

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
  await stash.connect("fake", { repo: "r" });
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
  await stash.connect("fake", { repo: "r" });
  fake.failNextPush = true;

  await stash.sync();
  assert.equal(fake.pushCalls, 2);
  assert.equal(fake.fetchCalls >= 2, true);
});

test("sync: max retries exceeded throws", async () => {
  const fake = new FakeProvider();
  const { stash } = await makeStash({ "hello.md": "hello" }, { providers: fakeRegistry(fake) });
  await stash.connect("fake", { repo: "r" });
  fake.alwaysConflict = true;

  await assert.rejects(stash.sync(), PushConflictError);
  assert.equal(fake.pushCalls, 3);
});

test("sync: no connection is a no-op", async () => {
  const { stash } = await makeStash({ "hello.md": "hello" });
  await stash.sync();
});

test("sync: single-flight guard rejects concurrent sync", async () => {
  const fake = new FakeProvider();
  const { stash } = await makeStash({ "hello.md": "hello" }, { providers: fakeRegistry(fake) });
  await stash.connect("fake", { repo: "r" });

  fake.push = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return FakeProvider.prototype.push.apply(fake, args as any);
  };

  const first = stash.sync();
  await assert.rejects(stash.sync(), SyncLockError);
  await first;
});

test("sync: snapshot.local writes text files and skips binary files", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    {
      "text.md": "hello",
      "img.bin": Buffer.from([0xff, 0xfe, 0x00]),
    },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });
  await stash.sync();

  assert.equal(
    await readFile(join(dir, ".stash", "snapshot.local", "text.md"), "utf8"),
    "hello",
  );
  assert.equal(existsSync(join(dir, ".stash", "snapshot.local", "img.bin")), false);
});

test("sync: deleting a file removes it from snapshot.local", async () => {
  const fake = new FakeProvider();
  const { stash, dir } = await makeStash(
    { "hello.md": "hello" },
    { providers: fakeRegistry(fake) },
  );
  await stash.connect("fake", { repo: "r" });
  await stash.sync();
  assert.equal(existsSync(join(dir, ".stash", "snapshot.local", "hello.md")), true);

  await unlink(join(dir, "hello.md"));
  await stash.sync();
  assert.equal(existsSync(join(dir, ".stash", "snapshot.local", "hello.md")), false);
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
  await stash.connect("fake", { repo: "r" });

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
