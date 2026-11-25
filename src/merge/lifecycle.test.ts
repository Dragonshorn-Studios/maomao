import { describe, expect, it } from "vitest";
import { mergeLifecycleFor } from "./lifecycle.js";
import type { CheckPublicationRow, JobRow } from "../jobs/store.js";

const job = { state: "completed", failure_reason: null } as JobRow;
const pub = { status: "completed", conclusion: "success", title: "", native_url: "https://example.test/check", published_at: "2026-01-01T00:00:00Z" } as CheckPublicationRow;

describe("mergeLifecycleFor", () => {
  it("marks exact-SHA success ready", () => {
    expect(mergeLifecycleFor(job, pub, false)).toMatchObject({ state: "ready", nativeUrl: pub.native_url });
  });
  it("distinguishes forge-native scheduled auto-merge after readiness success", () => {
    expect(mergeLifecycleFor(job, pub, false, true)).toMatchObject({ state: "scheduled_auto_merge" });
    expect(mergeLifecycleFor(job, { ...pub, status: "in_progress", conclusion: null }, false, true).state).toBe("scheduled_auto_merge");
    expect(mergeLifecycleFor(job, pub, false, false).state).toBe("ready");
  });
  it("never reports merged before forge confirmation", () => {
    expect(mergeLifecycleFor(job, pub, false).state).not.toBe("merged");
    expect(mergeLifecycleFor(job, pub, true).state).toBe("merged");
  });
  it("maps missing, failed, blocked, and stale inputs distinctly", () => {
    expect(mergeLifecycleFor(job, undefined, false).state).toBe("failed");
    expect(mergeLifecycleFor(job, { ...pub, conclusion: "failure" }, false).state).toBe("blocked");
    expect(mergeLifecycleFor(job, { ...pub, conclusion: "action_required" }, false).state).toBe("failed");
    expect(mergeLifecycleFor({ ...job, state: "stale" }, pub, false).state).toBe("stale");
  });
  it("fails closed when readiness was computed but native publication failed or never finished", () => {
    const failedPublish = { ...pub, publish_error: "network timeout" } as CheckPublicationRow;
    const lifecycle = mergeLifecycleFor(job, failedPublish, false);
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.detail).toContain("network timeout");

    const unfinished = { ...pub, published_at: null } as CheckPublicationRow;
    expect(mergeLifecycleFor(job, unfinished, false).state).toBe("failed");
  });
});
