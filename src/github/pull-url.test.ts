import { describe, expect, it } from "vitest";
import { parseGithubPullUrl, PullUrlError } from "./pull-url.js";

describe("parseGithubPullUrl", () => {
  it("parses owner/repo/number from github.com PR URLs", () => {
    expect(parseGithubPullUrl("https://github.com/acme/widgets/pull/123")).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 123,
    });
    expect(parseGithubPullUrl("https://www.github.com/acme/widgets/pull/123/files")).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 123,
    });
  });

  it("rejects non-GitHub and malformed URLs", () => {
    expect(() => parseGithubPullUrl("")).toThrow(PullUrlError);
    expect(() => parseGithubPullUrl("not a url")).toThrow(/valid URL/);
    expect(() => parseGithubPullUrl("https://gitlab.com/acme/widgets/pull/1")).toThrow(/github.com/);
    expect(() => parseGithubPullUrl("https://github.com/acme/widgets")).toThrow(/pull\/123/);
    expect(() => parseGithubPullUrl("https://github.com/acme/widgets/issues/1")).toThrow(/pull\/123/);
  });
});
