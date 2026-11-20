import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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

const scenarios = {
  healthy: { schema: 1, flow: [{ name: "search", method: "GET", path: "/api/users?email={{random.email}}" }], think_time_s: 0 },
  slow: { schema: 1, flow: [
    { name: "login", method: "POST", path: "/api/login", body: { email: "{{user.email}}", password: "{{user.password}}" }, save: { cookie: true } },
    { name: "slow", method: "GET", path: "/api/slow" },
  ], think_time_s: 0 },
};

function project(sc: object): string {
  const d = mkdtempSync(join(tmpdir(), "vbe2e-"));
  cpSync(resolve("fixtures/express-pg"), d, { recursive: true });
  mkdirSync(join(d, ".vibe-breakpoint"));
  cpSync(resolve("fixtures/express-pg/expected/seed.json"), join(d, ".vibe-breakpoint/seed.json"));
  writeFileSync(join(d, ".vibe-breakpoint/scenario.json"), JSON.stringify(sc));
  return d;
}

function run(d: string) {
  const r = spawnSync("node", [bundle, "run", d, "--pull", "--sizes", "M", "--stages", "5,40", "--stage-duration", "5"], { encoding: "utf8", env: { ...process.env, CI: "true" } });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  console.log(out);
  const id = /sandbox ready (vb-\d{14}-[0-9a-f]{4})/.exec(out)?.[1];
  return { r, out, id };
}

beforeAll(() => {
  if (dk("info").status !== 0) throw new Error("Docker is not available (docker info failed)");
  for (const img of ["postgres:16", "node:22-alpine"]) if (dk("image", "inspect", img).status !== 0) throw new Error(`image ${img} missing locally; run: docker pull ${img}`);
});

describe.each(["slow", "healthy"] as const)("load %s", (name) => {
  it("produces result.json, leaves project and Docker clean", () => {
    const d = project(scenarios[name]);
    const tree = treeHash(d);
    const dirsBefore = dirs();
    const { r, out, id } = run(d);
    expect(r.status, out).toBe(0);
    expect(id).toBeTruthy();
    const res = JSON.parse(readFileSync(join(d, ".vibe-breakpoint/out/result.json"), "utf8"));
    console.log(`RESULT ${name}`, JSON.stringify(res));
    expect(Object.keys(res).sort()).toEqual(["breaking_point", "flags", "limiting_resource", "probe", "profile", "run_id", "schema", "size", "stage_duration_s", "stages", "think_time_s", "tool_version"]);
    for (const s of res.stages) expect(Object.keys(s).sort()).toEqual(["app_cpu", "app_mem_mb", "db_cpu", "error_rate", "p50_ms", "p95_ms", "requests", "users"]);
    expect(res.size).toBe("M");
    expect(res.stages.length).toBe(2);
    if (name === "slow") {
      expect(res.breaking_point).toMatchObject({ users_ok: 5, users_broke: 40 });
      expect(res.breaking_point.reason).toContain("p95");
      expect(res.stages[0].error_rate).toBe(0);
      expect(res.limiting_resource).toBe("app_code");
    } else {
      expect(res.breaking_point).toBeNull();
      expect(res.stages[1].requests).toBeGreaterThan(0);
    }
    for (const f of readdirSync(join(d, ".vibe-breakpoint/out/k6"))) {
      expect(Object.keys(JSON.parse(readFileSync(join(d, ".vibe-breakpoint/out/k6", f), "utf8")))).toEqual(["metrics"]);
    }
    expect(treeHash(d)).toBe(tree);
    expect(runResources(id!)).toEqual([]);
    expect(dirs()).toEqual(dirsBefore);
    expect(existsSync(join(d, ".vibe-breakpoint/out/result.json"))).toBe(true);
  });
});
