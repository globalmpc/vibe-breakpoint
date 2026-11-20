import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeFile } from "../src/sandbox/compose.js";
import { aggregate, breakingPoint, buildResult, isBroken, limitingResource, parseDuration, parseStages, parseStatsLine, stageFromSummary, type Stage } from "../src/load/result.js";
import { loadConfig, parseScenario } from "../src/load/scenario.js";
import { parseSeed } from "../src/seed/seed.js";

const seed = parseSeed(readFileSync("fixtures/express-pg/expected/seed.json", "utf8"));
const rec = (n: string) => JSON.parse(readFileSync(`tests/load/${n}.json`, "utf8"));
const healthy = rec("k6-healthy-40");
const slow = rec("k6-slow-40");
const st = (users: number, p95: number | null, err = 0, extra: Partial<Stage> = {}): Stage => ({ users, p50_ms: 1, p95_ms: p95, error_rate: err, requests: 10, app_cpu: 0.1, db_cpu: 0.1, app_mem_mb: 50, ...extra });
const flow = (o: object) => JSON.stringify({ schema: 1, flow: [{ name: "a", method: "GET", path: "/x" }], ...o });
const step = (o: object) => flow({ flow: [{ name: "a", method: "GET", path: "/x", ...o }] });

describe("parseScenario", () => {
  it("accepts a valid scenario with defaults", () => {
    const s = parseScenario(JSON.stringify({ schema: 1, flow: [{ name: "login", method: "POST", path: "/l", body: { e: "{{user.email}}", p: "{{user.password}}" }, save: { cookie: true } }, { name: "s", method: "GET", path: "/u?e={{random.email}}" }], probe_endpoints: ["s"] }), seed);
    expect(s.think_time_s).toBe(1);
  });
  it.each([
    ["absolute url", step({ path: "http://x/" }), /path/],
    ["protocol-relative", step({ path: "//x" }), /path/],
    ["unknown placeholder", step({ path: "/{{foo}}" }), /foo/],
    ["TRACE", step({ method: "TRACE" }), /method/],
    ["duplicate name", flow({ flow: [{ name: "a", method: "GET", path: "/x" }, { name: "a", method: "GET", path: "/y" }] }), /duplicate/],
    ["unknown probe", flow({ probe_endpoints: ["nope"] }), /probe_endpoints/],
    ["only cookie steps", step({ save: { cookie: true } }), /at least one/],
    ["think time", flow({ think_time_s: 61 }), /think_time_s/],
    ["bad schema", JSON.stringify({ schema: 2, flow: [] }), /schema/],
    ["not json", "{", /invalid JSON/],
  ])("rejects %s", (_n, text, re) => {
    expect(() => parseScenario(text, seed)).toThrow(/^scenario\.json: /);
    expect(() => parseScenario(text, seed)).toThrow(re);
  });
  it("rejects user placeholder without test_users, and random.email without seed", () => {
    const noUsers = { ...seed, test_users: undefined };
    expect(() => parseScenario(step({ path: "/{{user.email}}" }), noUsers)).toThrow(/test_users/);
    expect(() => parseScenario(step({ path: "/{{user.email}}" }))).toThrow(/test_users/);
    expect(() => parseScenario(step({ path: "/{{random.email}}" }))).toThrow(/email column/);
  });
});

describe("loadConfig", () => {
  it("fixes base, uses seed values and size rows", () => {
    const sc = parseScenario(step({ path: "/{{random.email}}" }), seed);
    expect(loadConfig(sc, seed, "M")).toMatchObject({ base: "http://app:3000", test_users: 50, password: "vb-test-password", email_rows: 1000 });
    expect(loadConfig(sc, undefined, null)).toMatchObject({ test_users: 0, password: "", email_rows: 1 });
  });
});

describe("parseStages / parseDuration", () => {
  it("defaults parse and invalid rejected", () => {
    expect(parseStages("10,25,50,100,200,400")).toEqual([10, 25, 50, 100, 200, 400]);
    for (const b of ["10,0", "25,10", "abc", "10,10", "1001", ""]) expect(() => parseStages(b)).toThrow(/invalid --stages/);
    expect(parseDuration("60")).toBe(60);
    for (const b of ["0", "601", "x"]) expect(() => parseDuration(b)).toThrow(/invalid --stage-duration/);
  });
});

