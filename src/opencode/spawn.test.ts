import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOpenCodeArgs,
  createOpenCodeRunner,
  detectOpenCodeMajor,
  OPENCODE_PROMPT_STDIN_THRESHOLD,
  OpenCodeTimeoutError,
} from "./spawn.js";

async function fakeBin(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maomao-bin-"));
  const path = join(dir, "fake-opencode.sh");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Fake opencode that answers `--version` and dumps argv, stdin, and env to files. */
async function recordingBin(versionOutput: string, dumpDir: string): Promise<string> {
  return fakeBin(
    `if [ "$1" = "--version" ]; then printf '%s\\n' '${versionOutput}'; exit 0; fi\n` +
      `printf '%s\\n' "$@" > '${dumpDir}/argv.txt'\ncat > '${dumpDir}/stdin.txt'\nenv > '${dumpDir}/env.txt'\n` +
      `printf '%s\\n' '{"type":"text","part":{"text":"ok"}}'`,
  );
}

describe("buildOpenCodeArgs", () => {
  it("puts the prompt after -- so --file cannot swallow it", () => {
    const prompt = "You are a specialist code reviewer working for Maomao";
    const args = buildOpenCodeArgs({
      cwd: "/data/workspaces/job-1/repo",
      model: "opencode-go/glm-5.3-flash",
      title: "maomao-correctness-1",
      files: ["/data/workspaces/job-1/pr.diff", "/data/workspaces/job-1/pr.json"],
      prompt,
    });
    const dash = args.lastIndexOf("--");
    expect(dash).toBeGreaterThan(0);
    expect(args[dash + 1]).toBe(prompt);
    expect(args.slice(0, dash).filter((arg) => arg === "--file")).toHaveLength(2);
    expect(args.slice(dash + 1)).toEqual([prompt]);
  });

  it("routes prompts past the argv per-arg limit over stdin instead of argv", () => {
    // Linux caps one argv element at 128KiB; the stack cumulative prompt
    // inlining member diffs can exceed it and the spawn dies with E2BIG.
    const huge = "x".repeat(OPENCODE_PROMPT_STDIN_THRESHOLD + 1);
    const args = buildOpenCodeArgs({ cwd: "/w", prompt: huge });
    expect(args).not.toContain(huge);
    expect(args).not.toContain("--");
  });

  it("keeps normal prompts as the argv positional below the threshold", () => {
    const prompt = "x".repeat(OPENCODE_PROMPT_STDIN_THRESHOLD - 1);
    const args = buildOpenCodeArgs({ cwd: "/w", prompt });
    expect(args[args.length - 1]).toBe(prompt);
    expect(args[args.length - 2]).toBe("--");
  });

  it("counts the threshold in UTF-8 bytes, not chars — MAX_ARG_STRLEN is bytes", () => {
    // 40k CJK chars are 120k UTF-8 bytes: over the byte threshold while the
    // char count sits under it, so argv would still die with E2BIG.
    const cjk = "真".repeat(40_000);
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThanOrEqual(OPENCODE_PROMPT_STDIN_THRESHOLD);
    const args = buildOpenCodeArgs({ cwd: "/w", prompt: cjk });
    expect(args).not.toContain(cjk);
    expect(args).not.toContain("--");
  });

  it("v2 shape: --standalone, no --dir", () => {
    const args = buildOpenCodeArgs({ cwd: "/w", prompt: "p", v2: true });
    expect(args).toContain("--standalone");
    expect(args).not.toContain("--dir");
    expect(args).not.toContain("/w");
    expect(args[args.length - 1]).toBe("p");
  });

  it("v1 shape: --dir kept, no --standalone", () => {
    const args = buildOpenCodeArgs({ cwd: "/w", prompt: "p" });
    expect(args).not.toContain("--standalone");
    expect(args).toContain("--dir");
    expect(args[args.length - 1]).toBe("p");
  });
});

describe("detectOpenCodeMajor", () => {
  it("parses v1 and v2 --version output", async () => {
    expect(await detectOpenCodeMajor(await fakeBin("printf '1.18.31\\n'"))).toBe(1);
    expect(await detectOpenCodeMajor(await fakeBin("printf 'opencode v2.1.4\\n'"))).toBe(2);
  });

  it("does not mistake v1 minors like 1.2.x / 1.22.x for v2", async () => {
    // The version token must be anchored: an unanchored "2." also matches
    // v1 releases whose minor is 2, 12, 22, 32… and misroutes them onto the
    // v2 invocation (v1 rejects --standalone and loses the permission env).
    for (const version of ["1.2.0", "1.12.2", "1.22.3", "1.32.5"]) {
      expect(await detectOpenCodeMajor(await fakeBin(`printf '${version}\\n'`))).toBe(1);
    }
    expect(await detectOpenCodeMajor(await fakeBin("printf '2.0.32\\n'"))).toBe(2);
  });

  it("falls back to v1 when the binary cannot run", async () => {
    expect(await detectOpenCodeMajor("/nonexistent/opencode")).toBe(1);
  });
});

describe("createOpenCodeRunner opencode 2 compatibility", () => {
  it("spawns v2 with --standalone, strips repo config variants, and pins the deny-list", async () => {
    const ws = await mkdtemp(join(tmpdir(), "maomao-ws-"));
    // A hostile PR ships both higher-precedence config variants: verified
    // against opencode v2.1.4, either one beats a root opencode.json.
    const allowAll = JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    await mkdir(join(ws, ".opencode"), { recursive: true });
    await writeFile(join(ws, ".opencode", "opencode.json"), allowAll);
    await writeFile(join(ws, "opencode.jsonc"), allowAll);
    const bin = await recordingBin("opencode v2.1.4", ws);
    const result = await createOpenCodeRunner().run({ cwd: ws, model: "m", prompt: "p", timeoutMs: 10000, bin });
    expect(result.exitCode).toBe(0);
    const argv = (await readFile(join(ws, "argv.txt"), "utf8")).split("\n");
    expect(argv).toContain("--standalone");
    expect(argv).not.toContain("--dir");
    expect(argv).not.toContain(ws);
    // v2 dropped the env permission channel — only TERM rides along.
    const envOut = await readFile(join(ws, "env.txt"), "utf8");
    expect(envOut).not.toContain("OPENCODE_PERMISSION");
    expect(envOut).not.toContain("OPENCODE_CONFIG_CONTENT");
    // The repo config variants are gone; the workspace pin is ours.
    await expect(readFile(join(ws, ".opencode", "opencode.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(ws, "opencode.jsonc"), "utf8")).rejects.toThrow();
    const pinned = JSON.parse(await readFile(join(ws, "opencode.json"), "utf8")) as {
      permissions: { action: string; effect: string }[];
    };
    expect(pinned.permissions.find((rule) => rule.action === "*")?.effect).toBe("deny");
    expect(pinned.permissions.find((rule) => rule.action === "read")?.effect).toBe("allow");
    expect(pinned.permissions.find((rule) => rule.action === "shell")?.effect).toBe("deny");
  });

  it("delivers an oversized prompt via stdin on v2 with no argv positional", async () => {
    const ws = await mkdtemp(join(tmpdir(), "maomao-ws-"));
    const bin = await recordingBin("opencode v2.1.4", ws);
    const prompt = "x".repeat(OPENCODE_PROMPT_STDIN_THRESHOLD + 10);
    const result = await createOpenCodeRunner().run({ cwd: ws, model: "m", prompt, timeoutMs: 10_000, bin });
    expect(result.exitCode).toBe(0);
    const argv = (await readFile(join(ws, "argv.txt"), "utf8")).split("\n");
    expect(argv).toContain("--standalone");
    expect(argv).not.toContain(prompt);
    expect(argv).not.toContain("--");
    expect(await readFile(join(ws, "stdin.txt"), "utf8")).toBe(prompt);
  });

  it("spawns v1 with --dir and the env permission channel, writing no config file", async () => {
    const ws = await mkdtemp(join(tmpdir(), "maomao-ws-"));
    const bin = await recordingBin("1.18.31", ws);
    const result = await createOpenCodeRunner().run({ cwd: ws, model: "m", prompt: "p", timeoutMs: 10000, bin });
    expect(result.exitCode).toBe(0);
    const argv = (await readFile(join(ws, "argv.txt"), "utf8")).split("\n");
    expect(argv).not.toContain("--standalone");
    expect(argv).toContain("--dir");
    expect(argv).toContain(ws);
    const envOut = await readFile(join(ws, "env.txt"), "utf8");
    expect(envOut).toContain("OPENCODE_PERMISSION=");
    expect(envOut).toContain("OPENCODE_CONFIG_CONTENT=");
    await expect(readFile(join(ws, "opencode.json"), "utf8")).rejects.toThrow();
  });
});

describe("createOpenCodeRunner firstOutputMs", () => {
  it("measures spawn to first stdout byte", async () => {
    const bin = await fakeBin(`sleep 0.2\nprintf '%s\\n' '{"type":"text","part":{"text":"hi"}}'`);
    const result = await createOpenCodeRunner().run({
      cwd: process.cwd(),
      model: "m",
      prompt: "p",
      timeoutMs: 10000,
      bin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.firstOutputMs).toBeGreaterThanOrEqual(100);
    expect(result.firstOutputMs).toBeLessThan(5000);
  });

  it("stays undefined when the child never writes to stdout", async () => {
    const bin = await fakeBin("exit 0");
    const result = await createOpenCodeRunner().run({
      cwd: process.cwd(),
      model: "m",
      prompt: "p",
      timeoutMs: 10000,
      bin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.firstOutputMs).toBeUndefined();
  });
});

describe("createOpenCodeRunner timeout forensics", () => {
  it("carries captured, redacted output on the timeout rejection", async () => {
    const bin = await fakeBin(
      `if [ "$1" = "--version" ]; then printf '1.18.31\\n'; exit 0; fi\n` +
        `printf '%s\\n' '{"type":"text","text":"partial thinking"}'\nprintf 'token=sk-live-abcdef123456\\n' >&2\nsleep 5`,
    );
    const error: OpenCodeTimeoutError = await createOpenCodeRunner()
      .run({
        cwd: process.cwd(),
        model: "m",
        prompt: "p",
        timeoutMs: 400,
        bin,
        env: { LEAKED: "sk-live-abcdef123456" },
      })
      .then(
        () => {
          throw new Error("expected the run to time out");
        },
        (cause) => cause,
      );
    expect(error).toBeInstanceOf(OpenCodeTimeoutError);
    expect(error.message).toContain("timed out after 400ms");
    expect(error.stdout).toContain("partial thinking");
    expect(error.stderr).toContain("[redacted]");
    expect(error.stderr).not.toContain("sk-live-abcdef123456");
    expect(error.firstOutputMs).toBeDefined();
    expect(error.firstOutputMs!).toBeLessThan(400);
  });

  it("survives a child that exits before draining the piped prompt (EPIPE)", async () => {
    // Without an error listener on stdin, the pending buffered write after a
    // child exit is an unhandled 'error' event that kills the whole process.
    const bin = await fakeBin("exit 0");
    const result = await createOpenCodeRunner().run({
      cwd: process.cwd(),
      model: "m",
      prompt: "x".repeat(OPENCODE_PROMPT_STDIN_THRESHOLD + 10),
      timeoutMs: 10_000,
      bin,
    });
    expect(result.exitCode).toBe(0);
  });

  it("delivers an oversized prompt via stdin instead of argv", async () => {
    const dump = join(tmpdir(), `maomao-stdin-${process.pid}-${Date.now()}.txt`);
    const bin = await fakeBin(`cat > '${dump}'`);
    const prompt = "x".repeat(OPENCODE_PROMPT_STDIN_THRESHOLD + 10);
    const result = await createOpenCodeRunner().run({
      cwd: process.cwd(),
      model: "m",
      prompt,
      timeoutMs: 10000,
      bin,
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(dump, "utf8")).toBe(prompt);
    await rm(dump, { force: true });
  });
});
