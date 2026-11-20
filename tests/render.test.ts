import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildResult } from "../src/load/result.js";
import { chartSvg, projectLabel, resultError, worstEndpoint } from "../src/render/chart.js";
import { reportMd } from "../src/render/report.js";
import { svgToPng } from "../src/render/png.js";

const assets = "plugins/vibe-breakpoint/assets";
const st = (users: number, p95: number | null, err = 0) => ({ users, p50_ms: 10, p95_ms: p95, error_rate: err, requests: 100, app_cpu: 0.3, db_cpu: 0.2, app_mem_mb: 100 });
const pe = (q: number, ms: number, rows = 1) => ({ queries_per_req: q, db_ms_per_req: ms, rows_per_req: rows, top_queries: [{ query: "SELECT FAKESECRET_x FROM secret_table", calls_per_req: 1, mean_ms: 1, rows_per_req: 1 }] });
const base = { runId: "vb-20261119120000-beef", toolVersion: "0.0.1", profile: "small" as const, size: "M", stageDurationS: 60, thinkTimeS: 1 };
const probe = { "GET /b": { S: pe(1, 1), L: pe(40, 10) }, "GET /a": { S: pe(1000, 3), M: pe(4000, 20), L: pe(40001, 9) } };
const evil = "FAKESECRET_x /home/u/app/src/db.ts:42 C:\\app\\x.js DATABASE_URL JWT_SECRET secret_table";
const flags = [
  { flag: "n_plus_one" as const, endpoint: "GET /a", evidence: { metric: "queries_per_req" as const, by_size: { S: 1000, M: 4000, L: 40001 } }, cause: evil, fix: evil },
  { flag: "missing_index" as const, endpoint: "GET /b", evidence: { metric: "mean_ms" as const, by_size: { S: 0.1, L: 1.2 }, query: `SELECT ${evil}`, seq_scan: { table: "secret_table", filter: evil, table_rows: 20000 } }, cause: evil, fix: evil },
];
const mk = (o: Partial<Parameters<typeof buildResult>[0]> = {}) => buildResult({ ...base, stages: [st(10, 50), st(25, 3000)], probe, flags, ...o });
const entities = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[m]!);

const variants: [string, ReturnType<typeof mk>, string][] = [
  ["break ok>0", mk(), "Handles ~10 users"],
  ["break ok=0", mk({ stages: [st(10, 3000)] }), "Broke at 10 users"],
  ["no break", mk({ stages: [st(10, 50), st(25, 60)] }), "Handles 25+ users"],
  ["probe only", mk({ stages: [] }), "Data-growth probe only"],
  ["no probe", mk({ probe: {}, flags: [] }), "Handles ~10 users"],
  ["null p95", mk({ stages: [st(10, 50), st(25, null, 1)] }), "Handles ~10 users"],
  ["20 stages", mk({ stages: Array.from({ length: 20 }, (_, i) => st(i + 1, 100 + i)) }), "Handles 20+ users"],
];

describe("chart", () => {
  it("is deterministic, also with probe keys inserted in another order", () => {
    const r = mk();
    expect(chartSvg(r, "app")).toBe(chartSvg(r, "app"));
    const rev = { ...r, probe: Object.fromEntries(Object.entries(r.probe).reverse()) };
    expect(chartSvg(rev, "app")).toBe(chartSvg(r, "app"));
  });
  it("has no forbidden content", () => {
    const svg = chartSvg(mk(), "app");
    for (const bad of ["FAKESECRET_x", "/home/u", "C:\\app", "DATABASE_URL", "JWT_SECRET", "secret_table", base.runId]) expect(svg).not.toContain(bad);
    expect(svg).not.toMatch(/\.(c|m)?[jt]sx?:\d+/);
    expect(svg).not.toMatch(/\/(home|Users|tmp|var|etc)\//);
    expect(svg).not.toMatch(/line \d+/i);
    for (const f of ["express-pg", "next-drizzle"]) for (const n of JSON.parse(readFileSync(`fixtures/${f}/expected/expected.json`, "utf8")).env_names as string[]) expect(svg).not.toContain(n);
  });
  it.each(variants)("variant %s renders well-formed and fits", (_n, r, headline) => {
    for (const name of ["app", "my <app> & ü very-long-name-here-xyz"]) {
      const svg = chartSvg(r, name);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(svg).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
      expect(entities(svg)).toContain(headline);
      for (const m of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
        const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[1])?.[1];
        const x = Number(attr("x")), fs = Number(attr("font-size")), anchor = attr("text-anchor"), w = [...entities(m[2])].length * 0.6 * fs;
        expect(fs).toBeGreaterThanOrEqual(28);
        const [l, rr] = anchor === "end" ? [x - w, x] : anchor === "middle" ? [x - w / 2, x + w / 2] : [x, x + w];
        expect(l).toBeGreaterThanOrEqual(39.9);
        expect(rr).toBeLessThanOrEqual(1040.1);
      }
    }
  });
  it("worst endpoint: largest size wins, ties by key, missing L falls back", () => {
    expect(worstEndpoint(probe)).toBe("GET /b");
    expect(worstEndpoint({ "GET /z": { L: pe(1, 5) }, "GET /y": { L: pe(1, 5) } })).toBe("GET /y");
    expect(worstEndpoint({ "GET /m": { S: pe(1, 1), M: pe(1, 8) }, "GET /l": { S: pe(1, 1), L: pe(1, 7) } })).toBe("GET /m");
    expect(worstEndpoint({})).toBeNull();
  });
  it("projectLabel sanitises", () => {
    expect(projectLabel("/x/my app!!")).toBe("my-app");
    expect(projectLabel("/x/....")).toBe("app");
    expect(projectLabel("/x/" + "a".repeat(40))).toBe("a".repeat(21) + "…");
  });
  it("resultError rejects bad shapes", () => {
    expect(resultError(mk())).toBeNull();
    expect(resultError({ ...mk(), schema: 2 })).not.toBeNull();
    expect(resultError({ ...mk(), stages: "x" })).not.toBeNull();
    expect(resultError({ ...mk(), profile: "huge" })).not.toBeNull();
    expect(resultError({ ...mk(), stages: [], probe: {} })).not.toBeNull();
    expect(resultError({ ...mk(), stages: [{ users: "1" }] })).not.toBeNull();
  });
});

