export type JobEvent =
  | { type: "hello" }
  | { type: "jobs" }
  | { type: "job"; jobId: number }
  | { type: "log"; jobId: number };

type Listener = (event: JobEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: JobEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      // One broken subscriber must not block the others, but it stays visible.
      console.warn(`events: subscriber failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
