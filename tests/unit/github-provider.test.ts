import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { PushConflictError } from "../../src/errors.ts";
import { GitHubProvider } from "../../src/providers/github-provider.ts";
import type { PushPayload } from "../../src/types.ts";
import { MockGitHubAPI } from "../helpers/mock-github-api.ts";

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function makeProvider(): GitHubProvider {
  return new GitHubProvider({ token: "test-token", repo: "user/repo" });
}

test("GitHubProvider constructor validates owner/repo format", () => {
  assert.throws(() => new GitHubProvider({ token: "t", repo: "a/b/c" }), /owner\/repo/i);
});

test("GitHubProvider.fetch: empty repo returns empty changeset", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", { status: 404, body: { message: "Not Found" } })
    .install();

  try {
    const provider = makeProvider();
    const changeSet = await provider.fetch({});
    assert.equal(changeSet.added.size, 0);
    assert.equal(changeSet.modified.size, 0);
    assert.deepEqual(changeSet.deleted, []);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.fetch: diffs remote snapshot and fetches changed text", async () => {
  const remoteSnapshot = {
    "hello.md": { hash: "sha256-new" },
    "image.png": { hash: "sha256-image", modified: 42 },
  };
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
    })
    .on("GET", "/repos/user/repo/contents/.stash/snapshot.json?ref=main", {
      status: 200,
      body: { content: b64(JSON.stringify(remoteSnapshot)) },
    })
    .onPost("/graphql", (body) => {
      const query = (body as any)?.query as string;
      assert.equal(query.includes("hello.md"), true);
      return {
        status: 200,
        body: {
          data: {
            repository: {
              f0: { text: "hello from remote", isBinary: false },
            },
          },
        },
      };
    })
    .install();

  try {
    const provider = makeProvider();
    const localSnapshot = {
      "hello.md": { hash: "sha256-old" },
      "old.md": { hash: "sha256-old-file" },
    };
    const changeSet = await provider.fetch(localSnapshot);
    assert.equal(changeSet.modified.get("hello.md")?.type, "text");
    assert.equal((changeSet.modified.get("hello.md") as any)?.content, "hello from remote");
    assert.deepEqual(changeSet.deleted, ["old.md"]);
    assert.deepEqual(changeSet.added.get("image.png"), {
      type: "binary",
      hash: "sha256-image",
      modified: 42,
    });
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.fetch: no remote changes skips GraphQL", async () => {
  const snapshot = { "hello.md": { hash: "same" } };
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
    })
    .on("GET", "/repos/user/repo/contents/.stash/snapshot.json?ref=main", {
      status: 200,
      body: { content: b64(JSON.stringify(snapshot)) },
    })
    .install();

  try {
    const provider = makeProvider();
    const result = await provider.fetch(snapshot);
    assert.equal(result.added.size, 0);
    assert.equal(result.modified.size, 0);
    assert.deepEqual(result.deleted, []);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.fetch: first sync with no local snapshot returns all added", async () => {
  const remoteSnapshot = {
    "hello.md": { hash: "h1" },
    "image.bin": { hash: "h2", modified: 12 },
  };
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
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
            f0: { text: "hello", isBinary: false },
          },
        },
      },
    }))
    .install();

  try {
    const provider = makeProvider();
    const result = await provider.fetch(undefined);
    assert.deepEqual(result.added.get("hello.md"), { type: "text", content: "hello" });
    assert.deepEqual(result.added.get("image.bin"), {
      type: "binary",
      hash: "h2",
      modified: 12,
    });
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.fetch: no remote snapshot uses tree listing", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
    })
    .on("GET", "/repos/user/repo/contents/.stash/snapshot.json?ref=main", {
      status: 404,
      body: { message: "Not found" },
    })
    .on("GET", "/repos/user/repo/git/trees/tree?recursive=1", {
      status: 200,
      body: {
        tree: [
          { path: "readme.md", type: "blob" },
          { path: ".stash/config.local.json", type: "blob" },
          { path: ".stash/snapshot.json", type: "blob" },
          { path: "dir/note.md", type: "blob" },
        ],
      },
    })
    .onPost("/graphql", (body) => {
      const query = (body as any).query as string;
      assert.equal(query.includes("readme.md"), true);
      assert.equal(query.includes("dir/note.md"), true);
      assert.equal(query.includes(".stash"), false);
      return {
        status: 200,
        body: {
          data: {
            repository: {
              f0: { text: "readme", isBinary: false },
              f1: { text: "note", isBinary: false },
            },
          },
        },
      };
    })
    .install();

  try {
    const provider = makeProvider();
    const result = await provider.fetch({});
    assert.equal(result.added.get("readme.md")?.type, "text");
    assert.equal(result.added.get("dir/note.md")?.type, "text");
    assert.equal(result.added.has(".stash/config.local.json"), false);
    assert.equal(result.added.has(".stash/snapshot.json"), false);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.fetch: classification uses GraphQL isBinary=true", async () => {
  const remoteSnapshot = { "image.bin": { hash: "h1" } };
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
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
            f0: { text: null, isBinary: true },
          },
        },
      },
    }))
    .on("GET", "/repos/user/repo/contents/image.bin?ref=main", {
      status: 200,
      body: Buffer.from([1, 2, 3]),
    })
    .install();

  try {
    const provider = makeProvider();
    const result = await provider.fetch(undefined);
    assert.equal(result.added.get("image.bin")?.type, "binary");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.fetch: classification with invalid UTF-8 falls back to binary", async () => {
  const remoteSnapshot = { "latin1.txt": { hash: "h1" } };
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
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
            f0: { text: "bad\u0000text", isBinary: false },
          },
        },
      },
    }))
    .on("GET", "/repos/user/repo/contents/latin1.txt?ref=main", {
      status: 200,
      body: Buffer.from([0xe9]),
    })
    .install();

  try {
    const provider = makeProvider();
    const result = await provider.fetch(undefined);
    assert.equal(result.added.get("latin1.txt")?.type, "binary");
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.fetch: binary snapshot entry skips GraphQL content", async () => {
  const remoteSnapshot = {
    "bin.dat": { hash: "new", modified: 10 },
  };
  const localSnapshot = {
    "bin.dat": { hash: "old", modified: 9 },
  };
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
    })
    .on("GET", "/repos/user/repo/contents/.stash/snapshot.json?ref=main", {
      status: 200,
      body: { content: b64(JSON.stringify(remoteSnapshot)) },
    })
    .install();

  try {
    const provider = makeProvider();
    const result = await provider.fetch(localSnapshot);
    assert.deepEqual(result.modified.get("bin.dat"), {
      type: "binary",
      hash: "new",
      modified: 10,
    });
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.get: streams raw bytes", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/contents/file%20name.bin?ref=main", {
      status: 200,
      body: Buffer.from([1, 2, 3, 4]),
    })
    .install();

  try {
    const provider = makeProvider();
    const stream = await provider.get("file name.bin");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.get: sends auth header", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .onRequest("GET", "/repos/user/repo/contents/file.bin?ref=main", ({ headers }) => {
      assert.equal(headers.get("authorization"), "token test-token");
      return { status: 200, body: Buffer.from([7, 8, 9]) };
    })
    .install();

  try {
    const provider = makeProvider();
    const stream = await provider.get("file.bin");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([7, 8, 9]));
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.push: text-only push includes snapshot", async () => {
  const requests: Array<{ path: string; body: any }> = [];
  const api = new MockGitHubAPI();
  const cleanup = api
    .onPost("/repos/user/repo/git/trees", (body) => {
      requests.push({ path: "tree", body });
      return { status: 201, body: { sha: "tree-new" } };
    })
    .onPost("/repos/user/repo/git/commits", (body) => {
      requests.push({ path: "commit", body });
      return { status: 201, body: { sha: "commit-new" } };
    })
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", {
      status: 200,
      body: {},
    })
    .install();

  try {
    const provider = makeProvider();
    (provider as any).headSha = "head";
    (provider as any).baseTreeSha = "tree";

    const payload: PushPayload = {
      files: new Map([["hello.md", "hello"]]),
      deletions: ["old.md"],
      snapshot: { "hello.md": { hash: "sha256-hello" } },
    };

    await provider.push(payload);

    const treeReq = requests.find((req) => req.path === "tree");
    assert.ok(treeReq);
    assert.equal(treeReq.body.base_tree, "tree");
    assert.equal(
      treeReq.body.tree.some((entry: any) => entry.path === ".stash/snapshot.json"),
      true,
    );

    const commitReq = requests.find((req) => req.path === "commit");
    assert.ok(commitReq);
    assert.deepEqual(commitReq.body.parents, ["head"]);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.push: 422 ref update retries only when main actually moved", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .onPost("/repos/user/repo/git/trees", () => ({ status: 201, body: { sha: "tree-new" } }))
    .onPost("/repos/user/repo/git/commits", () => ({ status: 201, body: { sha: "commit-new" } }))
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", {
      status: 422,
      body: { message: "Reference update failed" },
    })
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head-moved", commit: { tree: { sha: "tree-moved" } } } },
    })
    .install();

  try {
    const provider = makeProvider();
    (provider as any).headSha = "head";
    (provider as any).baseTreeSha = "tree";
    await assert.rejects(
      provider.push({
        files: new Map([["hello.md", "hi"]]),
        deletions: [],
        snapshot: {},
      }),
      PushConflictError,
    );
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.push: 422 ref update with unchanged head surfaces concise error", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .onPost("/repos/user/repo/git/trees", () => ({ status: 201, body: { sha: "tree-new" } }))
    .onPost("/repos/user/repo/git/commits", () => ({ status: 201, body: { sha: "commit-new" } }))
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", {
      status: 422,
      body: { message: "Reference update failed" },
    })
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
    })
    .install();

  try {
    const provider = makeProvider();
    (provider as any).headSha = "head";
    (provider as any).baseTreeSha = "tree";
    await assert.rejects(
      provider.push({
        files: new Map([["hello.md", "hi"]]),
        deletions: [],
        snapshot: {},
      }),
      (error: unknown) => {
        assert.equal(error instanceof PushConflictError, false);
        assert.equal(error instanceof Error, true);
        assert.equal(
          (error as Error).message,
          "Remote ref update rejected by GitHub. This usually means your token cannot push to this repository or the branch is protected.",
        );
        return true;
      },
    );
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.push: binary content uses blob API", async () => {
  let blobCalled = false;
  const api = new MockGitHubAPI();
  const cleanup = api
    .onPost("/repos/user/repo/git/blobs", (body) => {
      blobCalled = true;
      assert.equal(typeof (body as any).content, "string");
      assert.equal((body as any).encoding, "base64");
      return { status: 201, body: { sha: "blobsha" } };
    })
    .onPost("/repos/user/repo/git/trees", () => ({ status: 201, body: { sha: "tree-new" } }))
    .onPost("/repos/user/repo/git/commits", () => ({ status: 201, body: { sha: "commit-new" } }))
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", {
      status: 200,
      body: {},
    })
    .install();

  try {
    const provider = makeProvider();
    (provider as any).headSha = "head";
    (provider as any).baseTreeSha = "tree";

    await provider.push({
      files: new Map([["image.png", () => Readable.from(Buffer.from([1, 2, 3]))]]),
      deletions: [],
      snapshot: { "image.png": { hash: "h", modified: 1 } },
    });
    assert.equal(blobCalled, true);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.push: multiple binaries create multiple blobs", async () => {
  let blobCalls = 0;
  const api = new MockGitHubAPI();
  const cleanup = api
    .onPost("/repos/user/repo/git/blobs", () => {
      blobCalls += 1;
      return { status: 201, body: { sha: `blob-${blobCalls}` } };
    })
    .onPost("/repos/user/repo/git/trees", () => ({ status: 201, body: { sha: "tree-new" } }))
    .onPost("/repos/user/repo/git/commits", () => ({ status: 201, body: { sha: "commit-new" } }))
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", { status: 200, body: {} })
    .install();

  try {
    const provider = makeProvider();
    (provider as any).headSha = "head";
    (provider as any).baseTreeSha = "tree";
    await provider.push({
      files: new Map([
        ["a.bin", () => Readable.from(Buffer.from([1]))],
        ["b.bin", () => Readable.from(Buffer.from([2]))],
        ["c.bin", () => Readable.from(Buffer.from([3]))],
      ]),
      deletions: [],
      snapshot: {
        "a.bin": { hash: "a", modified: 1 },
        "b.bin": { hash: "b", modified: 2 },
        "c.bin": { hash: "c", modified: 3 },
      },
    });
    assert.equal(blobCalls, 3);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.push: mixed text binary deletions", async () => {
  let treeBody: any;
  const api = new MockGitHubAPI();
  const cleanup = api
    .onPost("/repos/user/repo/git/blobs", () => ({ status: 201, body: { sha: "blob1" } }))
    .onRequest("POST", "/repos/user/repo/git/trees", ({ body }) => {
      treeBody = body;
      return { status: 201, body: { sha: "tree-new" } };
    })
    .onPost("/repos/user/repo/git/commits", () => ({ status: 201, body: { sha: "commit-new" } }))
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", { status: 200, body: {} })
    .install();

  try {
    const provider = makeProvider();
    (provider as any).headSha = "head";
    (provider as any).baseTreeSha = "tree";
    await provider.push({
      files: new Map([
        ["a.md", "hello"],
        ["b.bin", () => Readable.from(Buffer.from([1, 2]))],
      ]),
      deletions: ["old.md"],
      snapshot: { "a.md": { hash: "ha" }, "b.bin": { hash: "hb", modified: 1 } },
    });
    assert.equal(
      treeBody.tree.some((entry: any) => entry.path === "a.md" && entry.content === "hello"),
      true,
    );
    assert.equal(
      treeBody.tree.some((entry: any) => entry.path === "b.bin" && entry.sha === "blob1"),
      true,
    );
    assert.equal(
      treeBody.tree.some((entry: any) => entry.path === "old.md" && entry.sha === null),
      true,
    );
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider.push: empty repo bootstraps then pushes", async () => {
  const calls: string[] = [];
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("PUT", "/repos/user/repo/contents/.stash/snapshot.json", {
      status: 201,
      body: {},
    })
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head1", commit: { tree: { sha: "tree1" } } } },
    })
    .onRequest("POST", "/repos/user/repo/git/trees", ({ body }) => {
      calls.push(`tree:${body.base_tree ?? "none"}`);
      return { status: 201, body: { sha: "tree2" } };
    })
    .onRequest("POST", "/repos/user/repo/git/commits", ({ body }) => {
      calls.push(`commit:${Array.isArray(body.parents) ? "with-parent" : "no-parent"}`);
      return { status: 201, body: { sha: "commit2" } };
    })
    .on("PATCH", "/repos/user/repo/git/refs/heads/main", { status: 200, body: {} })
    .install();

  try {
    const provider = makeProvider();
    await provider.push({
      files: new Map([["hello.md", "hello"]]),
      deletions: [],
      snapshot: { "hello.md": { hash: "h" } },
    });
    assert.deepEqual(calls, ["tree:tree1", "commit:with-parent"]);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider errors: rate limit response includes reset time", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 403,
      body: { message: "rate limited" },
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "2000000000",
      },
    })
    .install();

  try {
    const provider = makeProvider();
    await assert.rejects(provider.fetch({}), /rate limit/i);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider errors: auth 401 throws descriptive error", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 401,
      body: { message: "bad credentials" },
    })
    .install();

  try {
    const provider = makeProvider();
    await assert.rejects(provider.fetch({}), /authentication failed/i);
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider errors: REST failures use concise status text", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/contents/file.bin?ref=main", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/html" },
      body: "<!DOCTYPE html><html><body>We have issues responding to your request</body></html>",
    })
    .install();

  try {
    const provider = makeProvider();
    await assert.rejects(provider.get("file.bin"), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = (error as Error).message;
      assert.equal(message, "Failed to fetch raw content for file.bin (503 Service Unavailable)");
      assert.equal(message.includes("<!DOCTYPE html>"), false);
      assert.equal(message.includes("We have issues responding to your request"), false);
      return true;
    });
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider errors: GraphQL failures use concise status text", async () => {
  const remoteSnapshot = {
    "hello.md": { hash: "sha256-new" },
  };
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/branches/main", {
      status: 200,
      body: { commit: { sha: "head", commit: { tree: { sha: "tree" } } } },
    })
    .on("GET", "/repos/user/repo/contents/.stash/snapshot.json?ref=main", {
      status: 200,
      body: { content: b64(JSON.stringify(remoteSnapshot)) },
    })
    .onPost("/graphql", () => ({
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/html" },
      body: "<!DOCTYPE html><html><body>We have issues responding to your request</body></html>",
    }))
    .install();

  try {
    const provider = makeProvider();
    await assert.rejects(
      provider.fetch({ "hello.md": { hash: "sha256-old" } }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const message = (error as Error).message;
        assert.equal(message, "Failed to fetch GraphQL blobs (503 Service Unavailable)");
        assert.equal(message.includes("<!DOCTYPE html>"), false);
        assert.equal(message.includes("We have issues responding to your request"), false);
        return true;
      },
    );
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider errors: empty statusText falls back to numeric code only", async () => {
  const api = new MockGitHubAPI();
  const cleanup = api
    .on("GET", "/repos/user/repo/contents/file.bin?ref=main", {
      status: 503,
      statusText: "",
      body: "<!DOCTYPE html><html><body>outage</body></html>",
    })
    .install();

  try {
    const provider = makeProvider();
    await assert.rejects(provider.get("file.bin"), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = (error as Error).message;
      assert.equal(message, "Failed to fetch raw content for file.bin (503)");
      assert.equal(message.includes("<!DOCTYPE html>"), false);
      return true;
    });
    api.assertDone();
  } finally {
    cleanup();
  }
});

test("GitHubProvider errors: network failure during fetch leaves state unset", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const provider = makeProvider();
    await assert.rejects(provider.fetch({}), /network down/i);
    assert.equal((provider as any).headSha, undefined);
    assert.equal((provider as any).baseTreeSha, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
