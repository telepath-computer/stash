import test from "node:test";
import assert from "node:assert/strict";
import { makeChangeSet } from "../helpers/change-set.ts";
import { makeStash } from "../helpers/make-stash.ts";

test("reconcile: local modified, remote unchanged", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).reconcile(
    makeChangeSet({ modified: { "a.md": { type: "text", content: "new" } } }),
    makeChangeSet({}),
  );
  assert.deepEqual(result, [
    { path: "a.md", disk: "skip", remote: "write", content: "new" },
  ]);
});

test("reconcile: remote modified, local unchanged", async () => {
  const { stash } = await makeStash();
  const result = (stash as any).reconcile(
    makeChangeSet({}),
    makeChangeSet({ modified: { "a.md": { type: "text", content: "new" } } }),
  );
  assert.deepEqual(result, [
    { path: "a.md", disk: "write", remote: "skip", content: "new" },
  ]);
});

test("reconcile: both modified text merges with snapshot.local base", async () => {
  const { stash } = await makeStash(
    {},
    { snapshotLocal: { "a.md": "hello world" } },
  );
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({ modified: { "a.md": { type: "text", content: "hello brave world" } } }),
    makeChangeSet({ modified: { "a.md": { type: "text", content: "hello cruel world" } } }),
  );
  assert.equal(mutation.path, "a.md");
  assert.equal(mutation.disk, "write");
  assert.equal(mutation.remote, "write");
  assert.equal(mutation.content.includes("brave"), true);
  assert.equal(mutation.content.includes("cruel"), true);
});

test("reconcile: both modified binary uses last-modified wins", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({
      modified: {
        "img.png": { type: "binary", hash: "local", modified: 1_000 },
      },
    }),
    makeChangeSet({
      modified: {
        "img.png": { type: "binary", hash: "remote", modified: 2_000 },
      },
    }),
  );
  assert.deepEqual(mutation, {
    path: "img.png",
    disk: "write",
    remote: "write",
    source: "remote",
    hash: "remote",
    modified: 2_000,
  });
});

test("reconcile: both modified binary local wins on newer mtime", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({
      modified: {
        "img.png": { type: "binary", hash: "local", modified: 3_000 },
      },
    }),
    makeChangeSet({
      modified: {
        "img.png": { type: "binary", hash: "remote", modified: 2_000 },
      },
    }),
  );
  assert.deepEqual(mutation, {
    path: "img.png",
    disk: "write",
    remote: "write",
    source: "local",
    hash: "local",
    modified: 3_000,
  });
});

test("reconcile: local added remote absent writes to remote only", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({ added: { "new.md": { type: "text", content: "draft" } } }),
    makeChangeSet({}),
  );
  assert.deepEqual(mutation, {
    path: "new.md",
    disk: "skip",
    remote: "write",
    content: "draft",
  });
});

test("reconcile: remote added local absent writes to disk only", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({}),
    makeChangeSet({ added: { "new.md": { type: "text", content: "draft" } } }),
  );
  assert.deepEqual(mutation, {
    path: "new.md",
    disk: "write",
    remote: "skip",
    content: "draft",
  });
});

test("reconcile: both added text merges", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({ added: { "notes.md": { type: "text", content: "from A" } } }),
    makeChangeSet({ added: { "notes.md": { type: "text", content: "from B" } } }),
  );
  assert.equal(mutation.disk, "write");
  assert.equal(mutation.remote, "write");
  assert.equal(mutation.content, "from B");
});

test("reconcile: both added binary uses last-modified wins", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({
      added: {
        "img.png": { type: "binary", hash: "aaa", modified: 1_000 },
      },
    }),
    makeChangeSet({
      added: {
        "img.png": { type: "binary", hash: "bbb", modified: 2_000 },
      },
    }),
  );
  assert.deepEqual(mutation, {
    path: "img.png",
    disk: "write",
    remote: "write",
    source: "remote",
    hash: "bbb",
    modified: 2_000,
  });
});

test("reconcile: local deleted remote absent deletes on remote", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({ deleted: ["old.md"] }),
    makeChangeSet({}),
  );
  assert.deepEqual(mutation, {
    path: "old.md",
    disk: "skip",
    remote: "delete",
  });
});

test("reconcile: remote deleted local absent deletes on disk", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({}),
    makeChangeSet({ deleted: ["old.md"] }),
  );
  assert.deepEqual(mutation, {
    path: "old.md",
    disk: "delete",
    remote: "skip",
  });
});

test("reconcile: local deleted + remote modified keeps content", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({ deleted: ["a.md"] }),
    makeChangeSet({ modified: { "a.md": { type: "text", content: "saved" } } }),
  );
  assert.deepEqual(mutation, {
    path: "a.md",
    disk: "write",
    remote: "skip",
    content: "saved",
  });
});

test("reconcile: local modified + remote deleted keeps local content", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({ modified: { "a.md": { type: "text", content: "saved" } } }),
    makeChangeSet({ deleted: ["a.md"] }),
  );
  assert.deepEqual(mutation, {
    path: "a.md",
    disk: "skip",
    remote: "write",
    content: "saved",
  });
});

test("reconcile: both deleted becomes skip/skip", async () => {
  const { stash } = await makeStash();
  const [mutation] = (stash as any).reconcile(
    makeChangeSet({ deleted: ["a.md"] }),
    makeChangeSet({ deleted: ["a.md"] }),
  );
  assert.deepEqual(mutation, {
    path: "a.md",
    disk: "skip",
    remote: "skip",
  });
});
