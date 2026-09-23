import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { ModelDiscovery, parseModelList } from "./models.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(
  script: (child: FakeChild) => void,
): { fn: (bin: string, args: string[], opts: unknown) => ChildProcess; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    fn: (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      const child = new FakeChild();
      queueMicrotask(() => script(child));
      return child as unknown as ChildProcess;
    },
  };
}

describe("parseModelList", () => {
  it("keeps provider/model lines and drops prose, blanks, and ANSI noise", () => {
    const out = parseModelList(
      "\x1b[32manthropic/claude-4.5-sonnet\x1b[0m\nopenai/gpt-4o\n\nModels listed: 2\nnot-a-model line\nopencode/grok-code\n",
    );
    expect(out).toEqual(["anthropic/claude-4.5-sonnet", "openai/gpt-4o", "opencode/grok-code"]);
  });
});

describe("ModelDiscovery", () => {
  it("caches models from a successful refresh", async () => {
    const { fn, calls } = fakeSpawn((child) => {
      child.stdout.end("anthropic/claude-4.5-sonnet\nopenai/gpt-4o\n");
      child.emit("close", 0);
    });
    const discovery = new ModelDiscovery("/opt/opencode/bin/opencode", {}, fn, 1000);
    const snap = await discovery.refresh();
    expect(calls).toEqual([["/opt/opencode/bin/opencode", "models"]]);
    expect(snap.models).toEqual(["anthropic/claude-4.5-sonnet", "openai/gpt-4o"]);
    expect(snap.error).toBeUndefined();
    expect(snap.fetchedAt).toBeGreaterThan(0);
  });

  it("shares one in-flight refresh across concurrent callers", async () => {
    const { fn, calls } = fakeSpawn((child) => {
      child.stdout.end("anthropic/claude-4.5-sonnet\n");
      child.emit("close", 0);
    });
    const discovery = new ModelDiscovery("opencode", {}, fn, 1000);
    const [a, b] = await Promise.all([discovery.refresh(), discovery.refresh()]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("keeps the previous cache and records the error when the binary is missing", async () => {
    let fail = false;
    const { fn } = fakeSpawn((child) => {
      if (fail) {
        child.emit("error", new Error("spawn /missing ENOENT"));
      } else {
        child.stdout.end("anthropic/claude-4.5-sonnet\n");
        child.emit("close", 0);
      }
    });
    const discovery = new ModelDiscovery("opencode", {}, fn, 1000);
    await discovery.refresh();
    fail = true;
    const snap = await discovery.refresh();
    expect(snap.models).toEqual(["anthropic/claude-4.5-sonnet"]);
    expect(snap.error).toContain("ENOENT");
  });

  it("records stderr context on a non-zero exit", async () => {
    const { fn } = fakeSpawn((child) => {
      child.stderr.end("boom: providers unavailable");
      child.emit("close", 2);
    });
    const discovery = new ModelDiscovery("opencode", {}, fn, 1000);
    const snap = await discovery.refresh();
    expect(snap.error).toContain("exited 2");
    expect(snap.error).toContain("boom: providers unavailable");
  });

  it("records an error when the child never finishes", async () => {
    const { fn } = fakeSpawn(() => {
      /* hangs */
    });
    const discovery = new ModelDiscovery("opencode", {}, fn, 20);
    const snap = await discovery.refresh();
    expect(snap.error).toContain("timed out");
  });
});
