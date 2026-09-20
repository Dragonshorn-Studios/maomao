/**
 * Server-rendered "Ask Maomao" chat page. The no-JS round-trip form stays as
 * progressive enhancement; the assistant-ui island (Thread, Composer,
 * thinking, tools, suggestions, copy action bar) takes over after it mounts.
 * Theming reuses the app's existing classes so light/dark/flavor all work.
 */
import { escapeHtml } from "../util.js";
import type { ChatConversationRow, ChatMessageRow } from "../chat/store.js";
import { layout, csrfInput, type PageOptions } from "./layout.js";
import { CHAT_BUNDLE_HREF } from "./paths.js";

const SEVERITY_ORDER: readonly string[] = ["blocker", "high", "medium", "low", "info"];

export interface ChatPageData {
  job: { id: number; repo_full_name: string; head_sha: string; pr_number: number };
  conversation: ChatConversationRow | undefined;
  messages: ChatMessageRow[];
  findings: Array<{ severity: string | null; summary: string }>;
  enabled: boolean;
  maxMessages: number;
  usedCost: number;
  maxCostUsd: number;
  model: string;
  options: PageOptions;
}

function bubble(message: ChatMessageRow): string {
  if (message.role === "user") {
    return `<div class="chat-bubble chat-bubble-user"><span class="muted">You</span><p>${escapeHtml(message.content)}</p></div>`;
  }
  const meta = [
    message.total_tokens != null ? `${message.total_tokens} tokens` : undefined,
    message.cost != null && message.cost > 0 ? `$${message.cost.toFixed(4)}` : undefined,
    message.duration_ms != null ? `${(message.duration_ms / 1000).toFixed(1)}s` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="chat-bubble chat-bubble-assistant"><span class="muted">Maomao${meta ? ` · ${meta}` : ""}</span><p>${escapeHtml(message.content).replaceAll("\n", "<br/>")}</p></div>`;
}

export function renderChatPage(data: ChatPageData): string {
  const csrf = csrfInput(data.options.csrfToken);
  const exhaustedByBudget = data.maxMessages - (data.conversation?.message_count ?? 0) <= 0;
  const suggestions = [
    "What does this change do overall?",
    ...data.findings
      .slice()
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity ?? "info") - SEVERITY_ORDER.indexOf(b.severity ?? "info"))
      .slice(0, 3)
      .map((finding) => `Explain the ${finding.severity ?? "info"} finding: ${finding.summary}`.replace("the  finding", "the finding")),
  ];
  const islandConfig = JSON.stringify({
    streamUrl: `/jobs/${data.job.id}/chat/stream`,
    csrfToken: data.options.csrfToken ?? null,
    exhausted: exhaustedByBudget,
    suggestions,
    messages: data.messages.map((message) => ({ role: message.role, content: message.content })),
  }).replaceAll("</", "<\\/");
  const budgetLeft = Math.max(0, data.maxMessages - (data.conversation?.message_count ?? 0));
  const errorNotice = data.conversation?.state === "error" && data.conversation.last_error
    ? `<p class="error" role="alert">Last message failed: ${escapeHtml(data.conversation.last_error)}</p>`
    : "";
  const exhausted = budgetLeft === 0;
  const transcript = data.messages.length
    ? data.messages.map(bubble).join("\n")
    : "<p class='muted'>No messages yet. Ask about the reviewed change — the explainer sees the exact head commit and Maomao's findings, and can read the repository, but can never modify anything.</p>";
  const model = data.model ? escapeHtml(data.model) : '<span class="muted">reviewer model</span>';

  const body = `
    <p class="crumb"><a href="/jobs/${data.job.id}">Job ${data.job.id}</a> / Ask Maomao</p>
    <h1>Ask Maomao — code explainer</h1>
    <p class="lede">Chat about the reviewed change <code class="sha">${escapeHtml(data.job.head_sha.slice(0, 12))}</code> of ${escapeHtml(data.job.repo_full_name)}. Read-only: Maomao can read the repository and its own findings, never modify anything.</p>
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    ${errorNotice}
    <div class="chat-transcript" aria-live="polite">${transcript}</div>
    <div class="meta-row">
      <span class="pair">Model <strong>${model}</strong></span>
      <span class="pair">Messages left <strong>${budgetLeft}</strong> of ${data.maxMessages}</span>
      <span class="pair">Spent <strong>$${data.usedCost.toFixed(4)}</strong> of $${data.maxCostUsd.toFixed(2)}</span>
    </div>
    ${exhausted ? "" : '<div id="maomao-chat-root"></div>'}
    <script id="maomao-chat-config" type="application/json">${islandConfig}</script>
    <script src="${CHAT_BUNDLE_HREF}" defer></script>
    <form id="maomao-chat-form" class="trigger" method="post" action="/jobs/${data.job.id}/chat/messages">
      ${csrf}
      <label>
        Ask about this change
        <textarea name="question" rows="3" placeholder="e.g. Walk me through the change in src/app.ts" ${exhausted ? "disabled" : "required"}></textarea>
      </label>
      <button type="submit" class="btn" ${exhausted ? "disabled" : ""}>${exhausted ? "Message limit reached — reset to continue" : "Ask"}</button>
    </form>
    <form method="post" action="/jobs/${data.job.id}/chat/reset">
      ${csrf}
      <button type="submit" class="btn-secondary">Start a new conversation</button>
    </form>`;
  return layout("Ask Maomao", body, { ...data.options, surface: "operator" });
}
