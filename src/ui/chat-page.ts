/**
 * Server-rendered branded chat page. The no-JS round-trip form stays as
 * progressive enhancement; the assistant-ui island (Thread, Composer,
 * thinking, tools, suggestions, copy action bar) takes over after it mounts.
 * Theming reuses the app's existing classes so light/dark/flavor all work.
 */
import { escapeHtml } from "../util.js";
import type { ChatConversationRow, ChatMessageRow } from "../chat/store.js";
import { layout, csrfInput, pageBranding, type PageOptions } from "./layout.js";
import { CHAT_BUNDLE_HREF, diskAssetUrl } from "./paths.js";

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

function bubble(message: ChatMessageRow, assistantName: string): string {
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
  return `<div class="chat-bubble chat-bubble-assistant"><span class="muted">${escapeHtml(assistantName)}${meta ? ` · ${meta}` : ""}</span><p>${escapeHtml(message.content).replaceAll("\n", "<br/>")}</p></div>`;
}

export function renderChatPage(data: ChatPageData): string {
  const assistantName = pageBranding(data.options).name;
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
    assistantName,
    messages: data.messages.map((message) => ({ role: message.role, content: message.content })),
  }).replaceAll("</", "<\\/");
  const budgetLeft = Math.max(0, data.maxMessages - (data.conversation?.message_count ?? 0));
  const errorNotice = data.conversation?.state === "error" && data.conversation.last_error
    ? `<p class="error" role="alert">Last message failed: ${escapeHtml(data.conversation.last_error)}</p>`
    : "";
  const exhausted = budgetLeft === 0;
  const transcript = data.messages.length
    ? data.messages.map((message) => bubble(message, assistantName)).join("\n")
    : "<p class='muted'>No messages yet. Ask about the reviewed change — the explainer sees the exact head commit and the review findings, and can read the repository, but can never modify anything.</p>";
  const model = data.model ? escapeHtml(data.model) : '<span class="muted">reviewer model</span>';

  const body = `
    <p class="crumb"><a href="/jobs/${data.job.id}">Job ${data.job.id}</a> / Ask ${escapeHtml(assistantName)}</p>
    <h1>Ask ${escapeHtml(assistantName)} — code explainer</h1>
    <p class="lede">Chat about the reviewed change <code class="sha">${escapeHtml(data.job.head_sha.slice(0, 12))}</code> of ${escapeHtml(data.job.repo_full_name)}. Read-only: ${escapeHtml(assistantName)} can read the repository and its own findings, never modify anything.</p>
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    ${errorNotice}
    <div class="chat-transcript" aria-live="polite">${transcript}</div>
    <div class="chat-toolbar">
      <div class="meta-row">
        <span class="pair">Model <strong>${model}</strong></span>
        <span class="pair">Messages left <strong>${budgetLeft}</strong> of ${data.maxMessages}</span>
        <span class="pair">Spent <strong>$${data.usedCost.toFixed(4)}</strong> of $${data.maxCostUsd.toFixed(2)}</span>
      </div>
      <form method="post" action="/jobs/${data.job.id}/chat/reset" class="chat-reset">
        ${csrf}
        <button type="submit" class="btn-secondary">New conversation</button>
      </form>
    </div>
    ${exhausted ? "" : '<div id="maomao-chat-root"></div>'}
    <script id="maomao-chat-config" type="application/json">${islandConfig}</script>
    <script src="${diskAssetUrl(CHAT_BUNDLE_HREF)}" defer></script>
    <form id="maomao-chat-form" class="trigger" method="post" action="/jobs/${data.job.id}/chat/messages">
      ${csrf}
      <label>
        Ask about this change
        <textarea name="question" rows="3" placeholder="e.g. Walk me through the change in src/app.ts" ${exhausted ? "disabled" : "required"}></textarea>
      </label>
      <button type="submit" class="btn" ${exhausted ? "disabled" : ""}>${exhausted ? "Message limit reached — reset to continue" : "Ask"}</button>
    </form>`;
  return layout(`Ask ${assistantName}`, body, { ...data.options, surface: "operator" });
}
