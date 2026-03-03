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
