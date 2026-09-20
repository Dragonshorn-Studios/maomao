/**
 * "Ask Maomao" chat island: an assistant-ui LocalRuntime mounted into the
 * job chat page. Talks only to Maomao's own streaming route (same-origin,
 * session-gated, CSRF-protected) — never to opencode directly, and never to
 * Assistant Cloud. The no-JS form fallback in the page is removed only after
 * the island commits.
 */
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  groupPartByType,
  useLocalRuntime,
  useMessagePartText,
  type ChatModelAdapter,
  type SuggestionAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { createRoot } from "react-dom/client";
import { useEffect, type ReactElement } from "react";
import { sseDataEvents } from "./sse.js";
import { applySseEvent, emptyAssistantStream, toAssistantContent } from "./chat-stream.js";

interface ChatConfig {
  streamUrl: string;
  csrfToken?: string;
  suggestions?: string[];
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}

const FALLBACK = "The explainer could not answer. Check the server logs or try again.";

function chatConfig(): ChatConfig | undefined {
  const el = document.getElementById("maomao-chat-config");
  if (!el?.textContent) return undefined;
  try {
    const parsed = JSON.parse(el.textContent) as Partial<ChatConfig>;
    if (!parsed.streamUrl) return undefined;
    return {
      streamUrl: parsed.streamUrl,
      csrfToken: parsed.csrfToken ?? undefined,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((item): item is string => typeof item === "string") : undefined,
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.filter(
            (item): item is { role: "user" | "assistant"; content: string } =>
              !!item &&
              (item.role === "user" || item.role === "assistant") &&
              typeof item.content === "string",
          )
        : undefined,
    };
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

      let state = emptyAssistantStream();
      for await (const event of sseDataEvents(response.body)) {
        if (event.error != null) {
          throw new Error(String(event.error));
        }
        state = applySseEvent(state, event);
        const content = toAssistantContent(state);
        if (content.length > 0) yield { content };
      }
      if (!state.text.trim()) throw new Error(FALLBACK);
      yield { content: toAssistantContent(state) };
    },
  };
}

function suggestionAdapter(prompts: string[]): SuggestionAdapter {
  return {
    async generate({ messages }) {
      if (messages.some((message) => message.role === "user")) return [];
      return prompts.map((prompt) => ({ prompt }));
    },
  };
}

const TextPart = () => {
  const part = useMessagePartText();
  return <p className="chat-text">{part.text}</p>;
};

const ReasoningPart = (props: { text?: string }) => {
  const text = props.text ?? "";
  if (!text) return <TextPart />;
  return <p className="chat-reasoning-text">{text}</p>;
};

const ToolFallback = (props: { toolName?: string; result?: unknown }) => (
  <div className="chat-tool" data-tool={props.toolName ?? ""}>
    <span className="state state-queued">{props.toolName || "tool"}</span>
    {typeof props.result === "string" && props.result ? (
      <span className="muted"> {props.result}</span>
    ) : null}
  </div>
);

const groupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
});

const AssistantParts = () => (
  <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="always">
    {({ part, children }) => {
      switch (part.type) {
        case "group-chainOfThought":
          return <div className="chat-thought">{children}</div>;
        case "group-reasoning": {
          const running = part.status.type === "running";
          return (
            <details className="chat-reasoning" open={running}>
              <summary>{running ? "Thinking…" : "Thinking"}</summary>
              <div className="chat-reasoning-body">{children}</div>
            </details>
          );
        }
        case "group-tool":
          return (
            <div className="chat-tools">
              <p className="label">Tools</p>
              {children}
            </div>
          );
        case "text":
          return <TextPart />;
        case "reasoning":
          return <ReasoningPart text={"text" in part ? String(part.text ?? "") : ""} />;
        case "tool-call":
          return (
            <ToolFallback
              toolName={"toolName" in part ? String(part.toolName ?? "") : ""}
              result={"result" in part ? part.result : undefined}
            />
          );
        case "indicator":
          return <p className="muted chat-indicator">Maomao is thinking…</p>;
        default:
          return null;
      }
    }}
  </MessagePrimitive.GroupedParts>
);

const CopyBar = () => (
  <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="chat-action-bar">
    <ActionBarPrimitive.Copy copiedDuration={1500} className="chat-action">
      Copy
    </ActionBarPrimitive.Copy>
  </ActionBarPrimitive.Root>
);

const UserMessage = () => (
  <MessagePrimitive.Root className="chat-bubble chat-bubble-user">
    <span className="muted">You</span>
    <MessagePrimitive.Content components={{ Text: TextPart }} />
    <CopyBar />
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root className="chat-bubble chat-bubble-assistant">
    <span className="muted">Maomao</span>
    <AssistantParts />
    <ErrorPrimitive.Root>
      <ErrorPrimitive.Message className="chat-error" role="alert" />
    </ErrorPrimitive.Root>
    <CopyBar />
  </MessagePrimitive.Root>
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

const SuggestionRail = ({ fallback }: { fallback: string[] }) => (
  <div className="chat-suggestions" role="list">
    <ThreadPrimitive.If empty>
      {fallback.map((prompt) => (
        <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send className="chat-suggestion">
          {prompt}
        </ThreadPrimitive.Suggestion>
      ))}
    </ThreadPrimitive.If>
    <ThreadPrimitive.Suggestions>
      {({ suggestion }) => (
        <SuggestionPrimitive.Trigger send className="chat-suggestion">
          {suggestion.prompt}
        </SuggestionPrimitive.Trigger>
      )}
    </ThreadPrimitive.Suggestions>
  </div>
);

const Thread = ({ config }: { config: ChatConfig }) => (
  <ThreadPrimitive.Root className="chat-thread">
    <ThreadPrimitive.Viewport className="chat-viewport" autoScroll>
      <ThreadPrimitive.Empty>
        <p className="muted">No messages yet. Ask about the reviewed change — the explainer sees the exact head commit and Maomao&apos;s findings, and can read the repository, but can never modify anything.</p>
      </ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      <ThreadPrimitive.ScrollToBottom className="chat-scroll-bottom">Latest</ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Viewport>
    <ThreadPrimitive.ViewportFooter className="chat-footer">
      <SuggestionRail fallback={config.suggestions ?? []} />
      <Composer />
    </ThreadPrimitive.ViewportFooter>
  </ThreadPrimitive.Root>
);

function initialMessages(config: ChatConfig): ThreadMessageLike[] {
  return (config.messages ?? []).map((message) => ({
    role: message.role,
    content: [{ type: "text" as const, text: message.content }],
  }));
}

function ChatApp({ config }: { config: ChatConfig }): ReactElement {
  const runtime = useLocalRuntime(createAdapter(config), {
    initialMessages: initialMessages(config),
    adapters: { suggestion: suggestionAdapter(config.suggestions ?? []) },
  });
  // Remove the no-JS fallback only after the island has committed successfully.
  useEffect(() => {
    document.getElementById("maomao-chat-form")?.remove();
    document.querySelector(".chat-transcript")?.setAttribute("hidden", "hidden");
  }, []);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread config={config} />
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
