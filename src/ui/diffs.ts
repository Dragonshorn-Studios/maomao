/**
 * Client-side diff enhancement for finding cards.
 *
 * Served at DIFFS_HREF and loaded with `defer` on every page. The server renders
 * plain per-line `<span class="diff-add|diff-del|diff-ctx">` markup inside
 * `details.finding-diff pre.diff-panel`; this script progressively enhances
 * those panels with line-number gutters, word-level highlights, a copy button,
 * and long-hunk collapsing. Without JS the server markup remains, styled by
 * THEME_CSS. No dependencies, no network calls, all text inserted via
 * textContent (never innerHTML).
 */

export const DIFFS_HREF = "/assets/diffs.js";

export const DIFFS_JS = String.raw`(function () {
  "use strict";

  var MAX_VISIBLE = 14;

  function tokenize(text) {
    return text.match(/\w+|\s+|[^\w\s]/g) || [];
  }

  // Word-level diff of two paired lines: LCS over tokens, O(n*m) — diff lines are short.
  function wordDiff(oldText, newText) {
    var a = tokenize(oldText);
    var b = tokenize(newText);
    var n = a.length;
    var m = b.length;
    var lcs = new Array(n + 1);
    for (var row = 0; row <= n; row++) lcs[row] = new Uint32Array(m + 1);
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    var oldTokens = [];
    var newTokens = [];
    var x = 0;
    var y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) {
        oldTokens.push({ text: a[x], changed: false });
        newTokens.push({ text: b[y], changed: false });
        x++;
        y++;
      } else if (lcs[x + 1][y] >= lcs[x][y + 1]) {
        oldTokens.push({ text: a[x], changed: true });
        x++;
      } else {
        newTokens.push({ text: b[y], changed: true });
        y++;
      }
    }
    while (x < n) { oldTokens.push({ text: a[x], changed: true }); x++; }
    while (y < m) { newTokens.push({ text: b[y], changed: true }); y++; }
    return { oldTokens: oldTokens, newTokens: newTokens };
  }

  // Reads the server-rendered pre: spans carry diff-add/diff-del/diff-ctx,
  // interleaved with newline text nodes.
  function parseLines(panel) {
    var lines = [];
    for (var node = panel.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1) {
        var cls = node.className || "";
        var type = cls.indexOf("diff-add") !== -1 ? "add" : cls.indexOf("diff-del") !== -1 ? "del" : "ctx";
        lines.push({ type: type, text: node.textContent || "" });
      } else if (node.nodeType === 3) {
        var parts = (node.textContent || "").split("\n");
        for (var k = 0; k < parts.length; k++) {
          if (parts[k].length) lines.push({ type: "ctx", text: parts[k] });
        }
      }
    }
    return lines;
  }

  // Tracks old/new line numbers from @@ -a,b +c,d @@ headers. The "@@ first
  // hunk (no line recorded)" variant has no numbers: gutters stay empty.
  function computeGutters(lines) {
    var oldNo = null;
    var newNo = null;
    return lines.map(function (line) {
      var hunk = line.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldNo = parseInt(hunk[1], 10);
        newNo = parseInt(hunk[2], 10);
        return { old: null, new: null };
      }
      if (oldNo === null) return { old: null, new: null };
      if (line.type === "add") return { old: null, new: newNo++ };
      if (line.type === "del") return { old: oldNo++, new: null };
      return { old: oldNo++, new: newNo++ };
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildRow(line, gutter, tokens) {
    var row = el("span", "diff-row is-" + line.type);
    row.appendChild(el("span", "diff-gutter", gutter.old == null ? "" : String(gutter.old)));
    row.appendChild(el("span", "diff-gutter", gutter.new == null ? "" : String(gutter.new)));
    var code = el("span", "diff-code");
    var list = tokens || [{ text: line.text, changed: false }];
    for (var k = 0; k < list.length; k++) {
      if (list[k].changed) code.appendChild(el("span", line.type === "add" ? "word-add" : "word-del", list[k].text));
      else code.appendChild(document.createTextNode(list[k].text));
    }
    if (!code.hasChildNodes()) code.appendChild(document.createTextNode(" "));
    row.appendChild(code);
    return row;
  }

  function buildCopyButton(rawText) {
    var button = el("button", "diff-copy", "Copy");
    button.type = "button";
    button.setAttribute("aria-label", "Copy diff");
    button.addEventListener("click", function () {
      var done = function () {
        button.textContent = "Copied";
        setTimeout(function () { button.textContent = "Copy"; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(rawText).then(done, function () { fallbackCopy(rawText); done(); });
      } else {
        fallbackCopy(rawText);
        done();
      }
    });
    return button;
  }

  // Clipboard API needs a secure context; self-hosted HTTP deployments get the
  // textarea fallback.
  function fallbackCopy(text) {
    var area = el("textarea");
    area.value = text;
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (error) { /* nothing else to try */ }
    document.body.removeChild(area);
  }

  function enhance(panel) {
    if (!panel || panel.getAttribute("data-diffs-enhanced")) return panel;
    panel.setAttribute("data-diffs-enhanced", "1");
    var rawText = panel.textContent || "";
    var lines = parseLines(panel);
    var gutters = computeGutters(lines);
    var pairTokens = new Array(lines.length);
    for (var i = 0; i + 1 < lines.length; i++) {
      if (lines[i].type === "del" && lines[i + 1].type === "add") {
        var pair = wordDiff(lines[i].text, lines[i + 1].text);
        pairTokens[i] = pair.oldTokens;
        pairTokens[i + 1] = pair.newTokens;
        i++;
      }
    }

    var table = el("span", "diff-table");
    var contentRows = 0;
    var hiddenRows = [];
    for (var k = 0; k < lines.length; k++) {
      var row = buildRow(lines[k], gutters[k] || { old: null, new: null }, pairTokens[k]);
      var isHunkHeader = lines[k].text.slice(0, 2) === "@@";
      if (isHunkHeader) row.className = "diff-row is-hunk";
      if (!isHunkHeader) contentRows++;
      if (contentRows > MAX_VISIBLE) {
        row.classList.add("diff-collapsed");
        hiddenRows.push(row);
      }
      table.appendChild(row);
    }
    if (hiddenRows.length > 0) {
      var more = el("button", "diff-more", "Show " + hiddenRows.length + " more lines");
      more.type = "button";
      more.addEventListener("click", function () {
        for (var h = 0; h < hiddenRows.length; h++) hiddenRows[h].classList.remove("diff-collapsed");
        more.parentNode.removeChild(more);
      });
      table.appendChild(more);
    }

    panel.textContent = "";
    panel.appendChild(table);
    panel.appendChild(buildCopyButton(rawText));
    return panel;
  }

  function enhanceAll(root) {
    var panels = (root || document).querySelectorAll("details.finding-diff pre.diff-panel");
    for (var k = 0; k < panels.length; k++) {
      var details = panels[k].closest("details");
      if (details && !details.open) {
        // Lazy: closed diffs cost nothing until first opened.
        if (!details.hasAttribute("data-diffs-lazy")) {
          details.setAttribute("data-diffs-lazy", "1");
          details.addEventListener(
            "toggle",
            function () {
              if (this.open) enhance(this.querySelector("pre.diff-panel"));
            },
            { once: true },
          );
        }
      } else {
        enhance(panels[k]);
      }
    }
  }

  // Pure functions stay reachable headlessly (tests, console); DOM activation
  // only runs in a real document.
  globalThis.__maomaoDiffs = { wordDiff: wordDiff, computeGutters: computeGutters, enhance: enhance, enhanceAll: enhanceAll };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { enhanceAll(document); });
    else enhanceAll(document);
  }
})();
`;
