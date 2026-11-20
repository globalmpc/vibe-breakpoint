import type { Seed, Size } from "../seed/seed.js";
import { hasEmailGen, rowsFor } from "../seed/seed.js";

export type Step = { name: string; method: string; path: string; body?: Record<string, unknown>; save?: { cookie: boolean } };
export type Scenario = { schema: 1; flow: Step[]; think_time_s: number; probe_endpoints?: string[] };
export type LoadConfig = { base: string; flow: Step[]; think_time_s: number; test_users: number; password: string; email_rows: number };

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const PLACEHOLDERS = ["user.email", "user.password", "random.email"];
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const bad = (m: string): never => { throw new Error(`scenario.json: ${m}`); };

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => strings(v, out));
  else if (isObj(x)) Object.values(x).forEach((v) => strings(v, out));
  return out;
}

const pwColumn = (seed: Seed) => seed.tables.flatMap((t) => Object.values(t.columns)).find((g) => g.gen === "password_hash");
const emailTable = (seed: Seed) => seed.tables.find((t) => Object.values(t.columns).some((g) => g.gen === "email"));

export function parseScenario(text: string, seed?: Seed): Scenario {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return bad("invalid JSON"); }
  if (!isObj(j)) return bad("must be a JSON object");
  if (j.schema !== 1) bad("schema must be 1");
  const flow = j.flow;
  if (!Array.isArray(flow) || flow.length < 1 || flow.length > 20) return bad("flow must have 1 to 20 steps");
  const names = new Set<string>();
  const used = new Set<string>();
  for (const s of flow) {
    if (!isObj(s)) return bad("each flow step must be an object");
    if (typeof s.name !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(s.name)) return bad(`step name ${JSON.stringify(s.name)} must match [A-Za-z0-9_-]{1,40}`);
    if (names.has(s.name)) bad(`duplicate step name "${s.name}"`);
    names.add(s.name);
    if (typeof s.method !== "string" || !METHODS.includes(s.method)) return bad(`step "${s.name}": method must be one of ${METHODS.join(", ")}`);
    if (typeof s.path !== "string" || !s.path.startsWith("/") || s.path.startsWith("//") || /[\s\\]/.test(s.path)) return bad(`step "${s.name}": path must start with a single "/" and have no spaces or backslashes`);
    if (s.body !== undefined && !isObj(s.body)) return bad(`step "${s.name}": body must be a JSON object`);
    if (s.save !== undefined && (!isObj(s.save) || typeof s.save.cookie !== "boolean")) return bad(`step "${s.name}": save must be {"cookie": boolean}`);
    for (const str of [s.path, ...strings(s.body)]) for (const m of str.matchAll(/\{\{([^}]*)\}\}/g)) {
      if (!PLACEHOLDERS.includes(m[1])) bad(`step "${s.name}": unknown placeholder {{${m[1]}}}`);
      used.add(m[1]);
    }
  }
  if (!(flow as Step[]).some((s) => !s.save?.cookie)) bad("at least one step must not be a cookie-saving step");
  const think = j.think_time_s ?? 1;
  if (typeof think !== "number" || !(think >= 0 && think <= 60)) bad("think_time_s must be a number from 0 to 60");
  const probe = j.probe_endpoints;
  if (probe !== undefined) {
    if (!Array.isArray(probe) || probe.some((p) => typeof p !== "string" || !names.has(p))) bad("probe_endpoints must name flow steps");
  }
  for (const u of used) {
    if (u.startsWith("user.") && !((seed?.test_users ?? 0) >= 1 && seed!.tables.some((t) => Object.values(t.columns).some((g) => g.gen === "password_hash") && hasEmailGen(t)))) bad(`scenario uses {{${u}}} but seed.json has no test_users with a password_hash table that has an email generator column`);
    if (u === "random.email" && !(seed && emailTable(seed))) bad(`scenario uses {{${u}}} but seed.json has no table with an email column`);
  }
  return { schema: 1, flow: flow as Step[], think_time_s: think as number, ...(probe !== undefined && { probe_endpoints: probe as string[] }) };
}

export function loadConfig(sc: Scenario, seed: Seed | undefined, size: Size | null): LoadConfig {
  const pw = seed && pwColumn(seed);
  const et = seed && emailTable(seed);
  return {
    base: "http://app:3000",
    flow: sc.flow,
    think_time_s: sc.think_time_s,
    test_users: seed?.test_users ?? 0,
    password: pw && pw.gen === "password_hash" ? pw.plain : "",
    email_rows: seed && et && size ? rowsFor(seed, et, size) : 1,
  };
}
