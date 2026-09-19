/**
 * Streaming NDJSON extractor for `opencode run --format json`. Feed raw
 * stdout chunks; receive the session id (from step_start) and assistant
 * text parts as they arrive. The buffer holds partial lines between chunks.
 */
export interface ExplainerEvents {
  sessionId?: string;
  textParts: string[];
}

export class ExplainerEventParser {
  private buffer = "";
  /** Part id -> index into textParts, for last-write-wins part updates. */
  private readonly partIndex = new Map<string, number>();
  private anonymousParts = 0;
  sessionId: string | undefined;
  textParts: string[] = [];

  feed(chunk: string): ExplainerEvents {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
    return { sessionId: this.sessionId, textParts: this.textParts };
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("{")) return;
    let event: { type?: string; sessionID?: string; part?: { id?: string; type?: string; text?: string } };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    // First session wins: a conversation is bound to one opencode session.
    if (event.type === "step_start" && event.sessionID && this.sessionId === undefined) {
      this.sessionId = event.sessionID;
    }
    if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.length > 0) {
      // A part can be re-emitted with grown text (provider-side streaming);
      // the newest emission of an id replaces its earlier snapshot, while
      // anonymous parts append (nothing to key them on but order).
      const id = event.part.id;
      if (id != null && this.partIndex.has(id)) {
        this.textParts[this.partIndex.get(id)!] = event.part.text;
        return;
      }
      if (id != null) this.partIndex.set(id, this.textParts.length);
      else this.anonymousParts += 1;
      this.textParts.push(event.part.text);
    }
  }
}
