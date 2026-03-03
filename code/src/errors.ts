export class PushConflictError extends Error {
  constructor(message = "push conflict") {
    super(message);
    this.name = "PushConflictError";
  }
}
