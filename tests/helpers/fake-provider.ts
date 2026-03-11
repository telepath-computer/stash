import { Readable } from "node:stream";
import type { Readable as NodeReadable } from "node:stream";
import { PushConflictError } from "../../src/errors.ts";
import type {
  ChangeSet,
  Provider,
  PushPayload,
  SnapshotEntry,
} from "../../src/types.ts";

function cloneSnapshot(
  snapshot: Record<string, SnapshotEntry>,
): Record<string, SnapshotEntry> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, SnapshotEntry>;
}

async function streamToBuffer(stream: NodeReadable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class FakeProvider implements Provider {
  readonly files = new Map<string, string | Buffer>();
  snapshot: Record<string, SnapshotEntry>;
  readonly pushLog: PushPayload[] = [];
  failNextPush = false;
  alwaysConflict = false;
  fetchCalls = 0;
  pushCalls = 0;
  getCalls = 0;

  constructor(opts?: {
    files?: Record<string, string | Buffer>;
    snapshot?: Record<string, SnapshotEntry>;
  }) {
    for (const [path, value] of Object.entries(opts?.files ?? {})) {
      this.files.set(path, value);
    }
    this.snapshot = cloneSnapshot(opts?.snapshot ?? {});
  }

  async fetch(
    localSnapshot?: Record<string, SnapshotEntry>,
  ): Promise<ChangeSet> {
    this.fetchCalls += 1;
    const added = new Map();
    const modified = new Map();
    const deleted: string[] = [];

    const remotePaths = new Set(Object.keys(this.snapshot));
    const localPaths = new Set(Object.keys(localSnapshot ?? {}));

    const changedAdded = localSnapshot
      ? [...remotePaths].filter((p) => !localPaths.has(p))
      : [...remotePaths];
    const changedModified = localSnapshot
      ? [...remotePaths].filter(
          (p) => localPaths.has(p) && this.snapshot[p].hash !== localSnapshot[p].hash,
        )
      : [];

    for (const path of changedAdded) {
      const entry = this.snapshot[path];
      if ("modified" in entry) {
        added.set(path, {
          type: "binary",
          hash: entry.hash,
          modified: entry.modified,
        });
        continue;
      }
      const file = this.files.get(path);
      if (typeof file !== "string") {
        throw new Error(`Missing text content for path: ${path}`);
      }
      added.set(path, { type: "text", content: file });
    }

    for (const path of changedModified) {
      const entry = this.snapshot[path];
      if ("modified" in entry) {
        modified.set(path, {
          type: "binary",
          hash: entry.hash,
          modified: entry.modified,
        });
        continue;
      }
      const file = this.files.get(path);
      if (typeof file !== "string") {
        throw new Error(`Missing text content for path: ${path}`);
      }
      modified.set(path, { type: "text", content: file });
    }

    if (localSnapshot) {
      for (const path of localPaths) {
        if (!remotePaths.has(path)) {
          deleted.push(path);
        }
      }
    }

    return { added, modified, deleted };
  }

  async get(path: string): Promise<NodeReadable> {
    this.getCalls += 1;
    const file = this.files.get(path);
    if (file === undefined) {
      throw new Error(`Remote path not found: ${path}`);
    }
    if (typeof file === "string") {
      return Readable.from(Buffer.from(file, "utf8"));
    }
    return Readable.from(file);
  }

  async push(payload: PushPayload): Promise<void> {
    this.pushCalls += 1;
    if (this.alwaysConflict || this.failNextPush) {
      this.failNextPush = false;
      throw new PushConflictError("simulated conflict");
    }

    this.pushLog.push({
      files: new Map(payload.files),
      deletions: [...payload.deletions],
      snapshot: cloneSnapshot(payload.snapshot),
    });

    for (const [path, value] of payload.files) {
      if (typeof value === "string") {
        this.files.set(path, value);
        continue;
      }
      const buf = await streamToBuffer(value());
      this.files.set(path, buf);
    }

    for (const path of payload.deletions) {
      this.files.delete(path);
    }

    this.snapshot = cloneSnapshot(payload.snapshot);
  }
}
