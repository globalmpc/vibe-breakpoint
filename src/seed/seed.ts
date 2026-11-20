import { createHash } from "node:crypto";
import { psql } from "../sandbox/sandbox.js";

export const SIZES = ["S", "M", "L"] as const;
export type Size = (typeof SIZES)[number];
export type Gen =
  | { gen: "email" }
  | { gen: "words"; count?: number }
  | { gen: "fk"; ref: string }
  | { gen: "password_hash"; algo: "bcrypt"; plain: string; cost?: number }
  | { gen: "auto" };
export type SeedTable = { name: string; ratio: number; columns: Record<string, Gen> };
export type Seed = { schema: 1; random_seed: number; main_table: string; sizes: Record<Size, number>; tables: SeedTable[]; test_users?: number };
export type DbColumn = { table: string; column: string; type: string; nullable: boolean; hasDefault: boolean };

const WORDS = "alpha bravo cedar delta ember fjord grove harbor ivory jungle kernel lemon maple noble olive pearl quartz river solar tiger umber velvet willow xenon yellow zephyr amber birch coral dune flint haze".split(" ");

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

export function parseSeed(text: string): Seed {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error("seed.json: invalid JSON"); }
  const errs: string[] = [];
  if (!isObj(j)) throw new Error("seed.json: must be a JSON object");
  if (j.schema !== 1) errs.push("schema must be 1");
  if (!Number.isSafeInteger(j.random_seed)) errs.push("random_seed must be a safe integer");
  const sizes = isObj(j.sizes) ? j.sizes : {};
  for (const s of SIZES) if (!isInt(sizes[s], 1, 10_000_000)) errs.push(`sizes.${s} must be an integer from 1 to 10000000`);
  const tables = Array.isArray(j.tables) ? j.tables : [];
  if (!tables.length) errs.push("tables must be a non-empty array");
  const names: string[] = [];
  let pwCols = 0;
  let pwTable: { name: string; ratio: number; columns: Record<string, unknown> } | undefined;
  tables.forEach((t, ti) => {
    if (!isObj(t) || typeof t.name !== "string" || !t.name) { errs.push(`tables[${ti}]: name must be a non-empty string`); return; }
    const where = `table "${t.name}"`;
    if (names.includes(t.name)) errs.push(`${where}: listed twice`);
    if (typeof t.ratio !== "number" || !Number.isFinite(t.ratio) || t.ratio <= 0) errs.push(`${where}: ratio must be a number > 0`);
    if (!isObj(t.columns) || !Object.keys(t.columns).length) { errs.push(`${where}: columns must be a non-empty object`); names.push(t.name); return; }
    for (const [c, g] of Object.entries(t.columns)) {
      const w = `${where}: column "${c}"`;
      if (!isObj(g)) { errs.push(`${w}: generator must be an object`); continue; }
      switch (g.gen) {
        case "email": case "auto": break;
        case "words": if (g.count !== undefined && !isInt(g.count, 1, 10)) errs.push(`${w}: words count must be an integer 1..10`); break;
        case "fk": {
          const m = typeof g.ref === "string" ? /^([^.]+)\.([^.]+)$/.exec(g.ref) : null;
          if (!m) errs.push(`${w}: fk ref must look like "table.column"`);
          else if (!names.includes(m[1]) || m[1] === t.name) errs.push(`${w}: fk ref "${g.ref}" must name a table listed earlier`);
          break;
        }
        case "password_hash":
          if (g.algo !== "bcrypt") errs.push(`${w}: algo "${String(g.algo)}" not supported (bcrypt only)`);
          if (typeof g.plain !== "string" || !g.plain || Buffer.byteLength(g.plain) > 72) errs.push(`${w}: plain must be 1..72 bytes`);
          if (g.cost !== undefined && !isInt(g.cost, 4, 14)) errs.push(`${w}: cost must be an integer 4..14`);
          pwCols++;
          pwTable = t as unknown as NonNullable<typeof pwTable>;
          break;
        default: errs.push(`${w}: unknown gen ${JSON.stringify(g.gen)}`);
      }
    }
    names.push(t.name);
  });
  if (typeof j.main_table !== "string" || !names.includes(j.main_table)) errs.push(`main_table "${String(j.main_table)}" is not listed in tables`);
  if (j.test_users !== undefined) {
    if (!isInt(j.test_users, 0, Number.MAX_SAFE_INTEGER)) errs.push("test_users must be an integer >= 0");
    else if (j.test_users > 0) {
      if (pwCols !== 1) errs.push(`test_users needs exactly one password_hash column (found ${pwCols})`);
      else if (!hasEmailGen(pwTable!)) errs.push(`test_users needs table "${pwTable!.name}" to have an "email" generator column`);
      else if (isInt(sizes.S, 1, 10_000_000) && j.test_users > Math.max(1, Math.round(sizes.S * pwTable!.ratio))) errs.push("test_users exceeds the S row count of the table with password_hash");
    }
  }
  if (errs.length) throw new Error(`seed.json: ${errs.join("; ")}`);
  return j as unknown as Seed;
}

