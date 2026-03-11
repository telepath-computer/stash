import { Readable } from "node:stream";
import { PushConflictError } from "../errors.ts";
import type {
  ChangeSet,
  FileState,
  Provider,
  ProviderSpec,
  PushPayload,
  SnapshotEntry,
} from "../types.ts";
import { hashBuffer } from "../utils/hash.ts";
import { isValidText } from "../utils/text.ts";

const REST_BASE = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 403 &&
    response.headers.get("x-ratelimit-remaining") === "0"
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface GitHubConfig {
  token: string;
  repo: string;
}

type BlobResult = { isBinary: boolean; text: string | null } | null;

export class GitHubProvider implements Provider {
  static spec: ProviderSpec = {
    setup: [{ name: "token", label: "Personal access token", secret: true }],
    connect: [{ name: "repo", label: "Repository (user/repo)" }],
  };

  private readonly token: string;
  private readonly owner: string;
  private readonly name: string;
  private headSha: string | undefined;
  private baseTreeSha: string | undefined;

  constructor(config: GitHubConfig) {
    if (!config.token) {
      throw new Error("Missing GitHub token");
    }
    const repoParts = config.repo.split("/");
    if (
      !config.repo ||
      repoParts.length !== 2 ||
      repoParts[0].length === 0 ||
      repoParts[1].length === 0
    ) {
      throw new Error("Invalid GitHub repo. Expected format: owner/repo");
    }

    const [owner, repo] = repoParts;
    this.token = config.token;
    this.owner = owner;
    this.name = repo;
  }

  async fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet> {
    const branchRes = await this.rest("GET", this.repoPath("/branches/main"));
    if (branchRes.status === 404) {
      this.headSha = undefined;
      this.baseTreeSha = undefined;
      return { added: new Map(), modified: new Map(), deleted: [] };
    }

    await this.ensureOk(branchRes, "Failed to load main branch");
    const branch = await branchRes.json();
    this.headSha = branch.commit.sha as string;
    this.baseTreeSha = branch.commit.commit.tree.sha as string;

    let remoteSnapshot: Record<string, SnapshotEntry> | null = null;
    const snapshotRes = await this.rest(
      "GET",
      this.repoPath("/contents/.stash/snapshot.json?ref=main"),
    );
    if (snapshotRes.status === 404) {
      remoteSnapshot = null;
    } else {
      await this.ensureOk(snapshotRes, "Failed to fetch remote snapshot");
      const body = await snapshotRes.json();
      const content = Buffer.from((body.content as string).replace(/\n/g, ""), "base64").toString(
        "utf8",
      );
      remoteSnapshot = JSON.parse(content) as Record<string, SnapshotEntry>;
    }

    const addedPaths = new Set<string>();
    const modifiedPaths: string[] = [];
    const deleted: string[] = [];

    if (remoteSnapshot) {
      const remotePaths = new Set(Object.keys(remoteSnapshot));
      if (!localSnapshot) {
        for (const path of remotePaths) {
          addedPaths.add(path);
        }
      } else {
        const localPaths = new Set(Object.keys(localSnapshot));
        for (const path of remotePaths) {
          if (!localPaths.has(path)) {
            addedPaths.add(path);
            continue;
          }
          if (remoteSnapshot[path].hash !== localSnapshot[path].hash) {
            modifiedPaths.push(path);
          }
        }
        for (const path of localPaths) {
          if (!remotePaths.has(path)) {
            deleted.push(path);
          }
        }
      }
    } else {
      if (!this.baseTreeSha) {
        return { added: new Map(), modified: new Map(), deleted: [] };
      }
      const treeRes = await this.rest(
        "GET",
        this.repoPath(`/git/trees/${this.baseTreeSha}?recursive=1`),
      );
      await this.ensureOk(treeRes, "Failed to fetch repository tree");
      const tree = await treeRes.json();
      const remotePaths = new Set<string>();
      for (const entry of (tree.tree as Array<{ path: string; type: string }>) ?? []) {
        if (entry.type !== "blob") {
          continue;
        }
        if (entry.path.startsWith(".stash/")) {
          continue;
        }
        remotePaths.add(entry.path);
      }
      for (const path of remotePaths) {
        addedPaths.add(path);
      }
      if (localSnapshot) {
        for (const localPath of Object.keys(localSnapshot)) {
          if (!remotePaths.has(localPath)) {
            deleted.push(localPath);
          }
        }
      }
    }

    const added = new Map<string, FileState>();
    const modified = new Map<string, FileState>();
    const needsQuery: string[] = [];

    for (const path of [...addedPaths, ...modifiedPaths]) {
      if (!remoteSnapshot) {
        needsQuery.push(path);
        continue;
      }

      const entry = remoteSnapshot[path];
      if ("modified" in entry) {
        const state = {
          type: "binary" as const,
          hash: entry.hash,
          modified: entry.modified,
        };
        if (addedPaths.has(path)) {
          added.set(path, state);
        } else {
          modified.set(path, state);
        }
        continue;
      }

      needsQuery.push(path);
    }

    const textOrBinary = await this.fetchBlobMetadata(needsQuery);
    for (const path of needsQuery) {
      const blob = textOrBinary.get(path);
      const snapshotEntry = remoteSnapshot?.[path];

      if (!blob || blob.isBinary || blob.text === null) {
        const raw = await this.fetchRawBytes(path);
        const hash = snapshotEntry?.hash ?? hashBuffer(raw);
        const modifiedAt =
          snapshotEntry && "modified" in snapshotEntry
            ? snapshotEntry.modified
            : Date.now();
        const state = { type: "binary" as const, hash, modified: modifiedAt };
        if (addedPaths.has(path)) {
          added.set(path, state);
        } else {
          modified.set(path, state);
        }
        continue;
      }

      const textBuffer = Buffer.from(blob.text, "utf8");
      if (!isValidText(textBuffer)) {
        const raw = await this.fetchRawBytes(path);
        const hash = snapshotEntry?.hash ?? hashBuffer(raw);
        const modifiedAt =
          snapshotEntry && "modified" in snapshotEntry
            ? snapshotEntry.modified
            : Date.now();
        const state = { type: "binary" as const, hash, modified: modifiedAt };
        if (addedPaths.has(path)) {
          added.set(path, state);
        } else {
          modified.set(path, state);
        }
      } else {
        const state = { type: "text" as const, content: blob.text };
        if (addedPaths.has(path)) {
          added.set(path, state);
        } else {
          modified.set(path, state);
        }
      }
    }

    deleted.sort();
    return { added, modified, deleted };
  }

