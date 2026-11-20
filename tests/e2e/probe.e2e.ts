import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRealEnvFile } from "../../src/sandbox/copy.js";
import { RUN_DIR_RE } from "../../src/sandbox/sandbox.js";

const bundle = resolve("plugins/vibe-breakpoint/scripts/vibe-breakpoint.mjs");
const dk = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8" });
const ids = (...a: string[]) => (dk(...a).stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean).sort();
const runResources = (id: string) => [
  ...ids("ps", "-aq", "--filter", `label=vibe-breakpoint.run=${id}`),
  ...ids("network", "ls", "-q", "--filter", `label=vibe-breakpoint.run=${id}`),
  ...ids("volume", "ls", "-q", "--filter", `label=vibe-breakpoint.run=${id}`),
  ...ids("image", "ls", `vb-app:${id}`, "-q"),
];
const dirs = () => readdirSync(tmpdir()).filter((n) => RUN_DIR_RE.test(n)).sort();

// Tree hash outside .vibe-breakpoint/. Real env files: stat only, never read (rule 3).
function treeHash(root: string): string {
  const rows: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name === ".vibe-breakpoint") continue;
      const p = join(d, e.name);
      const st = lstatSync(p);
      if (e.isDirectory()) { rows.push(`${p} d ${st.mtimeMs}`); walk(p); }
      else rows.push(`${p} f ${st.size} ${st.mtimeMs} ${isRealEnvFile(e.name) ? "-" : createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// Derived seed: S 1000 / M 4000 / L 40000, users ratio 0.5 so users >= 10k at L.
const SIZES = { S: 1000, M: 4000, L: 40000 };
function project(fixture: string, extra?: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "vbe2e-"));
  made.push(d);
  cpSync(resolve("fixtures", fixture), d, { recursive: true });
  mkdirSync(join(d, ".vibe-breakpoint"), { recursive: true });
  const seed = JSON.parse(readFileSync(resolve("fixtures", fixture, "expected/seed.json"), "utf8"));
  seed.sizes = SIZES;
  seed.tables.find((t: { name: string }) => t.name === "users").ratio = 0.5;
  writeFileSync(join(d, ".vibe-breakpoint/seed.json"), JSON.stringify(seed));
  cpSync(resolve("fixtures", fixture, "expected/scenario.json"), join(d, ".vibe-breakpoint/scenario.json"));
  for (const [f, c] of Object.entries(extra ?? {})) writeFileSync(join(d, f), c);
  return d;
}

function allFiles(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}

type Flag = { flag: string; endpoint: string; evidence: { seq_scan?: { table: string; filter: string } } };
const flagsFor = (res: { flags: Flag[] }, ep: string) => res.flags.filter((f) => f.endpoint === ep);
const kinds = (res: { flags: Flag[] }, ep: string) => flagsFor(res, ep).map((f) => f.flag);

// Runs the bundle and checks the global invariants (untouched, no secrets/cookies, cleanup).
function runChecked(d: string, sizes: string, label: string) {
  const tree = treeHash(d);
  const dirsBefore = dirs();
  const ins = spawnSync("node", [bundle, "inspect", d], { encoding: "utf8", env: { ...process.env, CI: "true" } });
  expect(ins.status, (ins.stdout ?? "") + (ins.stderr ?? "")).toBe(0);
  const insp = JSON.parse(ins.stdout);
  expect(insp.docker.available).toBe(true);
  expect(insp.missing_images).toEqual([]);
  expect([insp.has_scenario, insp.has_seed]).toEqual([true, true]);
  const t0 = Date.now();
  const r = spawnSync("node", [bundle, "run", d, "--pull", "--sizes", sizes, "--stages", "5", "--stage-duration", "5"], { encoding: "utf8", env: { ...process.env, CI: "true" }, maxBuffer: 64 << 20 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  console.log(`[${label}] wall ${Math.round((Date.now() - t0) / 1000)}s\n${out}`);
  expect(r.status, out).toBe(0);
  const id = /sandbox ready (vb-\d{14}-[0-9a-f]{4})/.exec(out)?.[1];
  expect(id).toBeTruthy();
  const outDir = join(d, ".vibe-breakpoint/out");
  expect(existsSync(join(outDir, "result.json"))).toBe(true);
  const rr = spawnSync("node", [bundle, "render", d], { encoding: "utf8", env: { ...process.env, CI: "true" } });
  expect(rr.status, (rr.stdout ?? "") + (rr.stderr ?? "")).toBe(0);
  for (const f of ["chart.svg", "chart.png", "report.md"]) expect(existsSync(join(outDir, f)), f).toBe(true);
  const res = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
  console.log(`[${label}] PROBE ${JSON.stringify(res.probe, (k, v) => (k === "top_queries" ? undefined : v))}`);
  const texts = [out, ...allFiles(outDir).map((f) => readFileSync(f, "utf8"))];
  for (const t of texts) {
    expect(t).not.toContain("FAKESECRET_");
    expect(t).not.toContain("VB_PROBE");
    expect(t).not.toContain("session=");
  }
  expect(treeHash(d)).toBe(tree);
  expect(runResources(id!)).toEqual([]);
  expect(dirs()).toEqual(dirsBefore);
  return { out, res };
}

const probed = ["GET /api/projects", "GET /api/users", "GET /api/feed"];

beforeAll(() => {
  if (dk("info").status !== 0) throw new Error("Docker is not available (docker info failed)");
  for (const img of ["postgres:16", "node:22-alpine", "grafana/k6"]) if (dk("image", "inspect", img).status !== 0) throw new Error(`image ${img} missing locally; run: docker pull ${img}`);
});

describe("probe", () => {
  it("express-pg: flags n_plus_one, missing_index, unbounded_fetch", () => {
    const { out, res } = runChecked(project("express-pg"), "S,M,L", "express-pg");
    expect(res).toHaveProperty("probe");
    expect(res).toHaveProperty("flags");
    expect(Array.isArray(res.stages)).toBe(true);
    expect(res.stages.length).toBe(1);
    expect(out).toMatch(/vibe-breakpoint: probe GET \/api\/users size L:/);

    expect(kinds(res, "GET /api/projects")).toEqual(expect.arrayContaining(["n_plus_one", "unbounded_fetch"]));
    const mi = flagsFor(res, "GET /api/users").filter((f) => f.flag === "missing_index");
    expect(mi.length).toBeGreaterThan(0);
    expect(mi[0].evidence.seq_scan?.table).toBe("users");
    expect(mi[0].evidence.seq_scan?.filter).toContain("email");
    expect(kinds(res, "GET /api/feed")).toContain("unbounded_fetch");
    expect(kinds(res, "GET /api/feed")).not.toContain("missing_index");
    for (const f of res.flags as Flag[]) expect(probed).toContain(f.endpoint);

    expect(Object.keys(res.probe).sort()).toEqual([...probed].sort());
    for (const ep of probed) expect(Object.keys(res.probe[ep]).sort()).toEqual(["L", "M", "S"]);
    expect(res.probe["GET /api/projects"].L.queries_per_req / res.probe["GET /api/projects"].S.queries_per_req).toBeGreaterThanOrEqual(3);
  });

  it("express-pg: an index on users(email) clears missing_index", () => {
    const d = project("express-pg", { "migrations/002_email_index.sql": "CREATE INDEX users_email_idx ON users (email);\n" });
    const { res } = runChecked(d, "S,M,L", "express-pg+index");
    expect(kinds(res, "GET /api/users")).not.toContain("missing_index");
    expect(kinds(res, "GET /api/projects")).toContain("n_plus_one");
    expect(kinds(res, "GET /api/feed")).toContain("unbounded_fetch");
  });

  it("express-pg: --sizes M skips flags", () => {
    const { out, res } = runChecked(project("express-pg"), "M", "express-pg M-only");
    expect(out).toContain("flags need sizes S and L; skipping flags");
    expect(res.flags).toEqual([]);
    expect(Object.keys(res.probe).sort()).toEqual([...probed].sort());
  });

  it("next-drizzle: flags n_plus_one and missing_index", () => {
    const { res } = runChecked(project("next-drizzle"), "S,M,L", "next-drizzle");
    expect(kinds(res, "GET /api/projects")).toContain("n_plus_one");
    expect(kinds(res, "GET /api/users")).toContain("missing_index");
  });
});
