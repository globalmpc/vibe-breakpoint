import type { Flag } from "../probe/flags.js";
import type { Size } from "../seed/seed.js";
import { ascii, FLAG_NAMES, fmtMs, fmtNum, profileLine, reasonSuffix, worstEndpoint, type Result } from "./chart.js";

export type MockCall = { service: string; method: string; path: string; count: number };
type In = { result: Result; project: string; mockLog?: MockCall[]; seedSizes?: Record<Size, number>; codeLocations?: string };

const SZ: Size[] = ["S", "M", "L"];
const cell = (s: string) => ascii(s).replace(/\|/g, "\\|");
const n = (v: number | null | undefined, f: (x: number) => string = fmtNum) => (v === null || v === undefined ? "–" : f(v));
const pct = (v: number | null) => n(v, (x) => String(Math.round(x * 1000) / 10));
const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const fence = (body: string, lang = "") => { const k = Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)); const f = "`".repeat(k); return `${f}${lang}\n${body}\n${f}`; };
const arrow = (f: Flag) => SZ.filter((z) => f.evidence.by_size[z] !== undefined).map((z) => `${z} ${fmtNum(f.evidence.by_size[z]!)}`).join(" → ");

const METRIC: Record<Flag["evidence"]["metric"], string> = { queries_per_req: "queries per request", mean_ms: "ms per query", rows_per_req: "rows per request" };

function fixPrompt(f: Flag): string {
  const by = f.evidence.by_size, S = fmtNum(by.S ?? 0), L = fmtNum(by.L ?? 0), ep = ascii(f.endpoint);
  if (f.flag === "n_plus_one") return `In my app, the endpoint ${ep} runs one database query per item: ${S} queries per request with small data, ${L} with large data. Find the loop in its handler that queries the database once per row and replace it with one query (a join or WHERE id IN (...)). Keep the response the same.`;
  if (f.flag === "unbounded_fetch") return `In my app, the endpoint ${ep} returns every row: ${S} rows per request with small data, ${L} with large data. Add pagination (LIMIT with a page or cursor parameter, default 50) and select only the columns the response needs. Update callers that expect the full list.`;
  const sc = f.evidence.seq_scan;
  return `In my app, the endpoint ${ep} gets slower as table "${sc?.table ?? "?"}" grows (${S} ms -> ${L} ms per query) because this query scans the whole table:\n${f.evidence.query ?? ""}\nFilter: ${sc?.filter ?? ""}\nAdd an index on the filtered column(s) of "${sc?.table ?? "?"}" using this project's migration setup. Do not change other tables.`;
}

