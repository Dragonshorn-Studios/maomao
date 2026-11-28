import type { GuidedCommentView, GuidedSessionView } from "../guided/store.js";
import type { GuidedPublishPreview } from "../guided/publish-preview.js";
import type { GuidedWalkthroughPayload, GuidedWalkthroughView } from "../guided/walkthrough-store.js";

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

interface GuidedSessionResponse {
  session: GuidedSessionView;
  comments: GuidedCommentView[];
}

function text(el: Element | null | undefined): string {
  return el?.textContent ?? "";
}

function setText(el: Element | null | undefined, value: string): void {
  if (el) el.textContent = value;
}

function closest<T extends Element>(target: EventTarget | null, selector: string): T | null {
  return target instanceof Element ? target.closest<T>(selector) : null;
}

function enhanceDraft(root: HTMLElement): void {
  const sessionId = Number(root.dataset.sessionId);
  if (!sessionId) return;
  let version = Number(root.dataset.version || 1);
  const csrf = root.dataset.csrf || "";
  let queue: Promise<void> = Promise.resolve();
  let conflicted = false;
  let writeFailed = false;
  let summaryDirty = false;
  let currentComments: GuidedCommentView[] = [];
  const statusEl = root.querySelector<HTMLElement>("[data-save-state]");
  const summaryEl = root.querySelector<HTMLTextAreaElement>("[data-draft-summary]");
  const verdictEl = root.querySelector<HTMLInputElement>("[data-draft-verdict]");
  const listEl = root.querySelector<HTMLElement>("[data-comment-list]");
  const inlineEditor = root.querySelector<HTMLElement>("[data-inline-editor]");
  const generalForm = root.querySelector<HTMLFormElement>("[data-general-form]");
  const inlineEditorHome = root.querySelector<HTMLElement>("[data-inline-editor-home]");
  let fallbackEditorRow: HTMLTableRowElement | null = null;
  (window as Window & { __maomaoGuidedInlineEditor?: HTMLElement }).__maomaoGuidedInlineEditor = inlineEditor ?? undefined;

  function status(state: SaveState, detail = ""): void {
    if (!statusEl) return;
    statusEl.dataset.state = state;
    const labels: Record<SaveState, string> = {
      saved: "Saved privately",
      unsaved: "Unsaved changes",
      saving: "Saving…",
      error: "Save error — retrying manually is safe",
      conflict: "Conflict: this draft changed elsewhere. Refresh before overwriting.",
    };
    statusEl.textContent = detail ? `${labels[state]} ${detail}` : labels[state];
  }

  async function readSession(): Promise<GuidedSessionResponse> {
    const response = await fetch(`/api/guided-review/sessions/${sessionId}`);
    if (!response.ok) throw new Error(`read failed (${response.status})`);
    return response.json() as Promise<GuidedSessionResponse>;
  }

  function renderComments(comments: GuidedCommentView[]): void {
    if (!listEl) return;
    listEl.textContent = "";
    const active = comments.filter((comment) => !comment.deletedAt && (comment.kind === "general" || comment.anchorStatus === "unplaced"));
    if (active.length === 0) return;
    for (const comment of active) {
      const item = document.createElement("article");
      item.className = "gd-comment";
      item.dataset.clientId = comment.clientId;
      item.dataset.kind = comment.kind;
      item.dataset.path = comment.path ?? "";
      item.dataset.side = comment.side ?? "";
      item.dataset.line = comment.line ? String(comment.line) : "";
      item.dataset.severity = comment.severity ?? "";
      item.dataset.category = comment.category ?? "";
      item.dataset.publishable = comment.publishable ? "1" : "";
      item.dataset.anchorStatus = comment.anchorStatus;
      const head = document.createElement("div");
      head.className = "gd-comment-head";
      const meta = document.createElement("span");
      meta.className = "muted";
      const where = comment.kind === "inline" ? `${comment.path ?? "?"} ${comment.side ?? ""}:${comment.line ?? "unplaced"}` : "general note";
      meta.textContent = `${where} · ${comment.publishable ? "candidate GitHub comment" : "private note"}${comment.anchorStatus === "unplaced" ? " · unplaced" : ""}`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "if-button if-button--sm";
      edit.dataset.editComment = comment.clientId;
      edit.textContent = "Edit";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "if-button if-button--sm";
      del.dataset.deleteComment = comment.clientId;
      del.textContent = "Delete";
      head.append(meta, edit, del);
      const body = document.createElement("p");
      body.className = "gd-comment-body";
      body.textContent = comment.body;
      item.append(head, body);
      if (comment.anchorStatus === "unplaced") {
        const warning = document.createElement("p");
        warning.className = "muted";
        warning.textContent = "Unplaced stale-hunk note: edit/re-anchor it before it can be selected for publication.";
        item.append(warning);
      }
      listEl.append(item);
    }
  }

  async function refresh(): Promise<void> {
    const data = await readSession();
    version = data.session.version;
    root.dataset.version = String(version);
    conflicted = false;
    writeFailed = false;
    currentComments = data.comments;
    renderComments(data.comments);
    (window as unknown as { __maomaoPierre?: { updateGuidedComments?: (comments: GuidedCommentView[]) => void } }).__maomaoPierre?.updateGuidedComments?.(data.comments);
    if (summaryEl && document.activeElement !== summaryEl) summaryEl.value = data.session.draftSummary;
    if (verdictEl && !summaryDirty) {
      verdictEl.value = data.session.draftVerdict ?? "";
      for (const candidate of root.querySelectorAll<HTMLButtonElement>("[data-verdict-choice]")) {
        candidate.classList.toggle("is-active", candidate.dataset.verdictChoice === verdictEl.value);
      }
    }
    status("saved");
  }

  async function write(path: string, body: Record<string, unknown>): Promise<void> {
    if (conflicted) throw new Error("draft conflict");
    status("saving");
    const response = await fetch(`/api/guided-review/sessions/${sessionId}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, version, csrf_token: csrf }),
    });
    if (response.status === 409) {
      conflicted = true;
      status("conflict");
      throw new Error("guided review version conflict");
    }
    if (!response.ok) {
      status("error", `(${response.status})`);
      throw new Error(`write failed (${response.status})`);
    }
    const json = (await response.json()) as { session?: GuidedSessionView };
    if (json.session) {
      version = json.session.version;
      root.dataset.version = String(version);
    }

    writeFailed = false;
    status("saved");
  }

  function enqueue(task: () => Promise<void>, onError?: () => void): void {
    queue = queue.then(task).catch((error) => {
      console.warn("guided draft write failed", error);
      writeFailed = true;
      if (!conflicted) status("error");
      onError?.();
    });
  }

  function saveSummary(): void {
    enqueue(async () => {
      await write("", {
        draftSummary: summaryEl?.value ?? "",
        draftVerdict: verdictEl?.value || null,
      });
      summaryDirty = false;
    });
  }

  async function flushDraftSaves(): Promise<void> {
    window.clearTimeout(summaryTimer);
    if (summaryDirty) saveSummary();
    await queue;
    if (writeFailed || conflicted) throw new Error("draft save error or conflict");
  }

  let summaryTimer: number | undefined;
  (window as Window & { __maomaoGuidedFlushDraft?: () => Promise<void> }).__maomaoGuidedFlushDraft = flushDraftSaves;
  for (const el of [summaryEl, verdictEl]) {
    el?.addEventListener("input", () => {
      summaryDirty = true;
      status("unsaved");
      window.clearTimeout(summaryTimer);
      summaryTimer = window.setTimeout(saveSummary, 800);
    });
    el?.addEventListener("change", () => {
      window.clearTimeout(summaryTimer);
      saveSummary();
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-verdict-choice]")) {
    button.addEventListener("click", () => {
      if (!verdictEl) return;
      verdictEl.value = verdictEl.value === button.dataset.verdictChoice ? "" : button.dataset.verdictChoice || "";
      for (const candidate of root.querySelectorAll<HTMLButtonElement>("[data-verdict-choice]")) {
        candidate.classList.toggle("is-active", candidate.dataset.verdictChoice === verdictEl.value);
      }
      summaryDirty = true;
      saveSummary();
    });
  }

  function saveViewed(path: string, viewed = true): void {
    enqueue(async () => {
      const current = await readSession();
      version = current.session.version;
      const existing = new Set(current.session.viewedFiles);
      if (viewed) existing.add(path);
      else existing.delete(path);
      const viewedFiles = [...existing];
      if (viewedFiles.length === current.session.viewedFiles.length && viewed === current.session.viewedFiles.includes(path)) return;
      await write("", { viewedFiles });
    }, () => {
      const file = document.querySelector(`[data-guided-file][data-path="${CSS.escape(path)}"]`);
      file?.classList.toggle("gd-viewed", !viewed);
      const toggle = file?.querySelector<HTMLInputElement>("[data-guided-viewed-toggle]");
      if (toggle) toggle.checked = !viewed;
      const warning = document.querySelector<HTMLElement>("[data-guided-write-error]");
      if (warning) warning.hidden = false;
    });
  }

  (window as Window & { __guidedDraftListenerReady?: boolean }).__guidedDraftListenerReady = true;
  document.addEventListener("guided:viewed", (event) => {
    const path = (event as CustomEvent<{ path?: string }>).detail?.path;
    if (path) saveViewed(path);
  });
  const pending = (window as Window & { __guidedViewedPending?: string[] }).__guidedViewedPending ?? [];
  (window as Window & { __guidedViewedPending?: string[] }).__guidedViewedPending = [];
  for (const path of new Set(pending)) saveViewed(path);
  document.addEventListener("change", (event) => {
    const toggle = closest<HTMLInputElement>(event.target, "[data-guided-viewed-toggle]");
    if (!toggle?.dataset.path) return;
    const file = toggle.closest("[data-guided-file]");
    file?.classList.toggle("gd-viewed", toggle.checked);
    saveViewed(toggle.dataset.path, toggle.checked);
  });

  function commentFormData(form: HTMLElement | HTMLFormElement): Record<string, unknown> {
    const clientId = form.querySelector<HTMLInputElement>("[data-comment-client-id]")?.value || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const data: Record<string, unknown> = {
      clientId,
      body: form.querySelector<HTMLTextAreaElement>("[data-comment-body]")?.value.trim() ?? "",
      severity: form.querySelector<HTMLSelectElement>("[data-comment-severity]")?.value || null,
      category: form.querySelector<HTMLInputElement>("[data-comment-category]")?.value.trim() || null,
      publishable: form.querySelector<HTMLInputElement>("[data-comment-publishable]")?.checked === true,
    };
    return data;
  }

  function resetGeneralForm(): void {
    generalForm?.reset();
    const client = generalForm?.querySelector<HTMLInputElement>("[data-comment-client-id]");
    if (client) client.value = "";
  }

  function parkInlineEditor(): void {
    if (!inlineEditor || !inlineEditorHome) return;
    fallbackEditorRow?.remove();
    fallbackEditorRow = null;
    inlineEditorHome.appendChild(inlineEditor);
    (window as Window & { __maomaoPierre?: { closeGuidedInlineEditor?: () => void } }).__maomaoPierre?.closeGuidedInlineEditor?.();
  }

  function mountFallbackInlineEditor(anchor: { path: string; side: string; line: string }): boolean {
    if (!inlineEditor || !anchor.path || !anchor.side || !anchor.line) return false;
    const file = document.querySelector<HTMLElement>(`[data-guided-file][data-path="${CSS.escape(anchor.path)}"]`);
    const line = file?.querySelector<HTMLElement>(`[data-anchor-side="${CSS.escape(anchor.side)}"][data-anchor-line="${CSS.escape(anchor.line)}"]`);
    if (!line) return false;
    if (!fallbackEditorRow) {
      fallbackEditorRow = document.createElement("tr");
      fallbackEditorRow.className = "gd-inline-editor-row";
      const cell = document.createElement("td");
      cell.colSpan = 4;
      fallbackEditorRow.appendChild(cell);
    }
    fallbackEditorRow.firstElementChild?.appendChild(inlineEditor);
    line.insertAdjacentElement("afterend", fallbackEditorRow);
    return true;
  }

  function mountInlineEditor(anchor: { path: string; side: string; line: string }): void {
    if (!inlineEditor) return;
    const line = Number(anchor.line);
    const pierce = (window as Window & {
      __maomaoPierre?: {
        openGuidedInlineEditor?: (target: { path: string; side: "LEFT" | "RIGHT"; line: number }) => boolean;
      };
    }).__maomaoPierre;
    if ((anchor.side === "LEFT" || anchor.side === "RIGHT") && Number.isSafeInteger(line) && pierce?.openGuidedInlineEditor?.({ path: anchor.path, side: anchor.side, line })) return;
    if (!mountFallbackInlineEditor(anchor)) parkInlineEditor();
  }

  function closeInlineEditor(): void {
    if (!inlineEditor) return;
    inlineEditor.hidden = true;
    inlineEditor.dataset.reanchoring = "";
    parkInlineEditor();
  }

  function showInlineEditor(anchor?: { path: string; side: string; line: string; top?: number; bottom?: number; left?: number; right?: number }, comment?: HTMLElement): void {
    if (!inlineEditor) return;
    inlineEditor.hidden = false;
    const unplaced = comment?.dataset.anchorStatus === "unplaced";
    inlineEditor.dataset.reanchoring = unplaced ? "1" : "";
    inlineEditor.dataset.path = unplaced ? "" : comment?.dataset.path || anchor?.path || "";
    inlineEditor.dataset.side = unplaced ? "" : comment?.dataset.side || anchor?.side || "";
    inlineEditor.dataset.line = unplaced ? "" : comment?.dataset.line || anchor?.line || "";
    setText(
      inlineEditor.querySelector("[data-inline-target]"),
      unplaced ? "choose a line in the current diff to re-anchor this note" : `${inlineEditor.dataset.path} ${inlineEditor.dataset.side}:${inlineEditor.dataset.line}`,
    );
    const client = inlineEditor.querySelector<HTMLInputElement>("[data-comment-client-id]");
    if (client) client.value = comment?.dataset.clientId ?? "";
    const body = inlineEditor.querySelector<HTMLTextAreaElement>("[data-comment-body]");
    if (body) body.value = comment ? text(comment.querySelector(".gd-comment-body")) : "";
    const severity = inlineEditor.querySelector<HTMLSelectElement>("[data-comment-severity]");
    if (severity) severity.value = comment?.dataset.severity ?? "";
    const category = inlineEditor.querySelector<HTMLInputElement>("[data-comment-category]");
    if (category) category.value = comment?.dataset.category ?? "";
    const publishable = inlineEditor.querySelector<HTMLInputElement>("[data-comment-publishable]");
    if (publishable) {
      publishable.checked = comment?.dataset.publishable === "1";
    }
    if (!unplaced && inlineEditor.dataset.path && inlineEditor.dataset.side && inlineEditor.dataset.line) {
      mountInlineEditor({ path: inlineEditor.dataset.path, side: inlineEditor.dataset.side, line: inlineEditor.dataset.line });
    } else {
      parkInlineEditor();
    }
    body?.focus();
  }

  function openAnchor(anchor: { path: string; side: string; line: string; top?: number; bottom?: number; left?: number; right?: number }): void {
    if (!anchor.path || !anchor.side || !anchor.line || !inlineEditor) return;
    if (!inlineEditor.hidden) {
      const editingExisting = Boolean(inlineEditor.querySelector<HTMLInputElement>("[data-comment-client-id]")?.value);
      if (editingExisting && inlineEditor.dataset.reanchoring !== "1") return;
      inlineEditor.dataset.path = anchor.path;
      inlineEditor.dataset.side = anchor.side;
      inlineEditor.dataset.line = anchor.line;
      setText(inlineEditor.querySelector("[data-inline-target]"), `${anchor.path} ${anchor.side}:${anchor.line}`);
      mountInlineEditor({ path: anchor.path, side: anchor.side, line: anchor.line });
      return;
    }
    showInlineEditor(anchor);
  }

  document.addEventListener("click", (event) => {
    const trigger = closest<HTMLElement>(event.target, "[data-guided-comment-anchor]");
    if (!trigger) return;
    event.preventDefault();
    const rect = trigger.getBoundingClientRect();
    openAnchor({ path: trigger.dataset.path || "", side: trigger.dataset.side || "", line: trigger.dataset.line || "", top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
  });
  document.addEventListener("guided:line-anchor", (event) => {
    openAnchor((event as CustomEvent<{ path: string; side: string; line: string; top?: number; bottom?: number; left?: number; right?: number }>).detail);
  });
  document.addEventListener("guided:edit-inline-comment", (event) => {
    const detail = (event as CustomEvent<{ clientId?: string; path?: string; side?: string; line?: number; body?: string; severity?: string; category?: string; publishable?: boolean; anchorStatus?: "anchored" | "unplaced"; top?: number; bottom?: number; left?: number; right?: number }>).detail;
    if (!detail?.clientId || !inlineEditor) return;
    const comment = document.createElement("article");
    comment.dataset.clientId = detail.clientId;
    comment.dataset.path = detail.path ?? "";
    comment.dataset.side = detail.side ?? "";
    comment.dataset.line = detail.line ? String(detail.line) : "";
    comment.dataset.severity = detail.severity ?? "";
    comment.dataset.category = detail.category ?? "";
    comment.dataset.publishable = detail.publishable ? "1" : "";
    comment.dataset.anchorStatus = detail.anchorStatus ?? "";
    const body = document.createElement("p");
    body.className = "gd-comment-body";
    body.textContent = detail.body ?? currentComments.find((candidate) => candidate.clientId === detail.clientId)?.body ?? "";
    comment.appendChild(body);
    showInlineEditor({
      path: detail.path ?? "",
      side: detail.side ?? "",
      line: detail.line ? String(detail.line) : "",
      top: detail.top,
      bottom: detail.bottom,
      left: detail.left,
      right: detail.right,
    }, comment);
  });
  document.addEventListener("guided:delete-inline-comment", (event) => {
    const clientId = (event as CustomEvent<{ clientId?: string }>).detail?.clientId;
    if (!clientId) return;
    enqueue(async () => {
      await write("/comments/delete", { clientId });
      await refresh();
    });
  });

  for (const form of [inlineEditor, generalForm]) {
    form?.addEventListener("input", () => status("unsaved"));
  }

  inlineEditor?.querySelector("[data-save-inline]")?.addEventListener("click", (event) => {
    event.preventDefault();
    if (!inlineEditor) return;
    const data = commentFormData(inlineEditor);
    if (!String(data.body || "")) {
      status("error", "Note body is required.");
      return;
    }
    if (!inlineEditor.dataset.path || !inlineEditor.dataset.side || !inlineEditor.dataset.line) {
      status("error", "Choose a line in the current diff before saving this note.");
      return;
    }
    enqueue(async () => {
      await write("/comments", {
        ...data,
        kind: "inline",
        path: inlineEditor.dataset.path,
        side: inlineEditor.dataset.side,
        line: Number(inlineEditor.dataset.line),
      });
      closeInlineEditor();
      await refresh();
    });
  });
  inlineEditor?.querySelector("[data-cancel-inline]")?.addEventListener("click", (event) => {
    event.preventDefault();
    closeInlineEditor();
    if (!summaryDirty) status("saved");
  });

  generalForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = commentFormData(generalForm);
    if (!String(data.body || "")) return;
    enqueue(async () => {
      await write("/comments", { ...data, kind: "general" });
      resetGeneralForm();
      generalForm.hidden = true;
      await refresh();
    });
  });

  document.addEventListener("click", (event) => {
    const editButton = closest<HTMLElement>(event.target, "[data-edit-comment]");
    const deleteButton = closest<HTMLElement>(event.target, "[data-delete-comment]");
    const item = closest<HTMLElement>(event.target, "[data-client-id]");
    if (!item) return;
    if (editButton) {
      event.preventDefault();
      if (item.dataset.kind === "inline") {
        const rect = editButton.getBoundingClientRect();
        showInlineEditor({ path: "", side: "", line: "", top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, item);
      }
      else if (generalForm) {
        generalForm.hidden = false;
        const client = generalForm.querySelector<HTMLInputElement>("[data-comment-client-id]");
        if (client) client.value = item.dataset.clientId ?? "";
        const body = generalForm.querySelector<HTMLTextAreaElement>("[data-comment-body]");
        if (body) body.value = text(item.querySelector(".gd-comment-body"));
        const severity = generalForm.querySelector<HTMLSelectElement>("[data-comment-severity]");
        if (severity) severity.value = item.dataset.severity ?? "";
        const category = generalForm.querySelector<HTMLInputElement>("[data-comment-category]");
        if (category) category.value = item.dataset.category ?? "";
        const publishable = generalForm.querySelector<HTMLInputElement>("[data-comment-publishable]");
        if (publishable) publishable.checked = item.dataset.publishable === "1";
        body?.focus();
      }
    } else if (deleteButton) {
      event.preventDefault();
      enqueue(async () => {
        await write("/comments/delete", { clientId: item.dataset.clientId });
        await refresh();
      });
    }
  });

  root.querySelector("[data-toggle-general]")?.addEventListener("click", (event) => {
    event.preventDefault();
    if (!generalForm) return;
    generalForm.hidden = !generalForm.hidden;
    if (!generalForm.hidden) generalForm.querySelector<HTMLTextAreaElement>("[data-comment-body]")?.focus();
  });

  root.querySelector("[data-refresh-draft]")?.addEventListener("click", (event) => {
    event.preventDefault();
    enqueue(refresh);
  });


}


function renderPublishPreview(previewOutput: HTMLElement, preview: GuidedPublishPreview): void {
previewOutput.textContent = "";
const target = document.createElement("p");
target.className = "muted";
target.textContent = `${preview.target.provider}:${preview.target.instance} ${preview.target.repoFullName}#${preview.target.prNumber} · base ${preview.target.baseSha} · head ${preview.target.headSha} · event ${preview.event}`;
const warning = document.createElement("p");
warning.className = "notice if-banner if-banner--warning";
warning.textContent = preview.event === "APPROVE" && preview.omittedInlineCount > 0
  ? `${preview.omittedInlineCount} publishable inline note(s) are folded into the review summary so approval creates no unresolved inline threads.`
  : preview.unresolvedThreadWarning
    ? "Inline comments may become unresolved threads that native merge gates can block on. They are included only because you marked them publishable."
    : "";
const eventLine = document.createElement("p");
eventLine.className = "gd-preview-event";
eventLine.textContent = `${preview.event} · ${preview.comments.length} inline comment${preview.comments.length === 1 ? "" : "s"}`;
const bodyLabel = document.createElement("h4");
bodyLabel.textContent = "Review body that will be posted";
const body = document.createElement("pre");
body.className = "gd-preview-payload";
body.textContent = preview.body;
const pieces: HTMLElement[] = [target, warning, eventLine, bodyLabel, body];
if (preview.comments.length) {
  const list = document.createElement("div");
  list.className = "gd-preview-comments";
  for (const comment of preview.comments) {
    const item = document.createElement("article");
    item.className = "gd-comment";
    const head = document.createElement("div");
    head.className = "gd-comment-head";
    const where = document.createElement("strong");
    where.textContent = `${comment.path} ${comment.side}:${comment.line}`;
    head.appendChild(where);
    const textBody = document.createElement("p");
    textBody.className = "gd-comment-body";
    textBody.textContent = comment.body;
    item.append(head, textBody);
    list.appendChild(item);
  }
  pieces.push(list);
}
const raw = document.createElement("details");
const summary = document.createElement("summary");
summary.textContent = "Exact publication payload";
const payload = document.createElement("pre");
payload.className = "gd-preview-payload";
payload.textContent = JSON.stringify(preview, null, 2);
raw.append(summary, payload);
pieces.push(raw);
previewOutput.append(...pieces);
}


function appendText(parent: HTMLElement, tag: string, value: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = value;
  parent.append(el);
  return el;
}

function fileAnchors(): Map<string, string> {
  const anchors = new Map<string, string>();
  document.querySelectorAll<HTMLElement>("[data-guided-file]").forEach((file, index) => {
    const path = file.dataset.path;
    if (path) anchors.set(path, `#guided-file-${index}`);
  });
  return anchors;
}

function appendPathLink(parent: HTMLElement, path: string | undefined, label: string, line?: number): void {
  let href = path ? fileAnchors().get(path) : undefined;
  if (path && line) {
    const row = document.querySelector(`[data-anchor-path="${CSS.escape(path)}"][data-anchor-line="${line}"]`);
    if (row?.id) href = `#${row.id}`;
  }
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    parent.append(link);
  } else {
    appendText(parent, "span", label);
  }
}

function renderWalkthroughPayload(container: HTMLElement, payload: GuidedWalkthroughPayload): void {
  container.textContent = "";
  const details = document.createElement("details");
  details.className = "gd-walkthrough-full";
  appendText(details, "summary", "Full exploration evidence");
  const content = document.createElement("div");
  content.className = "gd-walkthrough-content";
  appendText(content, "h3", "Intent as expressed");
  appendText(content, "p", payload.intent.text);
  appendText(content, "p", `Uncertainty: ${payload.intent.uncertainty}`, "muted");
  appendText(content, "h3", "Change map");
  const changes = document.createElement("ul");
  for (const change of payload.changeMap) {
    const item = document.createElement("li");
    appendPathLink(item, change.path, change.path);
    item.append(document.createTextNode(` — ${change.summary} `));
    appendText(item, "span", change.evidence, "muted");
    changes.append(item);
  }
  content.append(changes);
  appendText(content, "h3", "Execution and data flow");
  appendText(content, "p", payload.flow);
  appendText(content, "h3", "Decisions and invariants");
  const decisions = document.createElement("ul");
  for (const decision of payload.decisions) {
    const item = document.createElement("li");
    appendText(item, "strong", decision.title);
    item.append(document.createTextNode(` — ${decision.details} `));
    appendText(item, "span", decision.evidence, "muted");
    decisions.append(item);
  }
  content.append(decisions);
  appendText(content, "h3", "Tests");
  appendText(content, "p", payload.tests);
  appendText(content, "h3", "Reviewer questions");
  const risks = document.createElement("ul");
  for (const risk of payload.risks) {
    const item = document.createElement("li");
    item.append(document.createTextNode(`${risk.question} `));
    if (risk.path) appendPathLink(item, risk.path, risk.line ? `${risk.path}:${risk.line}` : risk.path, risk.line);
    item.append(document.createTextNode(" "));
    appendText(item, "span", risk.evidence, "muted");
    risks.append(item);
  }
  content.append(risks);
  details.append(content);
  container.append(details);
}

function walkthroughStatusText(status: string): string {
  if (status === "pending") return "Queued";
  if (status === "running") return "Generating";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Stale";
}

function compactPrimerText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, Math.max(1, maxChars - 1));
  const boundary = Math.max(clipped.lastIndexOf(" "), Math.floor(maxChars * 0.65));
  return `${clipped.slice(0, boundary).trimEnd()}…`;
}

