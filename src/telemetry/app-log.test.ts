import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAppLog, setAppLogSink } from "./app-log.js";
import { flushIngestPosts } from "./ingest.js";
import { TelemetrySettingsStore } from "./settings.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lines: string[] = [];
const capture = (line: string) => {
  lines.push(line);
};

function storeWithShared(): TelemetrySettingsStore {
  const path = join(mkdtempSync(join(tmpdir(), "maomao-applog-")), "telemetry.json");
  const store = new TelemetrySettingsStore(path);
  store.setShared({
    baseUrl: "https://oo.example.com/api/default",
    stream: "maomao",
    email: "ops@oo.example.com",
    token: "o2oi_applog",
  });
  return store;
}

afterEach(async () => {
  lines.length = 0;
  setAppLogSink((line) => process.stdout.write(`${line}\n`));
  await flushIngestPosts();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("emitAppLog", () => {
  it("writes a structured maomao.<event> line to the stdout sink", () => {
    setAppLogSink(capture);
    emitAppLog("app_boot", { port: 3200 }, {} as NodeJS.ProcessEnv);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]);
    expect(payload.event).toBe("maomao.app_boot");
    expect(payload.port).toBe(3200);
    expect(payload._timestamp).toBeTypeOf("string");
  });

  it("does not call fetch when the logs channel resolves to nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setAppLogSink(capture);
    emitAppLog("app_boot", {}, {} as NodeJS.ProcessEnv);
    await flushIngestPosts();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
  });

  it("POSTs the event to a derived logs endpoint from stored shared config", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setAppLogSink(capture);
    const store = storeWithShared();
    emitAppLog("telemetry_export_failed", { signal: "traces", status: 404 }, {} as NodeJS.ProcessEnv, undefined, store.shared());
    await flushIngestPosts();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oo.example.com/api/default/maomao/_json");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("ops@oo.example.com:o2oi_applog").toString("base64")}`,
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>[];
    expect(body[0].event).toBe("maomao.telemetry_export_failed");
    expect(JSON.stringify(body)).not.toContain("o2oi_applog");
  });

  it("survives a throwing sink and still delivers the POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setAppLogSink(() => {
      throw new Error("stdout exploded");
    });
    emitAppLog(
      "job_started",
      { job_id: 7 },
      { OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/x/_json" } as NodeJS.ProcessEnv,
    );
    await flushIngestPosts();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
