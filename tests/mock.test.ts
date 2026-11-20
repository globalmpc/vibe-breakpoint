import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const server = resolve("plugins/vibe-breakpoint/templates/mock/server.mjs");
const procs: ChildProcess[] = [];

async function start(latency = "0"): Promise<string> {
  const port = await new Promise<number>((r) => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const c = spawn("node", [server], { env: { ...process.env, MOCK_PORT: String(port), MOCK_LATENCY_MS: latency }, stdio: "ignore" });
  procs.push(c);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + "/__vb/health"); return base; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("mock did not start");
}
afterAll(() => procs.forEach((p) => p.kill()));

describe("mock server (AC3)", () => {
  let base: string;
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
  beforeAll(async () => { base = await start(); });

  it("canned shapes", async () => {
    expect(typeof (await post("/v1/chat/completions")).choices[0].message.content).toBe("string");
    expect(typeof (await post("/v1/responses")).output[0].content[0].text).toBe("string");
    expect((await post("/v1/embeddings", { input: ["a", "b"] })).data).toHaveLength(2);
    expect(typeof (await post("/v1/messages")).content[0].text).toBe("string");
    const c = await post("/v1/customers");
    expect(c.id).toMatch(/^cus_/);
    expect(c.object).toBe("customer");
    expect(typeof (await post("/emails")).id).toBe("string");
  });

  it("unknown is logged, internal endpoints are not, keys are exact", async () => {
    const r = await fetch(base + "/nope?x=1");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    const log = await fetch(base + "/__vb/log").then((x) => x.json() as Promise<any>);
    expect(log.schema).toBe(1);
    expect(log.calls.find((c: any) => c.service === "unknown")).toEqual({ service: "unknown", method: "GET", path: "/nope", count: 1 });
    expect(log.calls.some((c: any) => c.path.startsWith("/__vb"))).toBe(false);
    for (const c of log.calls) expect(Object.keys(c).sort()).toEqual(["count", "method", "path", "service"]);
  });

  it("latency", async () => {
    const slow = await start("200");
    const t = Date.now();
    await fetch(slow + "/v1/chat/completions", { method: "POST", body: "{}" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(190);
  });
});