describe("png", () => {
  it("renders a 1080x1350 PNG, twice in one process", async () => {
    const svg = chartSvg(mk(), "app");
    for (let i = 0; i < 2; i++) {
      const png = Buffer.from(await svgToPng(svg, assets));
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.readUInt32BE(16)).toBe(1080);
      expect(png.readUInt32BE(20)).toBe(1350);
      expect(png.length).toBeGreaterThan(20000);
    }
  });
  it("the font loads (text-only SVG has non-white pixels)", async () => {
    const withText = Buffer.from(await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#fff"/><text x="10" y="60" font-size="40" font-family="Liberation Mono">HELLO</text></svg>', assets));
    const blank = Buffer.from(await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#fff"/></svg>', assets));
    expect(withText.length).toBeGreaterThan(blank.length + 200);
  });
});

describe("report", () => {
  const call = { service: "openai", method: "POST", path: "/v1/chat/completions", count: 3 };
  const heads = ["# vibe-breakpoint report: app", "## 1. Verdict", "## 2. Breaking point", "## 3. Data growth findings", "## 4. Code locations", "## 5. Test setup", "## 6. Limits"];
  it("has the headings in order, setup, limits and one fix prompt per flag", () => {
    const md = reportMd({ result: mk(), project: "app", mockLog: [call] });
    let at = -1;
    for (const h of heads) { const i = md.indexOf(`${h}\n`); expect(i, h).toBeGreaterThan(at); at = i; }
    expect(md).toContain("small server: 1 CPU / 1 GB app, 1 CPU / 1 GB db");
    expect(md).toContain("Set up as local mocks: OpenAI, Anthropic, Stripe, Resend");
    expect(md).toContain("| openai | POST | /v1/chat/completions | 3 |");
    for (const s of ["a local estimate on a simulated small server", "instant mock", "Real traffic and real data differ", "cold starts and connection limits"]) expect(md).toContain(s);
    expect(md).toContain("the endpoint GET /a runs one database query per item: 1000 queries per request with small data, 40,001 with large data");
    expect(md).toContain('the endpoint GET /b gets slower as table "secret_table" grows (0.1 ms -> 1.2 ms per query)');
    expect(md.match(/Fix prompt for Claude Code:/g)).toHaveLength(2);
    expect(md).toContain("On a simulated small server, ");
    expect(md).toContain("2 data-growth problem(s) found.");
  });
  it("covers missing/empty log and no-probe cases", () => {
    expect(reportMd({ result: mk(), project: "app" })).toContain("Mock log not found");
    expect(reportMd({ result: mk(), project: "app", mockLog: [] })).toContain("The app made no calls to outside services.");
    const md = reportMd({ result: mk({ probe: {}, flags: [] }), project: "app" });
    expect(md).toContain("No data-growth probe ran");
    expect(md).toContain("No code locations yet.");
    expect(reportMd({ result: mk({ stages: [] }), project: "app" })).toContain("No load test ran.");
    expect(reportMd({ result: mk({ flags: [] }), project: "app" })).toContain("No data-growth problems found.");
  });
  it("fence grows around backticks", () => {
    const r = mk({ flags: [{ ...flags[1], evidence: { ...flags[1].evidence, query: "SELECT '````'" } }] });
    expect(reportMd({ result: r, project: "app" })).toContain("`````sql");
  });
});