describe("stageFromSummary (recorded k6 summaries)", () => {
  it("healthy is not broken, slow is broken", () => {
    const h = stageFromSummary(healthy, 40);
    const s = stageFromSummary(slow, 40);
    expect(isBroken(h)).toBe(false);
    expect(isBroken(s)).toBe(true);
    expect(s.p95_ms!).toBeGreaterThan(2000);
    expect(h.requests).toBeGreaterThan(0);
  });
  it("zero requests is broken with error_rate 1", () => {
    const z = JSON.parse(JSON.stringify(healthy));
    z.metrics.http_reqs.values.count = 0;
    const s = stageFromSummary(z, 5);
    expect(s).toEqual({ users: 5, p50_ms: null, p95_ms: null, error_rate: 1, requests: 0 });
    expect(isBroken(s)).toBe(true);
  });
  it("zero requests without http_req_duration is the broken stage (N6)", () => {
    expect(stageFromSummary({ metrics: { http_reqs: { values: { count: 0 } } } }, 5)).toEqual({ users: 5, p50_ms: null, p95_ms: null, error_rate: 1, requests: 0 });
  });
  it("throws a clear error when requests ran but http_req_duration is missing", () => {
    expect(() => stageFromSummary({ metrics: { http_reqs: { values: { count: 10 } } } }, 1)).toThrow(/http_req_duration/);
  });
});

describe("isBroken / breakingPoint", () => {
  it("boundaries are strict", () => {
    expect(isBroken(st(1, 2000))).toBe(false);
    expect(isBroken(st(1, 2000.1))).toBe(true);
    expect(isBroken(st(1, 1, 0.01))).toBe(false);
    expect(isBroken(st(1, 1, 0.0101))).toBe(true);
  });
  it("first break, users_ok, null, reasons", () => {
    expect(breakingPoint([st(10, 5000), st(25, 5000)])).toEqual({ users_ok: 0, users_broke: 10, reason: "p95" });
    expect(breakingPoint([st(10, 5), st(25, 5, 0.5)])).toEqual({ users_ok: 10, users_broke: 25, reason: "error_rate" });
    expect(breakingPoint([st(10, 5), st(25, 5000, 0.5)])?.reason).toBe("p95_and_error_rate");
    expect(breakingPoint([st(10, 5), st(25, 5)])).toBeNull();
    expect(breakingPoint([st(10, null, 1)])?.reason).toBe("p95_and_error_rate");
  });
  it("recorded slow vs healthy: slow breaks at a lower stage", () => {
    const h = stageFromSummary(healthy, 40);
    const s = stageFromSummary(slow, 40);
    const ok = { app_cpu: 0.1, db_cpu: 0.1, app_mem_mb: 50 };
    expect(breakingPoint([{ ...h, ...ok }])).toBeNull();
    expect(breakingPoint([st(5, 1000), { ...s, ...ok }])).toEqual({ users_ok: 5, users_broke: 40, reason: "p95" });
  });
});

describe("parseStatsLine / aggregate", () => {
  it("parses units", () => {
    expect(parseStatsLine("12.5%", "1.2GiB / 1GiB")).toEqual({ cpu: 0.125, memMb: 1228.8 });
    expect(parseStatsLine("0.00%", "88.5MiB / 1GiB").memMb).toBe(88.5);
    expect(parseStatsLine("100%", "1024kB / 1GiB").memMb).toBe(1);
    expect(parseStatsLine("1%", "1048576B / 1GiB").memMb).toBe(1);
    expect(() => parseStatsLine("x", "y")).toThrow();
  });
  it("cpu as fraction of the limit, memory max, null without samples", () => {
    expect(aggregate({ app: [{ cpu: 0.2, memMb: 10 }, { cpu: 0.4, memMb: 90.4 }], db: [{ cpu: 0.25, memMb: 1 }] }, "tiny")).toEqual({ app_cpu: 0.6, db_cpu: 0.5, app_mem_mb: 90 });
    expect(aggregate({ app: [], db: [] }, "small")).toEqual({ app_cpu: null, db_cpu: null, app_mem_mb: null });
  });
});

