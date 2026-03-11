import type { Readable } from "node:stream";

export interface ProviderSpec {
  setup: Field[];
  connect: Field[];
}

export interface Field {
  name: string;
  label: string;
  secret?: boolean;
}

export type SnapshotEntry =
  | { hash: string }
  | { hash: string; modified: number };

export type FileState =
  | { type: "text"; content: string }
  | { type: "binary"; hash: string; modified: number };

export interface ChangeSet {
  added: Map<string, FileState>;
  modified: Map<string, FileState>;
  deleted: string[];
}

export interface FileMutation {
  path: string;
  disk: "write" | "delete" | "skip";
  remote: "write" | "delete" | "skip";
  content?: string;
  source?: "local" | "remote";
  hash?: string;
  modified?: number;
}

export interface PushPayload {
  files: Map<string, string | (() => Readable)>;
  deletions: string[];
  snapshot: Record<string, SnapshotEntry>;
}

export interface Provider {
  fetch(localSnapshot?: Record<string, SnapshotEntry>): Promise<ChangeSet>;
  get(path: string): Promise<Readable>;
  push(payload: PushPayload): Promise<void>;
}

export interface StatusResult {
  added: string[];
  modified: string[];
  deleted: string[];
  lastSync: Date | null;
}

export type ConnectionConfig = Record<string, string>;
export type GlobalConfig = Record<string, Record<string, string>>;

export type ProviderClass = {
  spec: ProviderSpec;
  new (config: Record<string, string>): Provider;
};
