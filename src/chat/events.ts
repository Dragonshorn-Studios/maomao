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
  private readonly seen = new Set<string>();
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
      const key = `${event.part.id ?? ""}:${event.part.text}`;
      // The same text part can be re-emitted; dedupe by part id + content so
      // the transcript never doubles a paragraph.
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.textParts.push(event.part.text);
    }
  }
}
