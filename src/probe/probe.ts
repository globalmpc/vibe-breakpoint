import type { Size } from "../seed/seed.js";
import { redact } from "../sandbox/test-env.js";

export const PROBE_REQUESTS = 5;
export type StatRow = { queryid: string; query: string; calls: number; total_ms: number; rows: number };
export type TopQuery = { query: string; calls_per_req: number; mean_ms: number; rows_per_req: number };
export type ProbeEntry = { queries_per_req: number; db_ms_per_req: number; rows_per_req: number; top_queries: TopQuery[] };
export type Probe = Record<string, Partial<Record<Size, ProbeEntry>>>; // endpoint -> size -> entry
export type RawProbe = Record<string, Partial<Record<Size, StatRow[]>>>; // kept + grouped rows, input to flags

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** schema must be a plain identifier (checked here, never trust text from the DB blindly). */
export function statsSql(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new Error(`unsafe schema name for pg_stat_statements: ${JSON.stringify(schema)}`);
  return `SELECT coalesce(json_agg(json_build_object('queryid', queryid::text, 'query', query, 'calls', calls, 'total_ms', total_exec_time, 'rows', rows)), '[]') FROM ${schema}.pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND toplevel;`;
}

const DROP_PREFIX = ["explain", "analyze", "set ", "show ", "discard ", "reset "];

function keep(q: string): boolean {
  const t = q.trim().toLowerCase();
  if (t.includes("pg_stat_statements")) return false;
  if (t === "begin" || t === "commit") return false; // psql -1 wrapper
  if (DROP_PREFIX.some((p) => t.startsWith(p))) return false;
  return t.replace(/;+$/, "").trim() !== "select $1";
}

/** Drops the tool's own statements and groups by queryid (sums calls, total_ms, rows). */
export function keepRows(rows: StatRow[]): StatRow[] {
  const by = new Map<string, StatRow>();
  for (const r of rows) {
    if (!keep(r.query)) continue;
    const g = by.get(r.queryid);
    if (g) { g.calls += r.calls; g.total_ms += r.total_ms; g.rows += r.rows; } else by.set(r.queryid, { ...r });
  }
  return [...by.values()];
}

/** redact env values, then cap at 500 chars */
export const safeText = (text: string, env: Record<string, string>): string => redact(text, env).slice(0, 500);

export function summarize(rows: StatRow[], n: number, env: Record<string, string>): ProbeEntry {
  const k = keepRows(rows);
  const sum = (f: (r: StatRow) => number) => k.reduce((a, r) => a + f(r), 0);
  return {
    queries_per_req: r2(sum((r) => r.calls) / n),
    db_ms_per_req: r1(sum((r) => r.total_ms) / n),
    rows_per_req: r2(sum((r) => r.rows) / n),
    top_queries: [...k].sort((a, b) => b.total_ms - a.total_ms).slice(0, 5).map((r) => ({
      query: safeText(r.query, env),
      calls_per_req: r2(r.calls / n),
      mean_ms: r1(r.calls ? r.total_ms / r.calls : 0),
      rows_per_req: r2(r.rows / n),
    })),
  };
}

export function endpointKey(step: { method: string; path: string; name: string }, taken: Set<string>): string {
  const base = `${step.method} ${step.path.split("?")[0]}`;
  const key = taken.has(base) ? `${base} (${step.name})` : base;
  taken.add(key);
  return key;
}

/** SELECT/WITH only, no ';' or '\', top 10 by total time. Returned texts are what gets EXPLAINed (never executed). */
export function explainCandidates(rows: StatRow[]): string[] {
  return rows
    .filter((r) => /^\s*(select|with)\b/i.test(r.query) && !/[;\\]/.test(r.query.trimEnd().replace(/;$/, "")))
    .sort((a, b) => b.total_ms - a.total_ms)
    .slice(0, 10)
    .map((r) => r.query.trimEnd().replace(/;$/, ""));
}

/** SQL string literal; standard_conforming_strings is on in postgres:16, NUL stripped. */
export const sqlLit = (s: string): string => `'${s.replace(/\0/g, "").replace(/'/g, "''")}'`;

export function relTuplesSql(rels: { schema: string; table: string }[]): string {
  const vals = rels.map((r) => `(${sqlLit(r.schema)}, ${sqlLit(r.table)})`).join(", ");
  return `SELECT coalesce(json_agg(json_build_object('s', v.s, 't', v.t, 'n', coalesce((SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = v.s AND c.relname = v.t), 0))), '[]') FROM (VALUES ${vals}) AS v(s, t);`;
}
