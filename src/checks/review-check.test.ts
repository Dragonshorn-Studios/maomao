import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import type { ForgePort } from "../forge/port.js";
import type { ForgeCheckPublishInput } from "../forge/types.js";
import type { ForgeRegistry } from "../forge/registry.js";
import { JobStore } from "../jobs/store.js";
import { REVIEW_CHECK_NAME, ReviewCheckPublisher, reviewConclusionForJob } from "./review-check.js";

function enqueueJob(store: JobStore, headSha = "abc123456789") {
  return store.enqueue({
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 7,
    prNumber: 12,
    prTitle: "Change",
    prBody: "",
    prHtmlUrl: "https://github.com/acme/widgets/pull/12",
    prAuthor: "dev",
    baseSha: "base",
    headSha,
    baseRef: "main",
    headRef: "feature",
    reviewers: [],
  }).job;
}

function publisherFor(store: JobStore, provider: ForgePort, publicUrl = "https://maomao.example") {
  const forge = { forJob: () => provider } as unknown as ForgeRegistry;
  return new ReviewCheckPublisher({ store, forge, publicUrl });
}

function fakePort(input: {
  headSha: string;
  publish: (check: ForgeCheckPublishInput) => Promise<{ id: string; url?: string }>;
}): ForgePort {
  return {
    provider: "github",
    instance: "github.com",
    getChange: async () => ({
      repoOwner: "acme",
      repoName: "widgets",
      repoFullName: "acme/widgets",
      changeNumber: 12,
      title: "Change",
      body: "",
      htmlUrl: "",
      author: "dev",
      baseSha: "base",
      headSha: input.headSha,
      baseRef: "main",
      headRef: "feature",
      draft: false,
    }),
    getChangeDiff: async () => "",
    listSummaries: async () => [],
    publishReview: async () => ({ id: "review", url: "" }),
    listDiscussions: async () => [],
    resolveDiscussion: async () => {},
    unresolveDiscussion: async () => {},
    getActorPermission: async () => "none",
    cloneSpec: async () => ({ cloneUrl: "", gitAuthArgs: [], remoteRef: "", secrets: [] }),
    isBotLogin: () => false,
    publishCheck: input.publish,
  };
}

describe("ReviewCheckPublisher", () => {
  it("publishes ordered lifecycle states with a stable external id and durable audit row", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueueJob(store);
    const sent: ForgeCheckPublishInput[] = [];
    const publisher = publisherFor(
      store,
      fakePort({
        headSha: job.head_sha,
        publish: async (check) => {
          sent.push(check);
          return { id: "check-1", url: "https://github.example/check/1" };
        },
      }),
    );

    await publisher.publishQueuedJobId(job.id);
    await publisher.publish(job, { status: "in_progress", stage: "reviewing" });
    await publisher.publish({ ...job, state: "completed" }, { status: "completed", conclusion: "neutral" });

    expect(sent.map((check) => check.status)).toEqual(["queued", "in_progress", "completed"]);
    expect(sent.map((check) => check.externalId)).toEqual([sent[0]!.externalId, sent[0]!.externalId, sent[0]!.externalId]);
    expect(sent[0]?.name).toBe(REVIEW_CHECK_NAME);
    expect(sent[0]?.detailsUrl).toBe(`https://maomao.example/jobs/${job.id}`);
    const row = store.getCheckPublication({
      provider: job.provider,
      providerInstance: job.provider_instance,
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      headSha: job.head_sha,
      name: REVIEW_CHECK_NAME,
    });
    expect(row).toMatchObject({
      native_id: "check-1",
      native_url: "https://github.example/check/1",
      status: "completed",
      conclusion: "neutral",
      publish_error: null,
    });
    expect(row?.attempts).toBe(3);
  });

  it("does not publish a success when the live PR head moved; it marks the old-SHA check cancelled", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueueJob(store, "oldsha123456");
    const sent: ForgeCheckPublishInput[] = [];
    const publisher = publisherFor(
      store,
      fakePort({
        headSha: "newsha999999",
        publish: async (check) => {
          sent.push(check);
          return { id: "check-1" };
        },
      }),
    );

    await publisher.publish({ ...job, state: "completed" }, { status: "completed", conclusion: "success" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      title: "Maomao review superseded",
    });
  });

  it("publishes cancellation even when live-head validation is unavailable", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueueJob(store);
    const sent: ForgeCheckPublishInput[] = [];
    const provider = fakePort({
      headSha: job.head_sha,
      publish: async (check) => {
        sent.push(check);
        return { id: "check-1" };
      },
    });
    provider.getChange = async () => {
      throw new Error("api unavailable");
    };
    const publisher = publisherFor(store, provider);

    await publisher.publish({ ...job, state: "stale" }, { status: "completed", conclusion: "cancelled" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });

  it("clears the prior native outcome when a new publication attempt begins", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueueJob(store);
    const key = {
      provider: job.provider,
      providerInstance: job.provider_instance,
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      headSha: job.head_sha,
      name: REVIEW_CHECK_NAME,
    };
    store.beginCheckPublication({
      ...key,
      externalId: "external",
      jobId: job.id,
      status: "completed",
      conclusion: "success",
      title: "done",
      summary: "done",
    });
    store.finishCheckPublication(key, { nativeId: "native-1", nativeUrl: "https://example.test/check", published: true });

    store.beginCheckPublication({
      ...key,
      externalId: "external",
      jobId: job.id,
      status: "queued",
      title: "queued",
      summary: "queued",
    });

    expect(store.getCheckPublication(key)).toMatchObject({
      status: "queued",
      native_id: null,
      native_url: null,
      publish_error: null,
      published_at: null,
      attempts: 2,
    });
  });

  it("records provider publication failures without throwing or changing review work", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueueJob(store);
    const publisher = publisherFor(
      store,
      fakePort({
        headSha: job.head_sha,
        publish: async () => {
          throw new Error("Resource not accessible by integration");
        },
      }),
    );

    await publisher.publish(job, { status: "queued" });

    const row = store.getCheckPublication({
      provider: job.provider,
      providerInstance: job.provider_instance,
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      headSha: job.head_sha,
      name: REVIEW_CHECK_NAME,
    });
    expect(row?.publish_error).toContain("Resource not accessible");
    expect(row?.published_at).toBeNull();
  });

  it("maps terminal review outcomes to native conclusions", () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueueJob(store);
    expect(reviewConclusionForJob({ ...job, state: "completed", review_event: "REQUEST_CHANGES" })).toBe("failure");
    expect(reviewConclusionForJob({ ...job, state: "completed", review_event: "APPROVE" })).toBe("success");
    expect(reviewConclusionForJob({ ...job, state: "completed", review_event: "COMMENT" })).toBe("neutral");
    expect(reviewConclusionForJob({ ...job, state: "cancelled" })).toBe("cancelled");
    expect(reviewConclusionForJob({ ...job, state: "failed", failure_reason: "OpenCode timed out" })).toBe("timed_out");
  });
});
