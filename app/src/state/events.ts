type Listener = () => void;

const listeners = new Set<Listener>();

/** Fired after any write; screens re-run their queries. */
export function emitChange(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

export function onChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
