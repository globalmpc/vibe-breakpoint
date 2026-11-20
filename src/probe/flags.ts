import type { Size } from "../seed/seed.js";
import { safeText, type RawProbe, type StatRow } from "./probe.js";

export type FlagKind = "n_plus_one" | "missing_index" | "unbounded_fetch";
export type SeqScan = { table: string; filter: string; table_rows: number };
export type Flag = {
  flag: FlagKind;
  endpoint: string;
  evidence: { metric: "queries_per_req" | "mean_ms" | "rows_per_req"; by_size: Partial<Record<Size, number>>; query?: string; seq_scan?: SeqScan };
  cause: string;
  fix: string;
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** Walks an EXPLAIN (FORMAT JSON) result; returns Seq Scan nodes that carry a Filter. */
export function seqScans(planJson: unknown): { schema: string; table: string; filter: string }[] {
  const out: { schema: string; table: string; filter: string }[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!isObj(x)) return;
    if (x["Node Type"] === "Seq Scan" && typeof x["Filter"] === "string" && typeof x["Relation Name"] === "string") {
      out.push({ schema: typeof x["Schema"] === "string" ? x["Schema"] : "", table: x["Relation Name"], filter: x["Filter"] });
    }
    walk(x["Plan"]);
    walk(x["Plans"]);
  };
  walk(planJson);
  return out;
}

const SIZE_ORDER: Size[] = ["S", "M", "L"];
const sumOf = (rows: StatRow[], f: (r: StatRow) => number) => rows.reduce((a, r) => a + f(r), 0);

export function computeFlags(raw: RawProbe, n: number, sizes: Record<Size, number>, scans: Record<string, SeqScan[]>, env: Record<string, string> = {}): Flag[] {
  const flags: Flag[] = [];
  const g = sizes.L / sizes.S;
  for (const endpoint of Object.keys(raw)) {
    const by = raw[endpoint];
    const S = by.S, L = by.L;
    if (!S || !L) continue;
    const per = (f: (r: StatRow) => number) => {
      const o: Partial<Record<Size, number>> = {};
      for (const z of SIZE_ORDER) if (by[z]) o[z] = r2(sumOf(by[z]!, f) / n);
      return o;
    };
    const qS = sumOf(S, (r) => r.calls) / n, qL = sumOf(L, (r) => r.calls) / n;
    if (qS > 0 && qL >= 3 * qS) {
      flags.push({
        flag: "n_plus_one", endpoint,
        evidence: { metric: "queries_per_req", by_size: per((r) => r.calls) },
        cause: "The number of database queries per request grows with the amount of data, which usually means a query runs once per row inside a loop.",
        fix: "Fetch the related rows with one query (a join or a WHERE id IN (...) lookup) instead of one query per row.",
      });
    }
    const rS = sumOf(S, (r) => r.rows) / n, rL = sumOf(L, (r) => r.rows) / n;
    if (g >= 2 && rS > 0 && rL > rS && rL >= 0.5 * g * rS) {
      flags.push({
        flag: "unbounded_fetch", endpoint,
        evidence: { metric: "rows_per_req", by_size: per((r) => r.rows) },
        cause: "The rows returned per request grow with the table size, so the endpoint reads everything instead of one page.",
        fix: "Add a LIMIT with pagination (or a cursor) and select only the columns the response needs.",
      });
    }
    for (const ql of L) {
      const qs = S.find((r) => r.queryid === ql.queryid);
      if (!qs || !qs.calls || !ql.calls) continue;
      const mS = qs.total_ms / qs.calls, mL = ql.total_ms / ql.calls;
      if (!(mS > 0 && mL >= 5 * mS)) continue;
      const scan = (scans[ql.queryid] ?? []).find((s) => s.table_rows >= 10000);
      if (!scan) continue;
      const bySize: Partial<Record<Size, number>> = {};
      for (const z of SIZE_ORDER) {
        const row = by[z]?.find((r) => r.queryid === ql.queryid);
        if (row && row.calls) bySize[z] = r2(row.total_ms / row.calls);
      }
      flags.push({
        flag: "missing_index", endpoint,
        evidence: { metric: "mean_ms", by_size: bySize, query: safeText(ql.query, env), seq_scan: { ...scan, filter: safeText(scan.filter, env) } },
        cause: `This query reads every row of "${scan.table}" (Seq Scan) to apply the filter ${safeText(scan.filter, env)}, so it gets slower as the table grows.`,
        fix: `Add an index on the column(s) used in the filter ${safeText(scan.filter, env)} on table "${scan.table}".`,
      });
    }
  }
  return flags.sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : a.flag < b.flag ? -1 : a.flag > b.flag ? 1 : 0));
}
