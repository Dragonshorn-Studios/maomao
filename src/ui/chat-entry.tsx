/**
 * "Ask Maomao" chat island: an assistant-ui LocalRuntime mounted into the
 * job chat page. Talks only to Maomao's own streaming route (same-origin,
 * session-gated, CSRF-protected) — never to opencode directly. The no-JS
 * form fallback in the page is removed once the island mounts.
 */
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessagePartText,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { createRoot } from "react-dom/client";

interface ChatConfig {
  streamUrl: string;
  csrfToken?: string;
}

const FALLBACK = "The explainer could not answer. Check the server logs or try again.";

function chatConfig(): ChatConfig | undefined {
  const el = document.getElementById("maomao-chat-config");
  if (!el?.textContent) return undefined;
  try {
    const parsed = JSON.parse(el.textContent) as Partial<ChatConfig>;
    if (!parsed.streamUrl) return undefined;
    return { streamUrl: parsed.streamUrl, csrfToken: parsed.csrfToken };
  } catch {
    return undefined;
  }
}

/** Reads an SSE stream of `data: {"delta"|"error"|"done"}` events. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
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
          } catch {
            // Malformed event: skip rather than corrupt the transcript.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createAdapter(config: ChatConfig): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const last = messages[messages.length - 1];
      const question = (last?.content ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      if (!question) throw new Error("Write a question first.");
      const form = new URLSearchParams({ question });
      if (config.csrfToken) form.set("csrf_token", config.csrfToken);

      const response = await fetch(config.streamUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: abortSignal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`the explainer refused the request (status ${response.status})`);
      }

      let text = "";
      for await (const event of sseEvents(response.body)) {
        if (typeof event.delta === "string" && event.delta.length > 0) {
          text += event.delta;
          yield { content: [{ type: "text", text }] };
        }
        if (event.error != null) {
          throw new Error(String(event.error));
        }
      }
      if (!text.trim()) throw new Error(FALLBACK);
      yield { content: [{ type: "text", text }] };
    },
  };
}

const TextPart = () => {
  const part = useMessagePartText();
  return <p className="chat-text">{part.text}</p>;
};

const UserMessage = () => (
  <div className="chat-bubble chat-bubble-user">
    <span className="muted">You</span>
    <MessagePrimitive.Content components={{ Text: TextPart }} />
  </div>
);

const AssistantMessage = () => (
  <div className="chat-bubble chat-bubble-assistant">
    <span className="muted">Maomao</span>
    <MessagePrimitive.Content components={{ Text: TextPart }} />
  </div>
);

const Composer = () => (
  <ComposerPrimitive.Root className="chat-composer">
    <ComposerPrimitive.Input className="chat-composer-input" rows={2} placeholder="Ask about this change…" />
    <div className="chat-composer-actions">
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="chat-send">Ask</ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="chat-cancel">Stop</ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </div>
  </ComposerPrimitive.Root>
);

const Thread = () => (
  <ThreadPrimitive.Root className="chat-thread">
    <ThreadPrimitive.Viewport className="chat-viewport" autoScroll>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
    </ThreadPrimitive.Viewport>
    <Composer />
  </ThreadPrimitive.Root>
);

function ChatApp({ config }: { config: ChatConfig }): React.ReactElement {
  const runtime = useLocalRuntime(createAdapter(config));
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountChat);
} else {
  mountChat();
}

export function mountChat(): void {
  const root = document.getElementById("maomao-chat-root");
  const config = chatConfig();
  if (!root || !config || root.dataset.mounted === "true") return;
  root.dataset.mounted = "true";
  // The no-JS round-trip form is redundant once the live island is up.
  document.getElementById("maomao-chat-form")?.remove();
  createRoot(root).render(<ChatApp config={config} />);
}

/** Test seam: the SSE reader over a fetch Response body. */
export { sseEvents };
