/**
 * Repository typeahead for the scan page.
 *
 * Loaded (defer, scan page only) when an input carries [data-repo-typeahead].
 * Fetches the operator's allowlisted repositories once from
 * /api/scan/repositories and turns the input into an ARIA combobox: local
 * substring filtering, keyboard navigation (arrows/Enter/Escape), click
 * selection. If the fetch fails or returns nothing, the input stays a plain
 * free-form field — the server's allowlist checks and two-step confirm remain
 * the source of truth either way. All text inserted via textContent.
 */

export const TYPEAHEAD_HREF = "/assets/typeahead.js";

export const TYPEAHEAD_JS = String.raw`(function () {
  "use strict";

  var MAX_OPTIONS = 12;

  function filterRepos(repos, query) {
    var q = (query || "").trim().toLowerCase();
    var starts = [];
    var includes = [];
    for (var i = 0; i < repos.length; i++) {
      var name = String(repos[i].fullName).toLowerCase();
      if (!q) starts.push(repos[i]);
      else if (name.indexOf(q) === 0) starts.push(repos[i]);
      else if (name.indexOf(q) !== -1) includes.push(repos[i]);
    }
    return starts.concat(includes).slice(0, MAX_OPTIONS);
  }

  function wire(input, listbox, repos) {
    var options = [];
    var active = -1;

    function close() {
      listbox.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function open() {
      listbox.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function setActive(index) {
      active = index;
      for (var i = 0; i < listbox.children.length; i++) {
        var li = listbox.children[i];
        var isActive = i === index;
        li.classList.toggle("is-active", isActive);
        li.setAttribute("aria-selected", isActive ? "true" : "false");
        if (isActive) {
          input.setAttribute("aria-activedescendant", li.id);
          if (li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
        }
      }
    }

    function render() {
      listbox.textContent = "";
      options = filterRepos(repos, input.value);
      // Deliberately no auto-activation: typing a full repository name and
      // pressing Enter must submit the typed value, not the first match.
      // Only arrow-key navigation (setActive) arms the Enter interception.
      active = -1;
      input.removeAttribute("aria-activedescendant");
      if (options.length === 0) {
        listbox.appendChild(createOption({ fullName: "No matching allowlisted repository" }, true));
        return;
      }
      for (var i = 0; i < options.length; i++) listbox.appendChild(createOption(options[i], false));
    }

    function createOption(repo, isEmpty) {
      var li = document.createElement("li");
      li.id = input.id + "-opt-" + listbox.children.length;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.className = "typeahead-option" + (isEmpty ? " typeahead-empty" : "");
      li.textContent = repo.fullName;
      if (!isEmpty) {
        li.addEventListener("mousedown", function (event) {
          event.preventDefault(); // keep focus in the input
          select(repo);
        });
      }
      return li;
    }

    function select(repo) {
      input.value = repo.fullName;
      close();
      input.focus();
    }

    input.addEventListener("focus", function () { render(); open(); });
    input.addEventListener("input", function () { render(); open(); });
    input.addEventListener("keydown", function (event) {
      if (listbox.hidden) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(active < 0 ? 0 : Math.min(active + 1, options.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(active < 0 ? options.length - 1 : active - 1);
        if (active < 0) input.removeAttribute("aria-activedescendant");
      } else if (event.key === "Enter" && active >= 0 && options[active]) {
        event.preventDefault(); // select the navigated option, don't submit
        select(options[active]);
      } else if (event.key === "Escape") {
        close();
      }
    });
    document.addEventListener("click", function (event) {
      if (!listbox.hidden && event.target !== input && !listbox.contains(event.target)) close();
    });
  }

  function init() {
    var input = document.querySelector("[data-repo-typeahead]");
    if (!input || !input.id) return;
    var listbox = document.getElementById(input.getAttribute("aria-controls") || "");
    if (!listbox) return;
    fetch("/api/scan/repositories", { headers: { accept: "application/json" } })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        var repos = data && Array.isArray(data.repositories) ? data.repositories : [];
        if (repos.length) wire(input, listbox, repos);
        // No repos or failed lookup: the input stays free-form.
      })
      .catch(function () { /* free-form fallback stays */ });
  }

  globalThis.__maomaoTypeahead = { filterRepos: filterRepos };
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
`;
