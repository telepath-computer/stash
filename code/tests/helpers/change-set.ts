import type { ChangeSet, FileState } from "../../src/types.ts";

export function makeChangeSet(desc: {
  added?: Record<string, FileState>;
  modified?: Record<string, FileState>;
  deleted?: string[];
}): ChangeSet {
  return {
    added: new Map(Object.entries(desc.added ?? {})),
    modified: new Map(Object.entries(desc.modified ?? {})),
    deleted: [...(desc.deleted ?? [])],
  };
}