  async get(path: string): Promise<Readable> {
    const bytes = await this.fetchRawBytes(path);
    return Readable.from(bytes);
  }

  async push(payload: PushPayload): Promise<void> {
    if (!this.headSha) {
      // GitHub Git Data API returns 409 on empty repos for both blob/tree creation,
      // so we bootstrap once via Contents API to create an initial commit.
      await this.bootstrapEmptyRepo(payload.snapshot);
    }

    const blobShas = new Map<string, string>();
    const binaryWrites = [...payload.files.entries()].filter(
      (entry): entry is [string, () => Readable] => typeof entry[1] !== "string",
    );

    await Promise.all(
      binaryWrites.map(async ([path, createStream]) => {
        const content = await streamToBuffer(createStream());
        const sha = await this.createBlob(content, `Failed to create blob for ${path}`);
        blobShas.set(path, sha);
      }),
    );

    const treeEntries: Array<Record<string, unknown>> = [];
    for (const [path, value] of payload.files) {
      if (typeof value === "string") {
        treeEntries.push({
          path,
          mode: "100644",
          type: "blob",
          content: value,
        });
      } else {
        treeEntries.push({
          path,
          mode: "100644",
          type: "blob",
          sha: blobShas.get(path),
        });
      }
    }

    treeEntries.push({
      path: ".stash/snapshot.json",
      mode: "100644",
      type: "blob",
      content: JSON.stringify(payload.snapshot),
    });

    for (const path of payload.deletions) {
      treeEntries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    const treeBody: Record<string, unknown> = { tree: treeEntries };
    if (this.baseTreeSha) {
      treeBody.base_tree = this.baseTreeSha;
    }

    const treeRes = await this.rest("POST", this.repoPath("/git/trees"), treeBody);
    await this.ensureOk(treeRes, "Failed to create tree");
    const tree = await treeRes.json();
    const treeSha = tree.sha as string;

    const commitBody: Record<string, unknown> = {
      message: "stash: sync",
      tree: treeSha,
    };
    if (this.headSha) {
      commitBody.parents = [this.headSha];
    }

    const commitRes = await this.rest(
      "POST",
      this.repoPath("/git/commits"),
      commitBody,
    );
    await this.ensureOk(commitRes, "Failed to create commit");
    const commit = await commitRes.json();
    const commitSha = commit.sha as string;

    if (this.headSha) {
      const refRes = await this.rest(
        "PATCH",
        this.repoPath("/git/refs/heads/main"),
        { sha: commitSha, force: false },
      );
      if (refRes.status === 422) {
        throw new PushConflictError("Remote main moved during push");
      }
      await this.ensureOk(refRes, "Failed to update main ref");
    } else {
      const refCreate = await this.rest(
        "POST",
        this.repoPath("/git/refs"),
        { ref: "refs/heads/main", sha: commitSha },
      );
      await this.ensureOk(refCreate, "Failed to create main ref");
    }

    this.headSha = commitSha;
    this.baseTreeSha = treeSha;
  }

  private repoPath(path: string): string {
    return `/repos/${this.owner}/${this.name}${path}`;
  }

  private async bootstrapEmptyRepo(
    snapshot: Record<string, SnapshotEntry>,
  ): Promise<void> {
    const bootstrapRes = await this.rest(
      "PUT",
      this.repoPath(`/contents/${encodePath(".stash/snapshot.json")}`),
      {
        message: "stash: bootstrap",
        content: Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64"),
        branch: "main",
      },
    );
    await this.ensureOk(bootstrapRes, "Failed to bootstrap empty repository");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const branchRes = await this.rest("GET", this.repoPath("/branches/main"));
      if (branchRes.status === 404) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      await this.ensureOk(branchRes, "Failed to load main branch after bootstrap");
      const branch = await branchRes.json();
      this.headSha = branch.commit.sha as string;
      this.baseTreeSha = branch.commit.commit.tree.sha as string;
      return;
    }

    throw new Error("Failed to load main branch after bootstrap (404)");
  }

