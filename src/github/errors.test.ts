import { describe, expect, it } from "vitest";
import { describeGithubError, githubRetryReason, isMissingGithubNodeError } from "./errors.js";

describe("describeGithubError", () => {
  it("pulls GraphQL error messages out of the Octokit wrapper", () => {
    const error = Object.assign(new Error("Request failed due to following response errors:\n - hidden"), {
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      status: 403,
    });
    expect(describeGithubError(error)).toBe(
      "GitHub App lacks permission: Resource not accessible by integration",
    );
  });

  it("strips docs URLs from REST messages", () => {
    const error = Object.assign(new Error("API rate limit exceeded for installation - https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting"), {
      status: 403,
    });
    expect(describeGithubError(error)).toBe("GitHub rate limited the app: API rate limit exceeded for installation");
  });

  it("keeps a plain Error message when it is already specific", () => {
    expect(describeGithubError(new Error("GitHub 502"))).toBe("GitHub 502");
  });
});

describe("isMissingGithubNodeError", () => {
  it("recognizes GraphQL NOT_FOUND and the usual node-id wording", () => {
    expect(
      isMissingGithubNodeError(
        Object.assign(new Error("Request failed"), {
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'PRRT_x'" }],
        }),
      ),
    ).toBe(true);
    expect(isMissingGithubNodeError(new Error("Could not resolve to a node with the global id of 'PRRT_x'"))).toBe(
      true,
    );
    expect(isMissingGithubNodeError(new Error("Resource not accessible by integration"))).toBe(false);
  });
});

describe("githubRetryReason", () => {
  it("keeps the retry note and includes the GitHub detail", () => {
    const error = Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
    expect(githubRetryReason("thread", error)).toBe(
      "GitHub resolve failed (GitHub App lacks permission: Resource not accessible by integration); will retry next review.",
    );
    expect(githubRetryReason("issue", "GitHub 502")).toBe(
      "GitHub issue close failed (GitHub 502); will retry next scan.",
    );
  });
});
