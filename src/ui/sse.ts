/**
 * Minimal SSE reader for the chat island: yields the JSON payload of every
 * `data: ` frame. Kept dependency-free (Node and browser globals only) so
 * the island bundle and the tests share one implementation.
 */
export async function* sseDataEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            yield JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch (error) {
            console.warn("chat: malformed SSE event skipped", error instanceof Error ? error.message : error);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
