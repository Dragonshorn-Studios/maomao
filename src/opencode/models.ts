/**
 * Live model discovery via `opencode models`. The CLI prints one
 * `provider/model` id per line for providers configured in its credential
 * store (auth.json + env keys), which is exactly the set an operator can
 * actually run — the profile editor merges this list with MODEL_CATALOG
 * into a datalist. Discovery is asynchronous and cached: the UI reads
 * `snapshot()` synchronously, `refresh()` is fired at boot and from a
 * manual control. A missing or failing binary only degrades the list back
 * to the configured catalog — free-text entry always keeps working.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeChildEnv } from "./env.js";

const MODEL_LINE = /^[a-z0-9][a-z0-9._-]*\/\S+$/i;
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export interface ModelSnapshot {
  /** provider/model ids from the last successful refresh. */
  models: string[];
  /** Epoch ms of the last successful refresh; 0 while none has succeeded. */
  fetchedAt: number;
  /** Why the most recent refresh failed; cleared on success. */
  error?: string;
}

export function parseModelList(stdout: string): string[] {
  const models: string[] = [];
  for (const raw of stdout.replace(ANSI_ESCAPE, "").split("\n")) {
    const line = raw.trim();
    if (MODEL_LINE.test(line)) models.push(line);
  }
  return models;
}

type SpawnFn = (bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;

export class ModelDiscovery {
  private models: string[] = [];
  private fetchedAt = 0;
  private error: string | undefined;
  private pending: Promise<ModelSnapshot> | null = null;

  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly spawnFn: SpawnFn = spawn,
    private readonly timeoutMs = 15_000,
  ) {}

  snapshot(): ModelSnapshot {
    return { models: this.models, fetchedAt: this.fetchedAt, error: this.error };
  }

  /** Spawns `<bin> models` and caches the parsed list. Concurrent callers
   * share one refresh; a failure keeps the previous cache and records the
   * error for the UI. Never rejects — the snapshot carries the error. */
  refresh(): Promise<ModelSnapshot> {
    this.pending ??= this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private run(): Promise<ModelSnapshot> {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) {
          this.models = parseModelList(stdout);
          this.fetchedAt = Date.now();
          this.error = undefined;
        } else {
          this.error = error;
        }
        resolve(this.snapshot());
      };
      const child = this.spawnFn(this.bin, ["models"], {
        env: sanitizeChildEnv(this.env),
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(`opencode models timed out after ${Math.round(this.timeoutMs / 1000)}s`);
      }, this.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => finish(`could not run ${this.bin}: ${err.message}`));
      child.on("close", (code) => {
        if (code === 0) {
          finish();
        } else {
          finish(`opencode models exited ${code ?? "without a code"}: ${stderr.trim().slice(0, 200) || "no output"}`);
        }
      });
    });
  }
}
