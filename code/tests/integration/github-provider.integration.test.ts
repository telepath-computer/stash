import test from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../../src/providers/github-provider.ts";
import type { PushPayload } from "../../src/types.ts";
import { MockGitHubAPI } from "../helpers/mock-github-api.ts";

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function makeProvider(): GitHubProvider {
  return new GitHubProvider({ token: "test-token", repo: "user/repo" });
}

test("github integration: fetch then push carries head/tree state", async () => {
  const requests: Array<{ stage: string; body: any }> = [];
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo", { status: 200, body: { id: 1 } })
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head123", commit: { tree: { sha: "tree123" } } } },
    })
    .on("GET", "/repos/user/repo/contents/.stash/snapshot.json?ref=main", {
      status: 200,
      body: { content: b64(JSON.stringify({})) },
    })
    .onRequest("POST", "/repos/user/repo/git/trees", ({ body }) => {
      requests.push({ stage: "tree", body });
      return { status: 201, body: { sha: "tree456" } };
    })
    .onRequest("POST", "/repos/user/repo/git/commits", ({ body }) => {
      requests.push({ stage: "commit", body });
      return { status: 201, body: { sha: "commit456" } };
    })
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", {
      status: 200,
      body: {},
    })
    .install();

  try {
    const provider = makeProvider();
    await provider.fetch({});
    await provider.push({
      files: new Map([["hello.md", "hello"]]),
      deletions: [],
      snapshot: { "hello.md": { hash: "sha256-hello" } },
    });

    const treeBody = requests.find((entry) => entry.stage === "tree")?.body;
    const commitBody = requests.find((entry) => entry.stage === "commit")?.body;
    assert.equal(treeBody.base_tree, "tree123");
    assert.deepEqual(commitBody.parents, ["head123"]);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("github integration: full fetch to push realistic walkthrough", async () => {
  const localSnapshot = {
    "hello.md": { hash: "sha256-hello-world" },
    "image.png": { hash: "sha256-image", modified: 1709121600000 },
  };
  const remoteSnapshot = {
    "hello.md": { hash: "sha256-hello-world!" },
    "image.png": { hash: "sha256-image", modified: 1709121600000 },
    "photo.jpg": { hash: "sha256-photo", modified: 1709290800000 },
  };

  const requests: Array<{ stage: string; body: any }> = [];
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo", { status: 200, body: { id: 1 } })
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "abc123", commit: { tree: { sha: "def456" } } } },
    })
    .on("GET", "/repos/user/repo/contents/.stash/snapshot.json?ref=main", {
      status: 200,
      body: { content: b64(JSON.stringify(remoteSnapshot)) },
    })
    .onPost("/graphql", () => ({
      status: 200,
      body: {
        data: {
          repository: {
            f0: { text: "hello world!", isBinary: false },
          },
        },
      },
    }))
    .onRequest("POST", "/repos/user/repo/git/trees", ({ body }) => {
      requests.push({ stage: "tree", body });
      return { status: 201, body: { sha: "tree789" } };
    })
    .onRequest("POST", "/repos/user/repo/git/commits", ({ body }) => {
      requests.push({ stage: "commit", body });
      return { status: 201, body: { sha: "commit012" } };
    })
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", {
      status: 200,
      body: {},
    })
    .install();

  try {
    const provider = makeProvider();
    const remoteChangeSet = await provider.fetch(localSnapshot);
    assert.equal(remoteChangeSet.modified.get("hello.md")?.type, "text");
    assert.equal(remoteChangeSet.added.get("photo.jpg")?.type, "binary");
    assert.deepEqual(remoteChangeSet.deleted, []);

    const payload: PushPayload = {
      files: new Map([
        ["hello.md", "hello brave world!"],
        ["new.md", "draft"],
      ]),
      deletions: ["image.png"],
      snapshot: {
        "hello.md": { hash: "sha256-merged" },
        "new.md": { hash: "sha256-draft" },
        "photo.jpg": { hash: "sha256-photo", modified: 1709290800000 },
      },
    };
    await provider.push(payload);

    const treeBody = requests.find((entry) => entry.stage === "tree")?.body;
    const commitBody = requests.find((entry) => entry.stage === "commit")?.body;
    assert.equal(treeBody.base_tree, "def456");
    assert.equal(
      treeBody.tree.some((entry: any) => entry.path === ".stash/snapshot.json"),
      true,
    );
    assert.deepEqual(commitBody.parents, ["abc123"]);
    api.assertDone();
  } finally {
    cleanup();
  }
});
