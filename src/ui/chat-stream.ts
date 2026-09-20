/**
 * Pure helpers for the Ask Maomao island: turn SSE frames from Maomao's
 * same-origin stream into assistant-ui content parts. Kept out of the React
 * entry so tests can pin the contract without a DOM.
 */

export interface AssistantToolStatus {
  id: string;
  name: string;
  status: string;
}

export interface AssistantStreamState {
  text: string;
  reasoning: string;
  tools: AssistantToolStatus[];
}

export function emptyAssistantStream(): AssistantStreamState {
  return { text: "", reasoning: "", tools: [] };
}

export function applySseEvent(
  state: AssistantStreamState,
  event: Record<string, unknown>,
): AssistantStreamState {
  if (typeof event.delta === "string") {
    return { ...state, text: event.delta };
  }
  if (typeof event.reasoning === "string") {
    return { ...state, reasoning: event.reasoning };
  }
  if (event.tool && typeof event.tool === "object") {
    const raw = event.tool as { id?: unknown; name?: unknown; status?: unknown };
    if (typeof raw.id !== "string" || typeof raw.name !== "string") return state;
    const next: AssistantToolStatus = {
      id: raw.id,
      name: raw.name,
      status: typeof raw.status === "string" ? raw.status : "running",
    };
    return { ...state, tools: [...state.tools.filter((tool) => tool.id !== next.id), next] };
  }
  return state;
}

export type AssistantContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, never>;
      argsText: string;
      result: string;
    };

/** Name and status only — never tool args or results (those can carry secrets). */
export function toAssistantContent(state: AssistantStreamState): AssistantContentPart[] {
  const content: AssistantContentPart[] = [];
  if (state.reasoning) content.push({ type: "reasoning", text: state.reasoning });
  for (const tool of state.tools) {
    content.push({
      type: "tool-call",
      toolCallId: tool.id,
      toolName: tool.name,
      args: {},
      argsText: "",
      result: tool.status,
    });
  }
  if (state.text) content.push({ type: "text", text: state.text });
  return content;
}
