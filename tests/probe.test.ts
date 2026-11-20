import { describe, expect, it } from "vitest";
import { endpointKey, explainCandidates, keepRows, summarize, type RawProbe, type StatRow } from "../src/probe/probe.js";
import { computeFlags, seqScans, type SeqScan } from "../src/probe/flags.js";

const row = (queryid: string, query: string, calls: number, total_ms: number, rows: number): StatRow => ({ queryid, query, calls, total_ms, rows });
const SIZES = { S: 1000, M: 10000, L: 100000 };

describe("summarize (AC1, AC6)", () => {
  const rows = [
    row("1", "SELECT * FROM projects", 5, 10, 500),
    row("2", "SELECT name FROM users WHERE id = $1", 5, 5, 5),
    row("2", "SELECT name FROM users WHERE id = $1", 5, 5, 5), // toplevel duplicate
    row("3", "SELECT vb_probe.pg_stat_statements_reset()", 1, 1, 1),
    row("4", "EXPLAIN SELECT 1", 1, 1, 1),
    row("5", "select $1", 9, 1, 9),
    row("6", "SET statement_timeout = 1", 1, 1, 0),
    row("7", "COMMIT", 5, 0.5, 0),
    row("8", "BEGIN", 5, 0.1, 0),
  ];
  it("ignores the tool's own rows and groups by queryid", () => {
    expect(keepRows(rows).map((r) => r.queryid)).toEqual(["1", "2"]); // tool BEGIN/COMMIT (psql -1) are dropped too (B5)
    const e = summarize(rows, 5, {});
    expect(e.queries_per_req).toBe(3);
    expect(e.db_ms_per_req).toBe(4);
    expect(e.rows_per_req).toBe(102);
    expect(e.top_queries.map((q) => q.query)).toEqual(["SELECT * FROM projects", "SELECT name FROM users WHERE id = $1"]);
    expect(e.top_queries[1]).toEqual({ query: "SELECT name FROM users WHERE id = $1", calls_per_req: 2, mean_ms: 1, rows_per_req: 2 });
  });
  it("keeps at most 5 top queries", () => {
    const many = Array.from({ length: 8 }, (_, i) => row(String(i), `SELECT ${i} FROM t`, 5, i + 1, 0));
    const t = summarize(many, 5, {}).top_queries;
    expect(t).toHaveLength(5);
    expect(t[0].query).toBe("SELECT 7 FROM t");
  });
  it("redacts env values and truncates to 500 chars", () => {
    const env = { API_KEY: "FAKESECRET_abcdef123456" };
    const e = summarize([row("1", `SELECT 'FAKESECRET_abcdef123456' ${"x".repeat(600)}`, 5, 1, 1)], 5, env);
    expect(e.top_queries[0].query).not.toContain("FAKESECRET_");
    expect(e.top_queries[0].query.length).toBeLessThanOrEqual(500);
  });
  it("endpointKey strips the query string and disambiguates", () => {
    const taken = new Set<string>();
    expect(endpointKey({ method: "GET", path: "/api/users?email=x", name: "a" }, taken)).toBe("GET /api/users");
    expect(endpointKey({ method: "GET", path: "/api/users", name: "b" }, taken)).toBe("GET /api/users (b)");
  });
});

const raw = (S: StatRow[] | undefined, L: StatRow[] | undefined): RawProbe => ({ "GET /x": { ...(S && { S }), ...(L && { L }) } });
const calls = (n: number) => [row("a", "SELECT 1 FROM t", n * 5, 1, 0)];

describe("n_plus_one (AC2)", () => {
  const f = (s: number, l: number) => computeFlags(raw(calls(s), calls(l)), 5, SIZES, {}).filter((x) => x.flag === "n_plus_one");
  it("fires at 3x, not at 2.9x", () => {
    expect(f(10, 30)).toHaveLength(1);
    expect(f(10, 29)).toHaveLength(0);
  });
  it("needs S > 0 and both sizes", () => {
    expect(f(0, 30)).toHaveLength(0);
    expect(computeFlags(raw(undefined, calls(30)), 5, SIZES, {})).toEqual([]);
    expect(computeFlags(raw(calls(10), undefined), 5, SIZES, {})).toEqual([]);
  });
});

const plan = [{
  Plan: {
    "Node Type": "Limit", Plans: [
      { "Node Type": "Nested Loop", Plans: [
        { "Node Type": "Seq Scan", "Relation Name": "users", Schema: "public", Filter: "(email = $1)" },
        { "Node Type": "Seq Scan", "Relation Name": "feed", Schema: "public" },
        { "Node Type": "Index Scan", "Relation Name": "projects", Schema: "public" },
      ] },
    ],
  },
}];