  private async rest(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const response = await fetch(`${REST_BASE}${path}`, {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "stash",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (isRateLimited(response)) {
      const resetAt = response.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub API rate limit exceeded. Reset at: ${
          resetAt ? new Date(Number(resetAt) * 1000).toISOString() : "unknown"
        }`,
      );
    }
    if (response.status === 401) {
      throw new Error("GitHub authentication failed. Check your token.");
    }

    return response;
  }

  private async ensureOk(response: Response, message: string): Promise<void> {
    if (response.ok) {
      return;
    }
    const text = await response.text();
    throw new Error(`${message} (${response.status}): ${text}`);
  }

  private async fetchBlobMetadata(paths: string[]): Promise<Map<string, BlobResult>> {
    const results = new Map<string, BlobResult>();
    if (paths.length === 0) {
      return results;
    }

    const aliases = new Map<string, string>();
    const fields = paths
      .map((path, index) => {
        const alias = `f${index}`;
        aliases.set(alias, path);
        return `${alias}: object(expression: ${JSON.stringify(`main:${path}`)}) { ... on Blob { text isBinary } }`;
      })
      .join("\n");

    const query = `query {\n  repository(owner: ${JSON.stringify(this.owner)}, name: ${JSON.stringify(
      this.name,
    )}) {\n    ${fields}\n  }\n}`;

    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `bearer ${this.token}`,
        Accept: "application/json",
        "User-Agent": "stash",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (isRateLimited(response)) {
      const resetAt = response.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub GraphQL rate limit exceeded. Reset at: ${
          resetAt ? new Date(Number(resetAt) * 1000).toISOString() : "unknown"
        }`,
      );
    }
    if (response.status === 401) {
      throw new Error("GitHub authentication failed. Check your token.");
    }

    await this.ensureOk(response, "Failed to fetch GraphQL blobs");
    const payload = await response.json();
    const repository = payload.data?.repository ?? {};
    for (const [alias, path] of aliases) {
      results.set(path, (repository[alias] ?? null) as BlobResult);
    }
    return results;
  }

  private async fetchRawBytes(path: string): Promise<Buffer> {
    const response = await this.rest(
      "GET",
      this.repoPath(`/contents/${encodePath(path)}?ref=main`),
      undefined,
      { Accept: "application/vnd.github.raw+json" },
    );
    await this.ensureOk(response, `Failed to fetch raw content for ${path}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async createBlob(content: Buffer, errorMessage: string): Promise<string> {
    const blobRes = await this.rest("POST", this.repoPath("/git/blobs"), {
      content: content.toString("base64"),
      encoding: "base64",
    });
    await this.ensureOk(blobRes, errorMessage);
    const blob = await blobRes.json();
    return blob.sha as string;
  }
}
