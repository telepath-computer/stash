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

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}
