import type { GuidedCommentView, GuidedSessionView } from "../guided/store.js";
import type { GuidedPublishPreview } from "../guided/publish-preview.js";

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
  const statusEl = root.querySelector<HTMLElement>("[data-save-state]");
  const summaryEl = root.querySelector<HTMLTextAreaElement>("[data-draft-summary]");
  const verdictEl = root.querySelector<HTMLSelectElement>("[data-draft-verdict]");
  const listEl = root.querySelector<HTMLElement>("[data-comment-list]");
  const inlineEditor = root.querySelector<HTMLElement>("[data-inline-editor]");
  const generalForm = root.querySelector<HTMLFormElement>("[data-general-form]");
  const previewOutput = root.querySelector<HTMLElement>("[data-preview-output]");

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
    const active = comments.filter((comment) => !comment.deletedAt);
    if (active.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No notes yet. Use a diff line for an inline note, or add a general note below.";
      listEl.append(empty);
      return;
    }
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
    renderComments(data.comments);
    if (summaryEl && document.activeElement !== summaryEl) summaryEl.value = data.session.draftSummary;
    if (verdictEl && document.activeElement !== verdictEl) verdictEl.value = data.session.draftVerdict ?? "";
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

  let summaryTimer: number | undefined;
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

  function saveViewed(path: string): void {
    enqueue(async () => {
      const current = await readSession();
      version = current.session.version;
      const viewedFiles = [...new Set([...current.session.viewedFiles, path])];
      if (viewedFiles.length === current.session.viewedFiles.length) return;
      await write("", { viewedFiles });
    }, () => {
      const file = document.querySelector(`[data-guided-file][data-path="${CSS.escape(path)}"]`);
      file?.classList.remove("gd-viewed");
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

  function showInlineEditor(anchor?: { path: string; side: string; line: string }, comment?: HTMLElement): void {
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
    inlineEditor.scrollIntoView({ block: "center" });
    body?.focus();
  }

  function openAnchor(anchor: { path: string; side: string; line: string }): void {
    if (!anchor.path || !anchor.side || !anchor.line || !inlineEditor) return;
    if (!inlineEditor.hidden) {
      const editingExisting = Boolean(inlineEditor.querySelector<HTMLInputElement>("[data-comment-client-id]")?.value);
      if (editingExisting && inlineEditor.dataset.reanchoring !== "1") return;
      inlineEditor.dataset.path = anchor.path;
      inlineEditor.dataset.side = anchor.side;
      inlineEditor.dataset.line = anchor.line;
      setText(inlineEditor.querySelector("[data-inline-target]"), `${anchor.path} ${anchor.side}:${anchor.line}`);
      return;
    }
    showInlineEditor(anchor);
  }

  document.addEventListener("click", (event) => {
    const trigger = closest<HTMLElement>(event.target, "[data-guided-comment-anchor]");
    if (!trigger) return;
    event.preventDefault();
    openAnchor({ path: trigger.dataset.path || "", side: trigger.dataset.side || "", line: trigger.dataset.line || "" });
  });
  document.addEventListener("guided:line-anchor", (event) => {
    openAnchor((event as CustomEvent<{ path: string; side: string; line: string }>).detail);
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
      inlineEditor.hidden = true;
      inlineEditor.dataset.reanchoring = "";
      await refresh();
    });
  });
  inlineEditor?.querySelector("[data-cancel-inline]")?.addEventListener("click", (event) => {
    event.preventDefault();
    if (inlineEditor) {
      inlineEditor.hidden = true;
      inlineEditor.dataset.reanchoring = "";
      if (!summaryDirty) status("saved");
    }
  });

  generalForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = commentFormData(generalForm);
    if (!String(data.body || "")) return;
    enqueue(async () => {
      await write("/comments", { ...data, kind: "general" });
      resetGeneralForm();
      await refresh();
    });
  });

  listEl?.addEventListener("click", (event) => {
    const editButton = closest<HTMLElement>(event.target, "[data-edit-comment]");
    const deleteButton = closest<HTMLElement>(event.target, "[data-delete-comment]");
    const item = closest<HTMLElement>(event.target, "[data-client-id]");
    if (!item) return;
    if (editButton) {
      event.preventDefault();
      if (item.dataset.kind === "inline") showInlineEditor(undefined, item);
      else if (generalForm) {
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

  root.querySelector("[data-refresh-draft]")?.addEventListener("click", (event) => {
    event.preventDefault();
    enqueue(refresh);
  });

  root.querySelector("[data-preview-publish]")?.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!previewOutput) return;
    previewOutput.textContent = "Loading exact preview…";
    window.clearTimeout(summaryTimer);
    if (summaryDirty) saveSummary();
    await queue;
    if (writeFailed || conflicted) {
      previewOutput.textContent = "Resolve the draft save error or conflict before previewing; the preview must reflect persisted draft state exactly.";
      return;
    }
    try {
      const response = await fetch(`/api/guided-review/sessions/${sessionId}/preview`);
      if (!response.ok) throw new Error(`preview failed (${response.status})`);
      const { preview } = (await response.json()) as { preview: GuidedPublishPreview };
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
      const payload = document.createElement("pre");
      payload.className = "gd-preview-payload";
      payload.textContent = JSON.stringify(preview, null, 2);
      previewOutput.append(target, warning, payload);
    } catch (error) {
      previewOutput.textContent = `Could not load preview: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

export function enhanceGuidedDrafts(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-guided-draft]")) {
    if (root.dataset.enhanced === "1") continue;
    root.dataset.enhanced = "1";
    enhanceDraft(root);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhanceGuidedDrafts);
  else enhanceGuidedDrafts();
}