describe("missing_index (AC3)", () => {
  it("seqScans walks nested plans, only Seq Scan with Filter", () => {
    expect(seqScans(plan)).toEqual([{ schema: "public", table: "users", filter: "(email = $1)" }]);
    expect(seqScans([{ Plan: { "Node Type": "Index Scan", "Relation Name": "users" } }])).toEqual([]);
  });
  const q = (ms: number) => [row("q", "SELECT * FROM users WHERE email = $1", 5, ms, 5)];
  const sc = (rows: number): Record<string, SeqScan[]> => ({ q: [{ table: "users", filter: "(email = $1)", table_rows: rows }] });
  const run = (lms: number, scans: Record<string, SeqScan[]>) => computeFlags(raw(q(5), q(lms)), 5, SIZES, scans).filter((x) => x.flag === "missing_index");
  it("fires at ratio 5 with 10000 rows", () => {
    const [f] = run(25, sc(10000));
    expect(f.evidence.seq_scan?.table).toBe("users");
    expect(f.evidence.by_size).toEqual({ S: 1, L: 5 });
  });
  it("redacts env values and cuts to 500 in query and filter", () => {
    const env = { SECRET: "supersecret123" };
    const qs = (text: string, ms = 25) => [row("q", text, 5, ms, 5)];
    const scans = { q: [{ table: "users", filter: "(email = 'supersecret123')", table_rows: 10000 }] };
    const [a] = computeFlags(raw(qs("x", 5), qs("SELECT 'supersecret123'")), 5, SIZES, scans, env).filter((x) => x.flag === "missing_index");
    expect(a.evidence.query).toBe("SELECT '[redacted]'");
    expect(a.evidence.seq_scan?.filter).not.toContain("supersecret123");
    expect(a.evidence.seq_scan?.filter).toContain("[redacted]");
    const [b] = computeFlags(raw(qs("x", 5), qs("a".repeat(600))), 5, SIZES, scans, env).filter((x) => x.flag === "missing_index");
    expect(b.evidence.query).toHaveLength(500);
  });
  it("does not fire for ratio 4.9, 9999 rows, no scan evidence", () => {
    expect(run(24.5, sc(10000))).toHaveLength(0);
    expect(run(25, sc(9999))).toHaveLength(0);
    expect(run(25, {})).toHaveLength(0);
  });
});

describe("unbounded_fetch (AC4)", () => {
  const f = (s: number, l: number) => computeFlags(raw([row("a", "SELECT 1", 5, 1, s * 5)], [row("a", "SELECT 1", 5, 1, l * 5)]), 5, SIZES, {}).filter((x) => x.flag === "unbounded_fetch");
  it("flags growth with table size", () => {
    expect(f(2000, 200000)).toHaveLength(1);
    expect(f(1000, 50000)).toHaveLength(1);
    expect(f(1000, 49000)).toHaveLength(0);
  });
  it("does not flag constant pages", () => {
    expect(f(20, 20)).toHaveLength(0);
    expect(f(1, 1)).toHaveLength(0);
  });
  it("does not flag a constant page size at S=1000, L=2000 (AC6)", () => {
    expect(computeFlags(raw([row("a", "S", 5, 1, 100)], [row("a", "S", 5, 1, 100)]), 5, { S: 1000, M: 1500, L: 2000 }, {})).toEqual([]);
  });
  it("does not flag when sizes do not grow", () => {
    expect(computeFlags(raw([row("a", "S", 5, 1, 5)], [row("a", "S", 5, 1, 50)]), 5, { S: 1000, M: 1000, L: 1000 }, {})).toEqual([]);
  });
});

describe("explainCandidates (AC8)", () => {
  it("selects only select/with without ; or backslash, top 10 by time", () => {
    const rows = [
      row("1", "SELECT 1; DROP TABLE x", 1, 99, 0),
      row("2", "INSERT INTO t VALUES ($1)", 1, 98, 0),
      row("3", "  with a as (select 1) select * from a", 1, 5, 0),
      row("4", "SELECT 'a\\b'", 1, 4, 0),
      ...Array.from({ length: 12 }, (_, i) => row(`x${i}`, `SELECT ${i} FROM t`, 1, 10 + i, 0)),
    ];
    const c = explainCandidates(rows);
    expect(c).toHaveLength(10);
    expect(c.every((t) => /^\s*(select|with)\b/i.test(t) && !/[;\\]/.test(t))).toBe(true);
    expect(c[0]).toBe("SELECT 11 FROM t");
  });
});

describe("explainCandidates trailing ; (B6)", () => {
  it("keeps a query with one trailing ; (stripped) and still rejects embedded ;", () => {
    const c = explainCandidates([row("1", "SELECT * FROM t WHERE a = $1;", 1, 9, 0), row("2", "SELECT 1; DROP x", 1, 8, 0), row("3", "SELECT 1; DROP x;", 1, 7, 0)]);
    expect(c).toEqual(["SELECT * FROM t WHERE a = $1"]);
  });
});
