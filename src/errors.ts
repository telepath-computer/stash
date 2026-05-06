export class PushConflictError extends Error {
  constructor(message = "push conflict") {
    super(message);
    this.name = "PushConflictError";
  }
}

export class SyncLockError extends Error {
  constructor(message = "sync already in progress") {
    super(message);
    this.name = "SyncLockError";
  }
}

export class GitRepoError extends Error {
  constructor(
    message = "git repository detected — pass `--dangerously-allow-git` when connecting or relinking this folder",
  ) {
    super(message);
    this.name = "GitRepoError";
  }
}

export class MultipleConnectionsError extends Error {
  constructor(
    message = "Only one connection per stash — disconnect the existing connection before adding another (or fix the stash.json metadata if it lists more than one).",
  ) {
    super(message);
    this.name = "MultipleConnectionsError";
  }
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export class InvalidUriError extends Error {
  constructor(uri: string, reason = "expected <provider>:<id>") {
    super(`Invalid URI: ${uri} (${reason})`);
    this.name = "InvalidUriError";
  }
}
