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
    message = "git repository detected — run `stash config set allow-git true` to allow syncing",
  ) {
    super(message);
    this.name = "GitRepoError";
  }
}

export class MultipleConnectionsError extends Error {
  constructor(
    message = "multiple connections are not yet supported — disconnect the existing connection before adding a new one",
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
