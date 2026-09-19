/**
 * "Ask Maomao" chat island: an assistant-ui LocalRuntime mounted into the
 * job chat page. Talks only to Maomao's own streaming route (same-origin,
 * session-gated, CSRF-protected) — never to opencode directly. The no-JS
 * form fallback in the page is removed only after the island commits.
 */
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessagePartText,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { sseDataEvents } from "./sse.js";

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
    return { streamUrl: parsed.streamUrl, csrfToken: parsed.csrfToken ?? undefined };
  } catch {
    return undefined;
  }
}

/** Human guidance for the failure modes an operator can actually fix. */
function describeFetchFailure(response: Response): string {
  if (response.status === 403) {
    return "Your session or form token expired — reload this page and try again.";
  }
  if (response.status === 404) {
    return "The explainer is not available for this job.";
  }
  if (response.status === 401) {
    return "Your session expired — reload the page to sign in again.";
  }
  return `the explainer refused the request (status ${response.status})`;
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
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const serverMessage = typeof data?.error === "string" ? data.error : describeFetchFailure(response);
        throw new Error(serverMessage);
      }
      // A session-expiry redirect answers 200 with the login HTML; the SSE
      // content-type check turns that into advice the operator can act on.
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new Error("Your session expired — reload the page to sign in again.");
      }
      if (!response.body) throw new Error(FALLBACK);

      let text = "";
      for await (const event of sseDataEvents(response.body)) {
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
    <ErrorPrimitive.Message className="chat-error" role="alert" />
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
  // Remove the no-JS fallback only after the island has committed successfully.
  useEffect(() => {
    document.getElementById("maomao-chat-form")?.remove();
  }, []);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

export function mountChat(): void {
  const root = document.getElementById("maomao-chat-root");
  const config = chatConfig();
  if (!root || !config || root.dataset.mounted === "true") return;
  root.dataset.mounted = "true";
  createRoot(root).render(<ChatApp config={config} />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountChat);
} else {
  mountChat();
}