describe("limitingResource", () => {
  const lr = (app_cpu: number | null, db_cpu: number | null, app_mem_mb: number | null) => limitingResource({ app_cpu, db_cpu, app_mem_mb }, "small");
  it("picks the most saturated, else app_code, else null", () => {
    expect(lr(0.9, 0.1, 50)).toBe("app_cpu");
    expect(lr(0.9, 0.95, 50)).toBe("db_cpu");
    expect(lr(0.5, 0.5, 50)).toBe("app_code");
    expect(lr(0.1, 0.1, 900)).toBe("memory");
    expect(lr(null, null, null)).toBeNull();
  });
});

describe("buildResult / compose", () => {
  it("has exactly the contract keys", () => {
    const r = buildResult({ runId: "vb-20260101000000-abcd", toolVersion: "1.0.0", profile: "small", size: "M", stageDurationS: 5, thinkTimeS: 0, stages: [st(5, 100), st(40, 5000)] });
    expect(Object.keys(r).sort()).toEqual(["breaking_point", "flags", "limiting_resource", "probe", "profile", "run_id", "schema", "size", "stage_duration_s", "stages", "think_time_s", "tool_version"]);
    expect(Object.keys(r.stages[0]).sort()).toEqual(["app_cpu", "app_mem_mb", "db_cpu", "error_rate", "p50_ms", "p95_ms", "requests", "users"]);
    expect(r.breaking_point).toEqual({ users_ok: 5, users_broke: 40, reason: "p95" });
    expect(r.limiting_resource).toBe("app_code");
    expect(buildResult({ runId: "r", toolVersion: "1", profile: "small", size: null, stageDurationS: 1, thinkTimeS: 0, stages: [st(5, 1)] })).toMatchObject({ breaking_point: null, limiting_resource: null });
  });
  it("k6 service stays isolated", () => {
    const f = composeFile({ runId: "vb-20260101000000-abcd", profile: "small", dbPassword: "x", envFile: "/e", mockDir: "/m", app: { context: "/c", dockerfile: "/d", healthPath: "/" } }) as any;
    expect(f.services.k6).toMatchObject({ image: "grafana/k6", networks: ["vb-net"], profiles: ["load"], environment: { K6_NO_USAGE_REPORT: "true" } });
    expect(f.services.k6.ports).toBeUndefined();
    expect(f.services.k6.labels["vibe-breakpoint.run"]).toBe("vb-20260101000000-abcd");
  });
});

describe("pr1 fixes", () => {
  it("compose escapes $ in the health path (AC3)", () => {
    const f = composeFile({ runId: "vb-20260101000000-abcd", profile: "small", dbPassword: "x", envFile: "/e", mockDir: "/m", app: { context: "/c", dockerfile: "/d", healthPath: "/${AWS_SECRET_ACCESS_KEY}" } }) as any;
    const t: string = f.services.app.healthcheck.test[3];
    expect(t).toContain("$${AWS_SECRET_ACCESS_KEY}");
    expect(t.replaceAll("$$", "")).not.toContain("${");
  });
  it("rejects {{user.email}} when the password table has no email generator (AC5)", () => {
    const s = JSON.parse(readFileSync("fixtures/express-pg/expected/seed.json", "utf8"));
    s.tables[0].columns.email = { gen: "auto" };
    const sc = JSON.stringify({ schema: 1, flow: [{ name: "a", method: "POST", path: "/x", body: { e: "{{user.email}}" } }] });
    expect(() => parseScenario(sc, s as any)).toThrow(/^scenario\.json: /);
  });
});

describe("rounding before classification (B1)", () => {
  it("251 failed of 25000 is broken (error_rate) but result.json keeps 4 decimals", () => {
    const summary = { metrics: { http_reqs: { values: { count: 25000 } }, http_req_duration: { values: { med: 5, "p(95)": 10 } }, http_req_failed: { values: { rate: 251 / 25000 } } } };
    const stage = { ...stageFromSummary(summary, 10), app_cpu: null, db_cpu: null, app_mem_mb: null };
    expect(stage.error_rate).toBe(0.01);
    expect(isBroken(stage)).toBe(true);
    expect(breakingPoint([stage])?.reason).toBe("error_rate");
    const r = buildResult({ runId: "r", toolVersion: "0", profile: "small", size: null, stageDurationS: 1, thinkTimeS: 1, stages: [stage] });
    expect(r.breaking_point?.reason).toBe("error_rate");
    expect(r.stages[0]).not.toHaveProperty("raw_error_rate");
    expect(r.stages[0].error_rate).toBe(0.01);
  });
});
