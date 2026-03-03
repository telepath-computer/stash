import mitt, { type Emitter as MittEmitter } from 'mitt';

export interface Disposable {
  dispose(): void;
}

/**
 * Typed event emitter with disposable subscriptions.
 * From: alpha/packages/utils/shared/emitter.ts
 */
export class Emitter<T extends Record<string, any>> {
  private emitter: MittEmitter<T> = mitt<T>();

  readonly on = <K extends keyof T | '*'>(
    type: K,
    handler: (event: T[K]) => void
  ): Disposable => {
    this.emitter.on(type, handler);
    return { dispose: () => this.emitter.off(type, handler) };
  };

  readonly once = <K extends keyof T | '*'>(
    type: K,
    handler: (event: T[K]) => void
  ): Disposable => {
    const wrappedHandler = (event: T[K]) => {
      handler(event);
      this.emitter.off(type, wrappedHandler);
    };

    this.emitter.on(type, wrappedHandler);
    return { dispose: () => this.emitter.off(type, wrappedHandler) };
  };

  readonly off = this.emitter.off;

  protected emit<K extends keyof T>(
    type: K,
    ...[event]: T[K] extends undefined ? [] : [T[K]]
  ): void {
    this.emitter.emit(type, event as T[K]);
  }
}
