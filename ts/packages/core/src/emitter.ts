export type Unsubscribe = () => void;

/**
 * A minimal event emitter: the TypeScript counterpart of a Dart broadcast
 * stream. Listeners run synchronously in subscription order; one throwing does
 * not stop the others.
 */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error("[entanglement] listener failed", error);
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
