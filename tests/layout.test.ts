import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/load/scenario.js";
import { parseRunJson } from "../src/sandbox/run-json.js";
import { parseSeed } from "../src/seed/seed.js";

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const pkg = json("package.json");

describe("manifests", () => {
  it("package.json has a semver version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("skill folder is self-contained (D-057)", () => {
    expect(readdirSync("skills/vibe-breakpoint").sort()).toEqual(["SKILL.md", "assets", "references", "scripts", "templates"]);
    expect(existsSync("plugins")).toBe(false);
    expect(existsSync(".claude-plugin")).toBe(false);
  });
  it("SKILL.md has frontmatter", () => {
    const s = readFileSync("skills/vibe-breakpoint/SKILL.md", "utf8");
    expect(s).toMatch(/^---\n[\s\S]*?^name: vibe-breakpoint$[\s\S]*?^description:[\s\S]*?^---/m);
  });
});

describe("skill", () => {
  const dir = "skills/vibe-breakpoint";
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  it("SKILL.md lint", () => {
    expect(skill).toMatch(/^name: vibe-breakpoint$/m);
    expect(skill).toMatch(/^description:/m);
    for (const t of ["${CLAUDE_SKILL_DIR}/scripts/vibe-breakpoint.mjs", "inspect", "run", "--pull", "render", "cleanup", "run_in_background", "grafana/k6", "code-locations.md", "static-report.md", "No load test ran", "run.json", "app build failed:", "app did not start:", "up to 3 builds"]) expect(skill).toContain(t);
    expect(skill).not.toMatch(/CLAUDE_PLUGIN_ROOT|\$CLAUDE_SKILL_DIR/);
    for (const m of skill.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([^\s"`)]+)/g)) expect(existsSync(join("skills/vibe-breakpoint", m[1])), m[1]).toBe(true);
    expect(skill).toContain("env_names");
    expect(skill.split("\n").length).toBeLessThan(200);
    expect(skill).not.toMatch(/\b(cat|source|less|head|tail|grep)\b[^\n]*\.env(?!\.(example|sample|template))/);
  });
  it("inputs.md examples parse", () => {
    const blocks = [...readFileSync(join(dir, "references/inputs.md"), "utf8").matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const b of blocks.filter((x) => !x.includes('"tables"') && !x.includes('"flow"'))) parseRunJson(b);
    expect(blocks.filter((x) => /"start"/.test(x)).length).toBe(2);
    const seeds = blocks.filter((b) => b.includes('"tables"'));
    const scenarios = blocks.filter((b) => b.includes('"flow"'));
    expect(seeds.length).toBeGreaterThan(0);
    expect(scenarios.length).toBeGreaterThan(0);
    const seed = parseSeed(seeds[0]);
    for (const b of seeds) parseSeed(b);
    for (const b of scenarios) parseScenario(b, seed);
  });
});

describe("assets", () => {
  const dir = "skills/vibe-breakpoint/assets";
  it("holds exactly the expected files", () => {
    expect(readdirSync(dir).sort()).toEqual(["LiberationMono-Bold.ttf", "LiberationMono-LICENSE.txt", "LiberationMono-Regular.ttf", "THIRD-PARTY.md", "resvg-wasm-LICENSE.txt", "resvg.wasm"]);
  });
  it("licence files carry the required notices", () => {
    const f = readFileSync(join(dir, "LiberationMono-LICENSE.txt"), "utf8");
    expect(f).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(f).toContain("Reserved Font Name Liberation");
    const m = readFileSync(join(dir, "resvg-wasm-LICENSE.txt"), "utf8");
    expect(m).toContain("Mozilla Public License Version 2.0");
    expect(m).toContain("github.com/yisibl/resvg-js");
  });
  it("resvg.wasm matches node_modules and the pin is exact", () => {
    const nm = "node_modules/@resvg/resvg-wasm/index_bg.wasm";
    if (existsSync(nm)) expect(readFileSync(join(dir, "resvg.wasm")).equals(readFileSync(nm))).toBe(true);
    expect(json("package.json").devDependencies["@resvg/resvg-wasm"]).toBe("2.6.2");
  });
});

describe("fixtures", () => {
  const names = (s: string) => [...s.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  for (const f of ["express-pg", "next-drizzle"]) {
    it(`${f} expected.json shape`, () => {
      const e = json(`fixtures/${f}/expected/expected.json`);
      expect(e.framework).toBeTypeOf("string");
      expect(e.orm).toBeTypeOf("string");
      expect(e.flags).toBeTypeOf("object");
      expect(e.env_names).toEqual([...e.env_names].sort());
    });
  }
  it("express-pg .env.example names are expected; .env exists", () => {
    const e = json("fixtures/express-pg/expected/expected.json");
    const ex = names(readFileSync("fixtures/express-pg/.env.example", "utf8"));
    expect(ex.length).toBeGreaterThan(0);
    for (const n of ex) expect(e.env_names).toContain(n);
    expect(existsSync("fixtures/express-pg/.env")).toBe(true); // existence only, never read
  });
  it("next-drizzle has no .env.example", () => {
    expect(existsSync("fixtures/next-drizzle/.env.example")).toBe(false);
  });
  it("no node_modules under fixtures", () => {
    for (const f of ["express-pg", "next-drizzle"]) expect(existsSync(`fixtures/${f}/node_modules`)).toBe(false);
  });
});