function renderExplorationPrimer(view: GuidedWalkthroughView): void {
  const root = document.querySelector<HTMLElement>("[data-guided-primer]");
  const payload = (view.status === "ready" || view.status === "stale") ? view.payload : undefined;
  if (root) {
    root.dataset.status = view.status;
    root.textContent = "";
    const head = document.createElement("div");
    head.className = "gd-primer-head";
    appendText(head, "h2", "Maomao exploration primer");
    appendText(head, "span", payload ? (view.status === "stale" ? "stale pinned head" : "independent · no findings or verdicts") : walkthroughStatusText(view.status).toLowerCase(), "job-chip");
    root.append(head);
    if (payload) {
      appendText(root, "p", compactPrimerText(payload.intent.text, 420));
      appendText(root, "p", `Flow: ${compactPrimerText(payload.flow, 520)}`, "muted");
      appendText(root, "p", `Uncertainty: ${compactPrimerText(payload.intent.uncertainty, 220)}`, "muted");
    } else if (view.status === "pending" || view.status === "running") {
      appendText(root, "p", "Independent exploration is running. It explains the pinned change without using Maomao review findings or verdicts.", "muted");
    } else if (view.status === "failed") {
      appendText(root, "p", `Exploration failed${view.error ? `: ${view.error}` : "."} Review can continue manually.`, "muted");
    } else if (view.status === "cancelled") {
      appendText(root, "p", "Independent exploration was cancelled.", "muted");
    } else {
      appendText(root, "p", "This exploration belongs to an older pinned head.", "muted");
    }
  }
  document.querySelectorAll<HTMLElement>("[data-file-primer]").forEach((element) => {
    const path = element.dataset.path || "";
    const change = payload?.changeMap.find((entry) => entry.path === path);
    element.textContent = "";
    if (!payload) {
      element.hidden = true;
      return;
    }
    appendText(element, "strong", "Maomao exploration");
    if (change) {
      appendText(element, "p", compactPrimerText(change.summary, 220));
      appendText(element, "p", compactPrimerText(change.evidence, 160), "muted");
    } else {
      appendText(element, "p", "No concise file-specific evidence was produced by the independent exploration.", "muted");
    }
    element.hidden = false;
  });
}