export const rowsFor = (seed: Seed, table: SeedTable, size: Size): number => Math.max(1, Math.round(seed.sizes[size] * table.ratio));

/** load.js/probe.js log in as user<i>@example.test, which only the "email" generator produces. */
export const hasEmailGen = (t: { columns: Record<string, unknown> }): boolean => Object.values(t.columns).some((g) => isObj(g) && g.gen === "email");

export const SCHEMA_SQL = `SELECT coalesce(json_agg(json_build_object('table', table_name, 'column', column_name, 'type', data_type, 'nullable', is_nullable = 'YES', 'hasDefault', column_default IS NOT NULL OR is_identity = 'YES' OR is_generated = 'ALWAYS') ORDER BY table_name, ordinal_position), '[]') FROM information_schema.columns WHERE table_schema = current_schema();`;

const AUTO_TYPES = ["text", "character varying", "character", "smallint", "integer", "bigint", "numeric", "real", "double precision", "boolean", "timestamp with time zone", "timestamp without time zone", "date", "uuid", "json", "jsonb"];

export function schemaErrors(seed: Seed, cols: DbColumn[]): string[] {
  const errs: string[] = [];
  for (const t of seed.tables) {
    const have = cols.filter((c) => c.table === t.name);
    if (!have.length) { errs.push(`table "${t.name}" does not exist`); continue; }
    for (const [c, g] of Object.entries(t.columns)) {
      const dc = have.find((x) => x.column === c);
      if (!dc) { errs.push(`table "${t.name}": column "${c}" does not exist`); continue; }
      if (g.gen === "auto" && !AUTO_TYPES.includes(dc.type)) errs.push(`table "${t.name}": column "${c}": auto does not support type ${dc.type}`);
      if (g.gen === "fk") {
        const [rt, rc] = g.ref.split(".");
        if (!cols.some((x) => x.table === rt && x.column === rc)) errs.push(`table "${t.name}": column "${c}": fk ref "${g.ref}" does not exist`);
      }
    }
    for (const dc of have) {
      if (!Object.hasOwn(t.columns, dc.column) && !dc.nullable && !dc.hasDefault) errs.push(`table "${t.name}": column "${dc.column}" is NOT NULL without a default; add a generator to seed.json`);
    }
  }
  return errs;
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

export function seedSql(seed: Seed, cols: DbColumn[], size: Size): string {
  const all = seed.tables.map((t) => q(t.name)).join(", ");
  let usesPw = false;
  const body: string[] = [];
  for (const t of seed.tables) {
    const joins: string[] = [];
    const exprs: string[] = [];
    for (const [c, g] of Object.entries(t.columns)) {
      const h = (k = "") => `((i::bigint * 2654435761 + ${fnv(`${seed.random_seed}:${t.name}:${c}${k}`)}) % 4294967296)`;
      switch (g.gen) {
        case "email": exprs.push(`'user' || i || '@example.test'`); break;
        case "words": {
          const n = g.count ?? 3;
          const parts = Array.from({ length: n }, (_, k) => `(string_to_array(${lit(WORDS.join(","))}, ','))[1 + ${h(`:${k + 1}`)} % ${WORDS.length}]`);
          exprs.push(`concat_ws(' ', ${parts.join(", ")})`);
          break;
        }
        case "fk": {
          const [rt, rc] = g.ref.split(".");
          const a = `r${joins.length}`;
          joins.push(`(SELECT array_agg(${q(rc)} ORDER BY ${q(rc)}) AS a FROM ${q(rt)}) ${a}`);
          exprs.push(`${a}.a[(1 + ${h()} % cardinality(${a}.a))::int]`);
          break;
        }
        case "password_hash": {
          usesPw = true;
          const salt = createHash("sha256").update(`${seed.random_seed}:salt`).digest("hex").slice(0, 21);
          const setting = `$2a$${String(g.cost ?? 10).padStart(2, "0")}$${salt}.`;
          const a = `p${joins.length}`;
          joins.push(`(SELECT crypt(${lit(g.plain)}, ${lit(setting)}) AS h) ${a}`);
          exprs.push(`${a}.h`);
          break;
        }
        case "auto": {
          const type = cols.find((x) => x.table === t.name && x.column === c)?.type ?? "";
          const hh = h();
          if (["text", "character varying", "character"].includes(type)) exprs.push(`${lit(`${c} `)} || i`);
          else if (["smallint", "integer", "bigint"].includes(type)) exprs.push(`(${hh} % 1000)::${type}`);
          else if (["numeric", "real", "double precision"].includes(type)) exprs.push(`(${hh} % 100000) / 100.0`);
          else if (type === "boolean") exprs.push(`${hh} % 2 = 0`);
          else if (type.startsWith("timestamp") || type === "date") exprs.push(`(timestamp '2025-01-01' - (${hh} % 31536000) * interval '1 second')::${type}`);
          else if (type === "uuid") exprs.push(`md5(${lit(`${fnv(`${seed.random_seed}:${t.name}:${c}`)}:`)} || i)::uuid`);
          else if (type === "json" || type === "jsonb") exprs.push(`'{}'::${type}`);
          else throw new Error(`auto does not support type ${type} (${t.name}.${c})`);
          break;
        }
      }
    }
    body.push(`INSERT INTO ${q(t.name)} (${Object.keys(t.columns).map(q).join(", ")}) SELECT ${exprs.join(", ")} FROM generate_series(1, ${rowsFor(seed, t, size)}) AS g(i)${joins.map((x) => `, ${x}`).join("")};`);
  }
  return [
    ...(usesPw ? ["CREATE EXTENSION IF NOT EXISTS pgcrypto;"] : []),
    `TRUNCATE ${all} RESTART IDENTITY CASCADE;`,
    ...body,
    `ANALYZE ${all};`,
  ].join("\n");
}

export function checksumSql(seed: Seed): string {
  const parts = seed.tables.map((t, i) =>
    `SELECT ${i} AS idx, ${lit(t.name)} AS tbl, count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS sum FROM (SELECT ${Object.keys(t.columns).map(q).join(", ")} FROM ${q(t.name)}) x`);
  return `SELECT json_agg(json_build_object('table', tbl, 'rows', n, 'checksum', sum) ORDER BY idx) FROM (${parts.join(" UNION ALL ")}) s;`;
}

export function dbColumns(composePath: string): DbColumn[] {
  return JSON.parse(psql(composePath, SCHEMA_SQL));
}

export function seedSize(composePath: string, seed: Seed, cols: DbColumn[], size: Size): { size: Size; ms: number; tables: { table: string; rows: number; checksum: string }[] } {
  try {
    const t0 = performance.now();
    psql(composePath, seedSql(seed, cols, size));
    const ms = Math.round(performance.now() - t0);
    return { size, ms, tables: JSON.parse(psql(composePath, checksumSql(seed))) };
  } catch (e) {
    throw new Error(`seeding ${size} failed:\n${e instanceof Error ? e.message : String(e)}`);
  }
}
