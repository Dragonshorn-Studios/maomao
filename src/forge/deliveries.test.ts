import { describe, expect, it } from "vitest";
import { enqueueClaimResult, webhookDeliveryContext } from "./deliveries.js";

describe("enqueueClaimResult", () => {
  it("formats the shared enqueue claim vocabulary", () => {
    expect(enqueueClaimResult({ created: true })).toBe("enqueued");
    expect(enqueueClaimResult({ created: false, skippedReason: "job already exists for this SHA" })).toBe(
      "skipped: job already exists for this SHA",
    );
    expect(enqueueClaimResult({ created: false })).toBe("skipped");
  });
});

describe("webhookDeliveryContext", () => {
  it("reads the GitHub repository/sender shape", () => {
    const context = webhookDeliveryContext(
      JSON.stringify({
        action: "opened",
        repository: { full_name: "acme/widgets" },
        sender: { login: "octocat" },
      }),
    );
    expect(context).toEqual({ repoFullName: "acme/widgets", action: "opened", actor: "octocat" });
  });

  it("reads the GitLab project/user shape", () => {
    const context = webhookDeliveryContext(
      JSON.stringify({
        project: { path_with_namespace: "acme/widgets" },
        object_attributes: { action: "merge" },
        user: { name: "Octo Cat" },
      }),
    );
    expect(context).toEqual({ repoFullName: "acme/widgets", action: "merge", actor: "Octo Cat" });
  });

  it("falls back to the comment author and pull request author when no sender", () => {
    const viaComment = webhookDeliveryContext(
      JSON.stringify({
        repository: { full_name: "acme/widgets" },
        comment: { user: { login: "commenter" } },
        pull_request: { user: { login: "author" } },
      }),
    );
    expect(viaComment.actor).toBe("commenter");
    const viaPr = webhookDeliveryContext(
      JSON.stringify({ repository: { full_name: "acme/widgets" }, pull_request: { user: { login: "author" } } }),
    );
    expect(viaPr.actor).toBe("author");
  });

  it("rejects non-string payload fields instead of binding them", () => {
    const context = webhookDeliveryContext(
      JSON.stringify({
        action: 42,
        repository: { full_name: { name: "not a string" } },
        sender: { login: ["octocat"] },
      }),
    );
    expect(context).toEqual({ repoFullName: null, action: null, actor: null });
  });

  it("yields empty context for malformed or empty bodies", () => {
    expect(webhookDeliveryContext("not json")).toEqual({});
    expect(webhookDeliveryContext("{}")).toEqual({ repoFullName: null, action: null, actor: null });
    expect(webhookDeliveryContext(JSON.stringify({ action: "  " }))).toEqual({
      repoFullName: null,
      action: null,
      actor: null,
    });
  });
});
