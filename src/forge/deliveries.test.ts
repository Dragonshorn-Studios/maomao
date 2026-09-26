import { describe, expect, it } from "vitest";
import { enqueueClaimResult } from "./deliveries.js";

describe("enqueueClaimResult", () => {
  it("formats the shared enqueue claim vocabulary", () => {
    expect(enqueueClaimResult({ created: true })).toBe("enqueued");
    expect(enqueueClaimResult({ created: false, skippedReason: "job already exists for this SHA" })).toBe(
      "skipped: job already exists for this SHA",
    );
    expect(enqueueClaimResult({ created: false })).toBe("skipped");
  });
});