export function reportMd({ result, project, mockLog, seedSizes, codeLocations }: In): string {
  const { stages, breaking_point: bp, probe, flags } = result;
  const prof = profileLine(result.profile);
  const o: string[] = [`# vibe-breakpoint report: ${project}`, ""];

  let v: string;
  if (!stages.length) v = "no load test ran, only the data-growth probe.";
  else if (bp && bp.users_ok > 0) v = `the app handled about ${fmtNum(bp.users_ok)} users at the same time and broke at ${fmtNum(bp.users_broke)} users.`;
  else if (bp) v = `the app broke at ${fmtNum(bp.users_broke)} users, the first stage tested.`;
  else v = `the app handled ${fmtNum(stages[stages.length - 1].users)} users with no breaking point found.`;
  const problems = flags.length;
  o.push("## 1. Verdict", "", `On a simulated ${result.profile} server, ${v}${Object.keys(probe).length ? ` ${problems} data-growth problem(s) found.` : ""}`, "");

  o.push("## 2. Breaking point", "");
  if (!stages.length) o.push("No load test ran.", "");
  else {
    o.push("The app counts as broken when p95 is above 2 s or more than 1 % of requests fail.", "");
    o.push(table(["users", "p50", "p95", "errors %", "app CPU %", "db CPU %", "app memory MB"],
      stages.map((s) => [fmtNum(s.users), n(s.p50_ms, fmtMs), n(s.p95_ms, fmtMs), String(Math.round(s.error_rate * 1000) / 10), pct(s.app_cpu), pct(s.db_cpu), n(s.app_mem_mb)])), "");
    const ran = { app_cpu: "the app's CPU", db_cpu: "the database's CPU", memory: "the app's memory", app_code: "no resource was saturated, so the slowdown is in the app code or its queries" } as const;
    o.push(`What ran out: ${result.limiting_resource ? ran[result.limiting_resource] : bp ? "not measured" : "nothing (no break)"}.`, "");
    if (bp) o.push(`Break reason: ${reasonSuffix(bp, stages.find((s) => s.users === bp.users_broke)?.error_rate).slice(1, -1)}.`, "");
  }

  o.push("## 3. Data growth findings", "");
  const eps = Object.keys(probe).sort();
  if (!eps.length) o.push("No data-growth probe ran (needs seed.json and scenario.json with probe_endpoints).", "");
  else {
    const rows: string[][] = [];
    for (const ep of eps) for (const z of SZ) { const e = probe[ep][z]; if (e) rows.push([cell(ep), z, fmtNum(e.queries_per_req), fmtMs(e.db_ms_per_req), fmtNum(e.rows_per_req)]); }
    o.push(table(["endpoint", "size", "queries/req", "db ms/req", "rows/req"], rows), "");
    const w = worstEndpoint(probe);
    if (w) o.push(`Slowest endpoint as data grows: ${cell(w)}.`, "");
    if (!flags.length) o.push("No data-growth problems found.", "");
    flags.forEach((f, i) => {
      o.push(`### ${i + 1}. ${FLAG_NAMES[f.flag]} on \`${ascii(f.endpoint).replace(/`/g, "'")}\``, "");
      o.push(`Cause: ${f.cause}`, "", `Numbers: ${METRIC[f.evidence.metric]} ${arrow(f)}`, "");
      if (f.flag === "missing_index") {
        o.push(`Table: ${f.evidence.seq_scan?.table ?? "?"} (${fmtNum(f.evidence.seq_scan?.table_rows ?? 0)} rows)`, "");
        if (f.evidence.query) o.push(fence(f.evidence.query, "sql"), "");
      }
      o.push(`Fix: ${f.fix}`, "", "Fix prompt for Claude Code:", "", fence(fixPrompt(f), "text"), "");
    });
  }

  o.push("## 4. Code locations", "", codeLocations !== undefined ? codeLocations.replace(/\s+$/, "") : "No code locations yet. Run /vibe-breakpoint so Claude can point to the code.", "");

  o.push("## 5. Test setup", "", `- ${prof}`);
  o.push(`- Data sizes: ${seedSizes ? `S ${fmtNum(seedSizes.S)} / M ${fmtNum(seedSizes.M)} / L ${fmtNum(seedSizes.L)} rows (main table)` : "no seed.json: the app's empty database after migrations"}`);
  if (stages.length) o.push(`- Load test ran on data size ${result.size ?? "none"}, stages ${stages.map((s) => s.users).join(", ")}, ${result.stage_duration_s} s each, think time ${result.think_time_s} s`);
  o.push("- Scenario: .vibe-breakpoint/scenario.json", "", "What was mocked: Set up as local mocks: OpenAI, Anthropic, Stripe, Resend (no internet during the run).", "");
  if (!mockLog) o.push("Mock log not found; outside calls were blocked but not counted.", "");
  else if (!mockLog.length) o.push("The app made no calls to outside services.", "");
  else {
    const rows = [...mockLog].sort((a, b) => b.count - a.count || (a.service + a.method + a.path < b.service + b.method + b.path ? -1 : 1)).slice(0, 20);
    o.push(table(["service", "method", "path", "count"], rows.map((c) => [c.service === "unknown" ? "other (answered with an empty reply)" : cell(c.service), cell(c.method), cell(c.path), fmtNum(c.count)])), "");
  }
  o.push("Changes made in the copy:", "", "- fake values for every env name", "- outside services pointed at the local mock", "- a throwaway Postgres", "- further changes, if any, are listed in section 4", "");

  o.push("## 6. Limits", "", `- This is a local estimate on a simulated ${result.profile} server, not your hosting.`,
    "- Outside services were replaced by an instant mock, so their latency and rate limits are not measured.",
    "- Real traffic and real data differ, and the test rows are generated.",
    "- Hosting adds network, cold starts and connection limits.", "", `Run ${ascii(result.run_id)}, vibe-breakpoint ${ascii(result.tool_version)}.`, "");
  return o.join("\n");
}