function enhanceWalkthrough(root: HTMLElement): void {
  const sessionId = Number(root.dataset.sessionId);
  const csrf = root.dataset.csrf || "";
  if (!sessionId) return;
  const state = root.querySelector<HTMLElement>("[data-walkthrough-state]");
  const detail = root.querySelector<HTMLElement>("[data-walkthrough-detail]");
  const body = root.querySelector<HTMLElement>("[data-walkthrough-body]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-walkthrough-cancel]");
  const retryButton = root.querySelector<HTMLButtonElement>("[data-walkthrough-retry]");
  let timer = 0;

  async function read(): Promise<GuidedWalkthroughView | undefined> {
    const response = await fetch(`/api/guided-review/sessions/${sessionId}/walkthrough`);
    if (!response.ok) throw new Error(`walkthrough status failed (${response.status})`);
    return ((await response.json()) as { walkthrough?: GuidedWalkthroughView }).walkthrough;
  }

  function render(view: GuidedWalkthroughView): void {
    renderExplorationPrimer(view);
    root.dataset.status = view.status;
    if (state) state.textContent = walkthroughStatusText(view.status);
    if (detail) {
      detail.textContent = "";
      const active = view.status === "pending" || view.status === "running";
      if (active) {
        const notice = document.createElement("p");
        notice.className = "notice if-banner";
        notice.setAttribute("role", "status");
        const spinner = document.createElement("span");
        spinner.className = "gd-spinner";
        spinner.setAttribute("aria-hidden", "true");
        notice.append(spinner, document.createTextNode(` ${walkthroughStatusText(view.status)} walkthrough in the background. You can inspect the diff immediately; this panel updates without blocking the page.`));
        detail.append(notice);
      }
      detail.hidden = !active;
    }
    if (cancelButton) cancelButton.hidden = view.status !== "pending" && view.status !== "running";
    if (retryButton) retryButton.hidden = view.status !== "failed" && view.status !== "cancelled";
    if (body) {
      if ((view.status === "ready" || view.status === "stale") && view.payload) renderWalkthroughPayload(body, view.payload);
      else if (view.status === "failed") body.textContent = `Generation failed${view.error ? `: ${view.error}` : "."} Manual review remains available.`;
      else if (view.status === "cancelled") body.textContent = "Generation was cancelled.";
      else if (view.status === "stale") body.textContent = "This walkthrough belongs to an older head SHA.";
      else body.textContent = "Generation is running in the background. You can inspect the diff immediately.";
    }
    window.clearTimeout(timer);
    if (view.status === "pending" || view.status === "running") {
      timer = window.setTimeout(() => void refresh(), 2000);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const view = await read();
      if (view) render(view);
    } catch {
      if (state) state.textContent = "Status unavailable";
    }
  }

  async function mutate(action: "retry" | "cancel"): Promise<void> {
    const response = await fetch(`/api/guided-review/sessions/${sessionId}/walkthrough/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csrf_token: csrf }),
    });
    if (!response.ok) throw new Error(`${action} failed (${response.status})`);
    const view = ((await response.json()) as { walkthrough?: GuidedWalkthroughView }).walkthrough;
    if (view) render(view);
    if (action === "retry") timer = window.setTimeout(() => void refresh(), 500);
  }

  root.addEventListener("click", handleGuidedLineAnchorClick);

  root.querySelector("[data-walkthrough-refresh]")?.addEventListener("click", (event) => {
    event.preventDefault();
    void refresh();
  });
  root.querySelector("[data-walkthrough-retry]")?.addEventListener("click", (event) => {
    event.preventDefault();
    void mutate("retry").catch(() => { if (state) state.textContent = "Retry failed"; });
  });
  root.querySelector("[data-walkthrough-cancel]")?.addEventListener("click", (event) => {
    event.preventDefault();
    void mutate("cancel").catch(() => { if (state) state.textContent = "Cancel failed"; });
  });
  if (root.dataset.status === "pending" || root.dataset.status === "running") {
    timer = window.setTimeout(() => void refresh(), 1000);
  }
}

function enhanceGuidedWalkthroughs(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-guided-walkthrough]")) {
    if (root.dataset.enhanced === "1") continue;
    root.dataset.enhanced = "1";
    enhanceWalkthrough(root);
  }
}


function handleGuidedLineAnchorClick(event: Event): void {
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#f"]') : null;
  const hash = anchor?.getAttribute("href") ?? "";
  const match = hash.match(/^#f(.+)-h(\d+)-L([on])(\d+)$/);
  if (!anchor || !match) return;
  let path = "";
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    return;
  }
  const handled = globalThis.__maomaoPierre?.scrollToGuidedLine(path, Number(match[4]), match[3] === "o" ? "LEFT" : "RIGHT") === true;
  if (!handled) return;
  event.preventDefault();
  history.pushState(null, "", hash);
}

function enhanceGuidedComparisons(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-guided-comparison]")) {
    if (root.dataset.enhanced === "1") continue;
    root.dataset.enhanced = "1";
    root.addEventListener("click", handleGuidedLineAnchorClick);
    const sessionId = Number(root.dataset.sessionId);
    if (!sessionId || root.dataset.state !== "pending") continue;
    const poll = async () => {
      try {
        const response = await fetch(`/api/guided-review/sessions/${sessionId}/comparison`);
        if (!response.ok) {
          window.setTimeout(() => void poll(), 8000);
          return;
        }
        const body = (await response.json()) as { comparison?: { state?: string } };
        if (body.comparison?.state && body.comparison.state !== "pending") {
          const active = document.activeElement;
          const saveState = document.querySelector<HTMLElement>("[data-save-state]")?.dataset.state;
          const draftBusy = saveState === "unsaved" || saveState === "saving" || saveState === "error" || saveState === "conflict";
          if (draftBusy || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active instanceof HTMLSelectElement) {
            window.setTimeout(() => void poll(), 5000);
          } else {
            window.location.reload();
          }
          return;
        }
        window.setTimeout(() => void poll(), 5000);
      } catch {
        window.setTimeout(() => void poll(), 8000);
      }
    };
    window.setTimeout(() => void poll(), 3000);
  }
}




async function loadPublishPreview(sessionId: number): Promise<GuidedPublishPreview> {
  const response = await fetch(`/api/guided-review/sessions/${sessionId}/preview`);
  if (!response.ok) throw new Error(`preview failed (${response.status})`);
  return ((await response.json()) as { preview: GuidedPublishPreview }).preview;
}

function enhanceGuidedPublicationPreviews(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-guided-publish-preview]")) {
    if (root.dataset.enhanced === "1") continue;
    root.dataset.enhanced = "1";
    const sessionId = Number(root.dataset.sessionId);
    const output = root.querySelector<HTMLElement>("[data-publish-preview-output]");
    if (!sessionId || !output) continue;
    const load = async () => {
      output.textContent = "Loading exact preview…";
      try {
        const flush = (window as Window & { __maomaoGuidedFlushDraft?: () => Promise<void> }).__maomaoGuidedFlushDraft;
        if (flush) await flush();
        renderPublishPreview(output, await loadPublishPreview(sessionId));
      } catch (error) {
        output.textContent = `Could not load the exact preview because the draft is not saved yet: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    root.querySelector("[data-load-publish-preview]")?.addEventListener("click", (event) => {
      event.preventDefault();
      void load();
    });
    document.addEventListener("guided:wizard-step", (event) => {
      if ((event as CustomEvent<{ step?: string }>).detail?.step === "publish") void load();
    });
    if ((document.getElementById("gd-step-publish") as HTMLInputElement | null)?.checked) void load();
    else output.textContent = "Open the publish step to load the exact payload after pending draft edits are saved.";
  }
}

interface GuidedDiscussionComment {
  authorLogin?: string;
  body: string;
  path?: string;
  line?: number | null;
}

interface GuidedDiscussion {
  id: string;
  path?: string;
  line?: number | null;
  maomaoAuthored: boolean;
  comments: GuidedDiscussionComment[];
}

function enhanceGuidedDiscussions(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-guided-discussions]")) {
    if (root.dataset.enhanced === "1") continue;
    root.dataset.enhanced = "1";
    const sessionId = Number(root.dataset.sessionId);
    const csrf = root.dataset.csrf || "";
    const list = root.querySelector<HTMLElement>("[data-discussion-list]");
    if (!sessionId || !list) continue;
    const render = (discussions: GuidedDiscussion[], unsupported = false) => {
      list.textContent = "";
      if (unsupported) {
        appendText(list, "p", "Thread resolution is currently available for GitHub.com guided reviews only.", "muted");
        return;
      }
      const maomao = discussions.filter((discussion) => discussion.maomaoAuthored);
      const others = discussions.filter((discussion) => !discussion.maomaoAuthored);
      if (!discussions.length) {
        appendText(list, "p", "No unresolved published threads remain.", "muted");
        return;
      }
      if (maomao.length) appendText(list, "p", `${maomao.length} unresolved Maomao-authored thread${maomao.length === 1 ? "" : "s"}. Resolve only after you have handled or intentionally rejected the finding.`, "muted");
      for (const discussion of [...maomao, ...others]) {
        const item = document.createElement("article");
        item.className = "gd-comment gd-discussion";
        const head = document.createElement("div");
        head.className = "gd-comment-head";
        appendText(head, "strong", `${discussion.path ?? "unanchored thread"}${discussion.line ? `:${discussion.line}` : ""}`);
        appendText(head, "span", discussion.maomaoAuthored ? "Maomao-authored" : "other author", "muted");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "if-button if-button--sm";
        button.textContent = "Resolve thread";
        button.addEventListener("click", () => {
          button.disabled = true;
          button.textContent = "Resolving…";
          void fetch(`/api/guided-review/sessions/${sessionId}/discussions/resolve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ discussionId: discussion.id, csrf_token: csrf }),
          }).then((response) => {
            if (!response.ok) throw new Error(`resolve failed (${response.status})`);
            return load();
          }).catch(() => {
            button.disabled = false;
            button.textContent = "Retry resolve";
          });
        });
        head.appendChild(button);
        item.appendChild(head);
        for (const comment of discussion.comments) {
          const body = document.createElement("p");
          body.className = "gd-comment-body";
          body.textContent = `${comment.authorLogin ?? "unknown"}: ${comment.body}`;
          item.appendChild(body);
        }
        list.appendChild(item);
      }
    };
    const load = async () => {
      try {
        const response = await fetch(`/api/guided-review/sessions/${sessionId}/discussions`);
        if (!response.ok) throw new Error(`discussions failed (${response.status})`);
        const body = (await response.json()) as { discussions?: GuidedDiscussion[]; unsupported?: boolean };
        render(body.discussions ?? [], body.unsupported === true);
      } catch (error) {
        list.textContent = "";
        appendText(list, "p", `Could not load published threads: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };
    void load();
  }
}

function enhanceGuidedPage(): void {
  enhanceGuidedDrafts();
  enhanceGuidedWalkthroughs();
  enhanceGuidedComparisons();
  enhanceGuidedDiscussions();
  enhanceGuidedPublicationPreviews();
}

export function enhanceGuidedDrafts(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-guided-draft]")) {
    if (root.dataset.enhanced === "1") continue;
    root.dataset.enhanced = "1";
    enhanceDraft(root);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhanceGuidedPage);
  else enhanceGuidedPage();
}
