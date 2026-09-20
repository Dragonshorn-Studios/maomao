/**
 * Streaming NDJSON extractor for `opencode run --format json`. Feed raw
 * stdout chunks; receive the session id (from step_start), assistant text,
 * reasoning/thinking, and tool-call status as they arrive. The buffer holds
 * partial lines between chunks. Tool args and outputs are ignored so they
 * never reach the browser.
 */
export interface ExplainerToolStatus {
  id: string;
  name: string;
  status: string;
}

export interface ExplainerEvents {
  sessionId?: string;
  textParts: string[];
  reasoningParts: string[];
  tools: ExplainerToolStatus[];
}

export class ExplainerEventParser {
  private buffer = "";
  /** Part id -> index into textParts, for last-write-wins part updates. */
  private readonly partIndex = new Map<string, number>();
  private readonly reasoningIndex = new Map<string, number>();
  private readonly toolIndex = new Map<string, number>();
  private anonymousParts = 0;
  sessionId: string | undefined;
  textParts: string[] = [];
  reasoningParts: string[] = [];
  tools: ExplainerToolStatus[] = [];

  feed(chunk: string): ExplainerEvents {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
    return {
      sessionId: this.sessionId,
      textParts: this.textParts,
      reasoningParts: this.reasoningParts,
      tools: this.tools,
    };
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("{")) return;
    let event: {
      type?: string;
      sessionID?: string;
      part?: {
        id?: string;
        type?: string;
        text?: string;
        tool?: string;
        name?: string;
        state?: { status?: string; title?: string };
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    // First session wins: a conversation is bound to one opencode session.
    if (event.type === "step_start" && event.sessionID && this.sessionId === undefined) {
      this.sessionId = event.sessionID;
    }
    const part = event.part;
    const partType = part?.type ?? event.type;
    if (isReasoningType(event.type) || isReasoningType(partType)) {
      const text = typeof part?.text === "string" ? part.text : "";
      if (!text) return;
      this.upsert(this.reasoningParts, this.reasoningIndex, part?.id, text);
      return;
    }
    if (isToolType(event.type) || isToolType(partType)) {
      const id = part?.id ?? `tool-${this.tools.length}`;
      const name =
        (typeof part?.tool === "string" && part.tool) ||
        (typeof part?.name === "string" && part.name) ||
        (typeof part?.state?.title === "string" && part.state.title) ||
        "tool";
      const status = typeof part?.state?.status === "string" ? part.state.status : "running";
      const existing = this.toolIndex.get(id);
      const row: ExplainerToolStatus = { id, name, status };
      if (existing != null) this.tools[existing] = row;
      else {
        this.toolIndex.set(id, this.tools.length);
        this.tools.push(row);
      }
      return;
    }
    if (event.type === "text" && typeof part?.text === "string" && part.text.length > 0) {
      // A part can be re-emitted with grown text (provider-side streaming);
      // the newest emission of an id replaces its earlier snapshot, while
      // anonymous parts append (nothing to key them on but order).
      this.upsert(this.textParts, this.partIndex, part.id, part.text);
      if (part.id == null) this.anonymousParts += 1;
    }
  }

  private upsert(parts: string[], index: Map<string, number>, id: string | undefined, text: string): void {
    if (id != null && index.has(id)) {
      parts[index.get(id)!] = text;
      return;
    }
    if (id != null) index.set(id, parts.length);
    parts.push(text);
  }
}

function isReasoningType(type: string | undefined): boolean {
  return type === "reasoning" || type === "thinking" || type === "reason";
}

function isToolType(type: string | undefined): boolean {
  return type === "tool" || type === "tool_use" || type === "tool-call" || type === "tool_call";
}
