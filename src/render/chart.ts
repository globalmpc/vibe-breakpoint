import { basename } from "node:path";
import { MEM_MB, PROFILES, type Profile } from "../sandbox/compose.js";
import { SIZES, type Size } from "../seed/seed.js";
import type { Probe } from "../probe/probe.js";
import type { Flag } from "../probe/flags.js";
import type { buildResult } from "../load/result.js";

export type Result = ReturnType<typeof buildResult>;

export const REPO_URL = "github.com/globalmpc/vibe-breakpoint"; // O-1: unconfirmed, the only place it appears

const W = 1080, H = 1350, X0 = 40, X1 = 1040, PX0 = 160, PX1 = 1020, PY0 = 330, PY1 = 820;
const INK = "#111827", BLUE = "#2563eb", RED = "#dc2626", GRID = "#e5e7eb", GREY = "#6b7280";

const r1 = (x: number) => Math.round(x * 10) / 10;
export const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?");
const group = (n: string) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function fmtMs(x: number): string {
  return x < 10 ? `${x.toFixed(1)} ms` : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`;
}
export function fmtNum(x: number): string {
  if (x < 10) return String(Math.round(x * 100) / 100);
  const n = String(Math.round(x));
  return x >= 10000 ? group(n) : n;
}

export function projectLabel(dir: string): string {
  return cleanName(basename(dir));
}
function cleanName(s: string): string {
  const t = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return !t ? "app" : t.length > 22 ? `${t.slice(0, 21)}…` : t;
}

export const profileLine = (p: Profile): string => {
  const mem = (mb: number) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);
  const side = `${PROFILES[p].cpus} CPU / ${mem(MEM_MB[p])}`;
  return `${p} server: ${side} app, ${side} db`;
};

export const reasonSuffix = (bp: NonNullable<Result["breaking_point"]>, errorRate: number | undefined): string =>
  bp.reason === "p95" ? "(too slow)" : bp.reason === "error_rate" ? `(${((errorRate ?? 0) * 100).toFixed(1)} % errors)` : "(slow + errors)";

export const FLAG_NAMES: Record<Flag["flag"], string> = { n_plus_one: "N+1 queries", missing_index: "missing index", unbounded_fetch: "reads whole table" };

/** endpoint with the highest db_ms_per_req at its largest size; ties go to the smaller key */
export function worstEndpoint(probe: Probe): string | null {
  let best: string | null = null, bv = -1;
  for (const k of Object.keys(probe).sort()) {
    const by = probe[k];
    const e = by.L ?? by.M ?? by.S;
    if (e && e.db_ms_per_req > bv) { best = k; bv = e.db_ms_per_req; }
  }
  return best;
}

/** returns a fixed reason when the parsed result.json is unusable, else null */
export function resultError(x: unknown): string | null {
  const o = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const numOrNull = (v: unknown) => v === null || num(v);
  if (!o(x) || x.schema !== 1) return "unsupported schema";
  if (typeof x.profile !== "string" || !(x.profile in PROFILES)) return "unknown profile";
  if (typeof x.run_id !== "string" || typeof x.tool_version !== "string") return "missing run_id or tool_version";
  if (!num(x.stage_duration_s) || !num(x.think_time_s)) return "bad timing fields";
  if (!Array.isArray(x.stages) || !Array.isArray(x.flags) || !o(x.probe)) return "stages, flags or probe have the wrong type";
  for (const s of x.stages) {
    if (!o(s) || !num(s.users) || !num(s.error_rate) || !["p50_ms", "p95_ms", "app_cpu", "db_cpu", "app_mem_mb"].every((k) => numOrNull(s[k]))) return "bad stage";
  }
  const bp = x.breaking_point;
  if (bp !== null && (!o(bp) || !num(bp.users_ok) || !num(bp.users_broke) || !["p95", "error_rate", "p95_and_error_rate"].includes(String(bp.reason)))) return "bad breaking_point";
  if (x.limiting_resource !== null && !["app_cpu", "db_cpu", "memory", "app_code"].includes(String(x.limiting_resource))) return "bad limiting_resource";
  for (const by of Object.values(x.probe)) {
    if (!o(by)) return "bad probe";
    for (const [z, e] of Object.entries(by)) {
      if (!(SIZES as readonly string[]).includes(z) || !o(e) || !num(e.queries_per_req) || !num(e.db_ms_per_req) || !num(e.rows_per_req)) return "bad probe";
    }
  }
  for (const f of x.flags) {
    if (!o(f) || !["n_plus_one", "missing_index", "unbounded_fetch"].includes(String(f.flag)) || typeof f.endpoint !== "string" || !o(f.evidence) || !o(f.evidence.by_size)) return "bad flag";
    if (typeof f.cause !== "string" || typeof f.fix !== "string") return "bad flag";
  }
  if (!x.stages.length && !Object.keys(x.probe).length) return "no stages and no probe";
  return null;
}

export function chartSvg(result: Result, projectName: string): string {
  const out: string[] = [];
  const text = (x: number, y: number, fs: number, s: string, o: { anchor?: "middle" | "end"; bold?: boolean; fill?: string } = {}) => {
    const avail = o.anchor === "end" ? x - X0 : o.anchor === "middle" ? 2 * Math.min(x - X0, X1 - x) : X1 - x;
    const max = Math.floor(avail / (0.6 * fs));
    const cs = [...s];
    const t = cs.length > max ? `${cs.slice(0, Math.max(0, max - 1)).join("")}…` : s;
    out.push(`<text x="${r1(x)}" y="${r1(y)}" font-size="${fs}" fill="${o.fill ?? INK}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.bold ? ' font-weight="bold"' : ""}>${xmlEscape(t)}</text>`);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, extra = "") =>
    out.push(`<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${stroke}" stroke-width="3"${extra}/>`);

  const { stages, breaking_point: bp, probe, flags } = result;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Liberation Mono, monospace">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  text(X0, 70, 40, `VIBE BREAKPOINT — ${cleanName(projectName)}`, { bold: true });

  let h1: string, h2: string;
  if (!stages.length) [h1, h2] = ["Data-growth probe only", "no load test in this run"];
  else if (bp && bp.users_ok > 0) [h1, h2] = [`Handles ~${fmtNum(bp.users_ok)} users`, "at the same time"];
  else if (bp) [h1, h2] = [`Broke at ${fmtNum(bp.users_broke)} users`, "the first stage tested"];
  else [h1, h2] = [`Handles ${fmtNum(stages[stages.length - 1].users)}+ users`, "no breaking point found"];
  text(X0, 150, 64, h1, { bold: true });
  text(X0, 200, 40, h2);

  text(X0, 270, 32, "p95 response time by users", { bold: true });
  if (!stages.length) {
    text(540, 575, 32, "No load test in this run", { anchor: "middle", fill: GREY });
  } else {
    const n = stages.length;
    const maxP = Math.max(2000, ...stages.map((s) => s.p95_ms ?? 0));
    const yMax = Math.ceil((maxP * 1.1) / 2000) * 2000; // ticks fall on multiples of 500 ms; axis always in seconds (D-062)
    const py = (v: number) => PY1 - (v / yMax) * (PY1 - PY0);
    const px = (i: number) => PX0 + ((i + 0.5) * (PX1 - PX0)) / n;
    for (let i = 0; i <= 4; i++) {
      const y = py((yMax * i) / 4);
      line(PX0, y, PX1, y, GRID);
      text(PX0 - 10, y + 10, 28, `${+((yMax * i) / 4000).toFixed(1)} s`, { anchor: "end" });
    }
    const step = Math.ceil(n / 10);
    stages.forEach((s, i) => { if (i % step === 0 || i === n - 1) text(px(i), 855, 28, fmtNum(s.users), { anchor: "middle" }); });
    line(PX0, py(2000), PX1, py(2000), RED, ' stroke-dasharray="12 8"');
    text(PX0 + 8, py(2000) - 8, 28, "2 s limit", { fill: RED });
    const pts = stages.map((s, i) => `${r1(px(i))},${r1(py(s.p95_ms ?? yMax))}`).join(" ");
    out.push(`<polyline points="${pts}" fill="none" stroke="${BLUE}" stroke-width="4"/>`);
    stages.forEach((s, i) => {
      const x = px(i), y = py(s.p95_ms ?? yMax);
      if (s.p95_ms === null) { line(x - 9, y - 9, x + 9, y + 9, RED); line(x - 9, y + 9, x + 9, y - 9, RED); }
      else out.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="7" fill="${BLUE}"/>`);
    });
    if (bp) {
      const i = stages.findIndex((s) => s.users === bp.users_broke);
      if (i >= 0) {
        const x = px(i);
        line(x, PY0, x, PY1, RED, ' stroke-dasharray="8 8"');
        out.push(`<circle cx="${r1(x)}" cy="${r1(py(stages[i].p95_ms ?? yMax))}" r="11" fill="${RED}"/>`);
        const label = `broke at ${fmtNum(bp.users_broke)} users ${reasonSuffix(bp, stages[i].error_rate)}`;
        if (x <= 540) text(x + 8, PY0 - 20, 28, label, { fill: RED, bold: true });
        else text(x - 8, PY0 - 20, 28, label, { anchor: "end", fill: RED, bold: true });
      }
    }
    const ran: Record<string, string> = { app_cpu: "app CPU", db_cpu: "database CPU", memory: "memory", app_code: "no resource (app code)" };
    if (result.limiting_resource) text(X0, 900, 28, `ran out: ${ran[result.limiting_resource]}`);
  }

  const worst = worstEndpoint(probe);
  if (!worst) {
    text(X0, 980, 32, "No data-growth probe in this run", { fill: GREY });
  } else {
    text(X0, 970, 32, `As data grows: ${ascii(worst)}`, { bold: true });
    text(X0, 1015, 28, "data", { bold: true });
    text(700, 1015, 28, "queries/req", { anchor: "end", bold: true });
    text(X1, 1015, 28, "db time/req", { anchor: "end", bold: true });
    line(X0, 1028, X1, 1028, GRID);
    let y = 1065;
    for (const [z, name] of [["S", "small"], ["M", "medium"], ["L", "large"]] as [Size, string][]) {
      const e = probe[worst][z];
      if (!e) continue;
      text(X0, y, 28, name);
      text(700, y, 28, fmtNum(e.queries_per_req), { anchor: "end" });
      text(X1, y, 28, fmtMs(e.db_ms_per_req), { anchor: "end" });
      y += 40;
    }
    const kinds = [...new Set(flags.filter((f) => f.endpoint === worst).map((f) => FLAG_NAMES[f.flag]))];
    if (kinds.length) text(X0, y + 15, 28, `found: ${kinds.join(", ")}`, { fill: RED });
  }

  text(X0, 1245, 28, profileLine(result.profile));
  text(X0, 1295, 28, REPO_URL, { fill: GREY });
  text(X0, 1330, 28, 'search "vibe-breakpoint" on GitHub', { fill: GREY });
  out.push("</svg>");
  return out.join("\n") + "\n";
}
