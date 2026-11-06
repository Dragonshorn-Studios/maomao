/**
 * Starts the workbench for the browser suite.
 *
 * Playwright's own `webServer` probes the URL *before* it starts anything.
 * On hosts where a recently closed port stops answering (a closed port that
 * drops SYNs instead of rejecting them), that probe waits for a TCP timeout
 * and the suite appears to hang for minutes. Starting the server here binds
 * the port first and waits for the server's own readiness line, so the suite
 * never probes a port that has no listener.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The line the workbench prints once it listens. */
const READY_LINE = "UI workbench on";

/** The port the suite uses. It must match `playwright.config.ts`. */
const PORT = process.env.MAOMAO_UI_WORKBENCH_PORT ?? "4311";

export default async function globalSetup(): Promise<() => Promise<void>> {
  // The React chat island is served from the built bundle.
  // On Windows the npm launcher is `npm.cmd`, and it is not a shell script.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", "build:vendor"], { cwd: REPO_ROOT, stdio: "inherit" });

  const child = spawn(process.execPath, ["--import", "tsx", "src/ui-workbench/dev.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, MAOMAO_UI_WORKBENCH_PORT: PORT },
    stdio: ["ignore", "pipe", "inherit"],
  });

  await waitForReady(child);
  console.log("UI workbench ready for the browser suite.");

  return async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
}

/** Waits for the server to print that it is listening. */
function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The UI workbench did not start within 60s."));
    }, 60_000);

    const onData = (chunk: Buffer) => {
      if (!chunk.toString().includes(READY_LINE)) return;
      cleanup();
      resolve();
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`The UI workbench exited with code ${code} before it was ready.`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout?.on("data", onData);
    child.on("exit", onExit);
  });
}
