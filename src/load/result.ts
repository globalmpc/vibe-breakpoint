import type { Probe } from "../probe/probe.js";
import type { Flag } from "../probe/flags.js";
import { MEM_MB, PROFILES, type Profile } from "../sandbox/compose.js";

export type Sample = { cpu: number; memMb: number };
export type Stage = { users: number; p50_ms: number | null; p95_ms: number | null; error_rate: number; requests: number; app_cpu: number | null; db_cpu: number | null; app_mem_mb: number | null; raw_error_rate?: number };
export type Reason = "p95" | "error_rate" | "p95_and_error_rate";
export type Limiting = "app_cpu" | "db_cpu" | "memory" | "app_code";

export const SATURATED = 0.85;
export const P95_LIMIT_MS = 2000;
export const ERROR_LIMIT = 0.01;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function parseStages(s: string): number[] {
  const a = s.split(",").map((x) => (/^\d+$/.test(x.trim()) ? Number(x) : NaN));
  if (!a.length || a.some((n, i) => !(n >= 1 && n <= 1000) || (i > 0 && n <= a[i - 1]))) throw new Error(`invalid --stages: ${s}`);
  return a;
}

export function parseDuration(s: string): number {
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!(n >= 1 && n <= 600)) throw new Error(`invalid --stage-duration: ${s}`);
  return n;
}

type Summary = { metrics?: Record<string, { values?: Record<string, number> } | undefined> };

export function stageFromSummary(summary: unknown, users: number): Pick<Stage, "users" | "p50_ms" | "p95_ms" | "error_rate" | "raw_error_rate" | "requests"> {
  const m = (summary as Summary)?.metrics;
  const count = m?.http_reqs?.values?.count ?? 0;
  if (!count) return { users, p50_ms: null, p95_ms: null, error_rate: 1, requests: 0 };
  const d = m?.http_req_duration?.values;
  if (!d) throw new Error("k6 summary has no metrics.http_req_duration");
  return { users, p50_ms: r1(d.med), p95_ms: r1(d["p(95)"]), error_rate: r4(m?.http_req_failed?.values?.rate ?? 0), raw_error_rate: m?.http_req_failed?.values?.rate ?? 0, requests: count };
}

const UNITS: Record<string, number> = { B: 1 / 1048576, kB: 1000 / 1048576, KiB: 1 / 1024, MB: 1e6 / 1048576, MiB: 1, GB: 1e9 / 1048576, GiB: 1024 };

/** "12.5%" + "1.2GiB / 1GiB" -> cpu in cores, memory in MiB */
export function parseStatsLine(cpuPerc: string, memUsage: string): Sample {
  const cpu = parseFloat(cpuPerc) / 100;
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)/.exec(memUsage.split("/")[0]);
  if (!Number.isFinite(cpu) || !m || !(m[2] in UNITS)) throw new Error(`unparsable docker stats: ${cpuPerc} ${memUsage}`);
  return { cpu, memMb: Math.round(parseFloat(m[1]) * UNITS[m[2]] * 10) / 10 };
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

export function aggregate(samples: { app: Sample[]; db: Sample[] }, profile: Profile): Pick<Stage, "app_cpu" | "db_cpu" | "app_mem_mb"> {
  const cpus = PROFILES[profile].cpus;
  return {
    app_cpu: samples.app.length ? r2(mean(samples.app.map((s) => s.cpu)) / cpus) : null,
    db_cpu: samples.db.length ? r2(mean(samples.db.map((s) => s.cpu)) / cpus) : null,
    app_mem_mb: samples.app.length ? Math.round(Math.max(...samples.app.map((s) => s.memMb))) : null,
  };
}

// classify on the unrounded rate (1.004 % must not round down to 1 %); result.json only carries the rounded one
const errRate = (s: Pick<Stage, "error_rate" | "raw_error_rate">) => s.raw_error_rate ?? s.error_rate;
export const isBroken = (s: Pick<Stage, "p95_ms" | "error_rate" | "raw_error_rate">): boolean => s.p95_ms === null || s.p95_ms > P95_LIMIT_MS || errRate(s) > ERROR_LIMIT;

export function breakingPoint(stages: Stage[]): { users_ok: number; users_broke: number; reason: Reason } | null {
  const i = stages.findIndex(isBroken);
  if (i < 0) return null;
  const s = stages[i];
  const p = s.p95_ms === null || s.p95_ms > P95_LIMIT_MS;
  const e = errRate(s) > ERROR_LIMIT;
  return { users_ok: stages[i - 1]?.users ?? 0, users_broke: s.users, reason: p && e ? "p95_and_error_rate" : p ? "p95" : "error_rate" };
}

export function limitingResource(s: Pick<Stage, "app_cpu" | "db_cpu" | "app_mem_mb">, profile: Profile): Limiting | null {
  const c: [Limiting, number | null][] = [["app_cpu", s.app_cpu], ["db_cpu", s.db_cpu], ["memory", s.app_mem_mb === null ? null : s.app_mem_mb / MEM_MB[profile]]];
  const known = c.filter((x): x is [Limiting, number] => x[1] !== null);
  if (!known.length) return null;
  const hot = known.filter((x) => x[1] >= SATURATED).sort((a, b) => b[1] - a[1]);
  return hot[0]?.[0] ?? "app_code";
}

export function buildResult(o: { runId: string; toolVersion: string; profile: Profile; size: string | null; stageDurationS: number; thinkTimeS: number; stages: Stage[]; probe?: Probe; flags?: Flag[] }) {
  const bp = breakingPoint(o.stages);
  const broke = bp ? o.stages.find((s) => s.users === bp.users_broke)! : null;
  return {
    schema: 1,
    run_id: o.runId,
    tool_version: o.toolVersion,
    profile: o.profile,
    size: o.size,
    stage_duration_s: o.stageDurationS,
    think_time_s: o.thinkTimeS,
    stages: o.stages.map(({ raw_error_rate: _raw, ...s }) => s),
    breaking_point: bp,
    limiting_resource: broke ? limitingResource(broke, o.profile) : null,
    probe: o.probe ?? {},
    flags: o.flags ?? [],
  };
}
