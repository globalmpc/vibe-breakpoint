import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bundle = resolve("plugins/vibe-breakpoint/scripts/vibe-breakpoint.mjs");
const version = JSON.parse(readFileSync("plugins/vibe-breakpoint/.claude-plugin/plugin.json", "utf8")).version;
const run = (...args: string[]) => spawnSync("node", [bundle, ...args], { cwd: tmpdir(), encoding: "utf8" });

describe("cli bundle", () => {
  it("--version prints the plugin.json version", () => {
    const r = run("--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });
  it("cleanup and cleanup --all exit 0 (hermetic)", () => {
    const env = { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), "vbcli-")), DOCKER_HOST: "unix:///nonexistent/docker.sock" };
    for (const args of [["cleanup"], ["cleanup", "--all"]]) {
      expect(spawnSync("node", [bundle, ...args], { cwd: tmpdir(), encoding: "utf8", env }).status).toBe(0);
    }
  });
  it("run on a missing project fails with project not found", () => {
    const r = run("run", "/nonexistent");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("project not found");
  });
  describe("inspect", () => {
    const hermetic = { ...process.env, DOCKER_HOST: "unix:///nonexistent/docker.sock" };
    const insp = (d: string, env: NodeJS.ProcessEnv = hermetic, node = "node") => spawnSync(node, [bundle, "inspect", d], { cwd: tmpdir(), encoding: "utf8", env });
    const copy = (f: string) => { const d = mkdtempSync(join(tmpdir(), "vbinsp-")); cpSync(resolve("fixtures", f), d, { recursive: true }); return d; };
    const keys = ["schema", "tool_version", "docker", "supported", "unsupported_reason", "framework", "dockerfile", "migrations", "db_deps", "env_names", "images", "missing_images", "has_scenario", "has_seed"];
    const listing = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.name === ".vibe-breakpoint" ? [] : e.isDirectory() ? [e.name + "/", ...listing(join(root, e.name)).map((x) => `${e.name}/${x}`)] : [`${e.name}:${lstatSync(join(root, e.name)).size}`]));
    for (const [f, fw, mig, deps] of [["express-pg", "node", "sql", ["pg"]], ["next-drizzle", "nextjs", "drizzle", ["drizzle-orm", "pg"]]] as const) {
      it(`${f}: writes inspect.json equal to stdout`, () => {
        const d = copy(f);
        const r = insp(d);
        expect(r.status, r.stderr).toBe(0);
        const file = readFileSync(join(d, ".vibe-breakpoint/inspect.json"), "utf8");
        expect(file.trim()).toBe(r.stdout.trim());
        const j = JSON.parse(file);
        expect(Object.keys(j)).toEqual(keys);
        expect(j.env_names).toEqual(JSON.parse(readFileSync(resolve("fixtures", f, "expected/expected.json"), "utf8")).env_names);
        expect([j.framework, j.migrations, j.db_deps]).toEqual([fw, mig, deps]);
        expect(j.tool_version).toBe(version);
      });
    }
    it("reports an unreachable Docker daemon", () => {
      const j = JSON.parse(insp(copy("express-pg")).stdout);
      expect(j.docker).toEqual({ available: false, reason: "the Docker daemon is not running or not reachable" });
      expect(j.missing_images).toBeNull();
    });
    it("reports a missing docker command", () => {
      const j = JSON.parse(insp(copy("express-pg"), { ...process.env, PATH: mkdtempSync(join(tmpdir(), "vbpath-")) }, process.execPath).stdout);
      expect(j.docker).toEqual({ available: false, reason: "the docker command was not found" });
    });
    it("leaks no env values and changes nothing outside .vibe-breakpoint/", () => {
      const d = copy("express-pg");
      const before = listing(d);
      const r = insp(d);
      expect(r.stdout + r.stderr + readFileSync(join(d, ".vibe-breakpoint/inspect.json"), "utf8")).not.toContain("FAKESECRET_");
      expect(listing(d)).toEqual(before);
      expect(readdirSync(join(d, ".vibe-breakpoint"))).toEqual(["inspect.json"]);
    });
    it("treats unsupported projects as data", () => {
      const d = mkdtempSync(join(tmpdir(), "vbinsp-"));
      writeFileSync(join(d, "go.mod"), "module x\n");
      const r = insp(d);
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.supported).toBe(false);
      expect(j.unsupported_reason).toContain("go.mod");
      expect([j.framework, j.dockerfile, j.migrations, j.images]).toEqual([null, null, null, []]);
    });
    it("never echoes an unparsable package.json", () => {
      const d = mkdtempSync(join(tmpdir(), "vbinsp-"));
      writeFileSync(join(d, "package.json"), "{bad");
      const r = insp(d);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).unsupported_reason).toBe("package.json could not be parsed");
      expect(r.stdout + r.stderr).not.toContain("{bad");
    });
    it("fails on a missing project", () => {
      const r = insp("/nonexistent");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("project not found");
    });
  });
  describe("render", () => {
    const stage = { users: 10, p50_ms: 5, p95_ms: 20, error_rate: 0, requests: 100, app_cpu: 0.2, db_cpu: 0.1, app_mem_mb: 90 };
    const good = { schema: 1, run_id: "vb-1", tool_version: "0.0.1", profile: "small", size: "M", stage_duration_s: 5, think_time_s: 1, stages: [stage], breaking_point: null, limiting_resource: null, probe: {}, flags: [] };
    const proj = () => { const d = mkdtempSync(join(tmpdir(), "vbrender-")); mkdirSync(join(d, ".vibe-breakpoint/out"), { recursive: true }); return d; };
    const out = (d: string, f: string) => join(d, ".vibe-breakpoint/out", f);
    it("writes chart.svg, chart.png and report.md, byte-identical on a second run", () => {
      const d = proj();
      writeFileSync(out(d, "result.json"), JSON.stringify(good));
      writeFileSync(join(d, ".vibe-breakpoint/code-locations.md"), "LOC_MARKER src/a.ts\n");
      const r = run("render", d);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("wrote out/chart.svg, out/chart.png, out/report.md");
      const first = ["chart.svg", "report.md"].map((f) => readFileSync(out(d, f), "utf8"));
      expect(readFileSync(out(d, "chart.png")).length).toBeGreaterThan(20000);
      expect(run("render", d).status).toBe(0);
      expect(["chart.svg", "report.md"].map((f) => readFileSync(out(d, f), "utf8"))).toEqual(first);
      expect(first[1]).toContain("LOC_MARKER src/a.ts");
      expect(first[1]).not.toContain(d);
      expect(first[0]).not.toContain(d);
    });
    it("ignores a symlinked code-locations.md", () => {
      const d = proj();
      writeFileSync(out(d, "result.json"), JSON.stringify(good));
      writeFileSync(join(d, "elsewhere.md"), "SYMLINK_SECRET");
      symlinkSync(join(d, "elsewhere.md"), join(d, ".vibe-breakpoint/code-locations.md"));
      expect(run("render", d).status).toBe(0);
      expect(readFileSync(out(d, "report.md"), "utf8")).not.toContain("SYMLINK_SECRET");
    });
    it("fails without result.json", () => {
      const r = run("render", proj());
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no out/result.json");
    });
    it("never echoes invalid JSON content", () => {
      const d = proj();
      writeFileSync(out(d, "result.json"), "SECRETVALUE_123");
      const r = run("render", d);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not valid JSON");
      expect(r.stderr).not.toContain("SECRETVALUE_123");
    });
    it("refuses a symlinked result.json", () => {
      const d = proj();
      writeFileSync(join(d, "real.json"), JSON.stringify(good));
      symlinkSync(join(d, "real.json"), out(d, "result.json"));
      const r = run("render", d);
      expect(r.status).toBe(1);
      expect(existsSync(out(d, "chart.svg"))).toBe(false);
    });
    it("rejects a wrong shape and a missing project", () => {
      const d = proj();
      writeFileSync(out(d, "result.json"), JSON.stringify({ ...good, schema: 2 }));
      expect(run("render", d).status).toBe(1);
      const r = run("render", "/nonexistent");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("project not found");
    });
  });
  it("unknown command and no args fail", () => {
    expect(run("bogus").status).not.toBe(0);
    expect(run().status).not.toBe(0);
  });
  it("imports only node: modules", () => {
    const src = readFileSync(bundle, "utf8");
    const specs = [...src.matchAll(/(?:from\s*|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });
});

describe("run inputs (B2)", () => {
  const dockerUp = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
  const proj = (file: string, make: (d: string, f: string) => void) => {
    const d = mkdtempSync(join(tmpdir(), "vbcli-"));
    writeFileSync(join(d, "package.json"), "{}");
    mkdirSync(join(d, ".vibe-breakpoint"));
    make(d, join(d, ".vibe-breakpoint", file));
    return d;
  };
  it.skipIf(!dockerUp).each(["seed.json", "scenario.json"])("%s as a symlink or folder fails with a fixed message, exit 1", (name) => {
    for (const make of [(d: string, f: string) => { writeFileSync(join(d, "t"), "sk_live_ABCDEF123456"); symlinkSync(join(d, "t"), f); }, (_d: string, f: string) => mkdirSync(f)]) {
      const r = run("run", proj(name, make));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${name} must be a regular file`);
      expect(r.stderr).not.toContain("sk_live");
    }
  });
  it.skipIf(!dockerUp)("invalid JSON never echoes the input", () => {
    const r = run("run", proj("seed.json", (_d, f) => writeFileSync(f, "sk_live_ABCDEF123456")));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid JSON");
    expect(r.stderr).not.toContain("sk_live");
  });
});
