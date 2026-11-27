import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeFile } from "../src/sandbox/compose.js";
import { detectApp, Unsupported } from "../src/sandbox/detect.js";
import { parseRunJson } from "../src/sandbox/run-json.js";
import { createSandbox, newRunId, runDir } from "../src/sandbox/sandbox.js";

const p = (o: unknown) => parseRunJson(JSON.stringify(o));
const proj = (pkg: object, files: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "vbrj-"));
  writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), t); }
  return d;
};

describe("parseRunJson (AC2)", () => {
  it("accepts valid input", () => {
    expect(p({ build: ["npm", "run", "build"], start: ["node", "src/server.js"], env_names: ["A_B", "A_B", "C1"] })).toEqual({ build: ["npm", "run", "build"], start: ["node", "src/server.js"], env_names: ["A_B", "C1"] });
    expect(p({ build: null })).toEqual({ build: null });
    expect(p({ start: ["node_modules/.bin/next", "start", "-p", "3000"] })).toBeTruthy();
    expect(p({})).toEqual({});
  });
  const rejects: [string, unknown][] = [
    ["bad first token", { start: ["sh", "x.js"] }],
    ["bad first token path", { start: ["./node", "x"] }],
    ["semicolon", { start: ["node", "a.js;rm"] }],
    ["space", { start: ["node a.js"] }],
    ["dollar", { build: ["npm", "$X"] }],
    ["backtick", { build: ["npm", "`x`"] }],
    ["ampersand", { build: ["npm", "&&"] }],
    ["dotdot", { start: ["node", "../x.js"] }],
    ["absolute", { start: ["node", "/etc/x.js"] }],
    ["value key env", { env: { A: "b" } }],
    ["value key env_values", { env_names: ["A"], env_values: {} }],
    ["name with value", { env_names: ["A=b"] }],
    ["too many tokens", { start: ["node", ...Array(12).fill("a")] }],
    ["long token", { start: ["node", "a".repeat(121)] }],
    ["empty array", { start: [] }],
    ["string not array", { start: "node a.js" }],
    ["51 names", { env_names: Array.from({ length: 51 }, (_, i) => `N${i}`) }],
    ["not object", []],
    ["npx", { start: ["npx", "next", "start"] }],
    ["npm exec", { build: ["npm", "exec", "x"] }],
    ["pnpm dlx", { build: ["pnpm", "dlx", "x"] }],
    ["registry flag", { build: ["npm", "run", "build", "--registry=https://e.x"] }],
    ["node -e", { start: ["node", "-e", "1"] }],
    ["node --eval=", { start: ["node", "--eval=1"] }],
    ["node -r", { start: ["node", "-r", "x.js", "a.js"] }],
    ["node --import=", { start: ["node", "--import=x.mjs", "a.js"] }],
    ["node --loader", { start: ["node", "--loader", "x.mjs", "a.js"] }],
  ];
  for (const [n, v] of rejects) it(`rejects ${n}`, () => expect(() => p(v)).toThrow(/^run\.json: /));
  it("still accepts normal flags and package manager scripts", () => {
    expect(p({ start: ["node", "--enable-source-maps", "dist/main.js"], build: ["pnpm", "run", "build"] })).toBeTruthy();
    expect(p({ start: ["node_modules/.bin/next", "start", "-p", "3000"] })).toBeTruthy();
  });
  it("reserved env names are listed", async () => {
    const { RESERVED_ENV } = await import("../src/sandbox/run-json.js");
    for (const n of ["BUILD_CMD", "PATH", "NODE_OPTIONS", "npm_config_registry", "PNPM_CONFIG_X", "YARN_NPM_REGISTRY_SERVER", "COREPACK_HOME", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) expect(RESERVED_ENV.test(n)).toBe(true);
    for (const n of ["DATABASE_URL", "NEXT_PUBLIC_X", "SOME_SECRET"]) expect(RESERVED_ENV.test(n)).toBe(false);
  });
  it("invalid JSON message has no input text", () => {
    expect(() => parseRunJson("{ SECRETWORD")).toThrow("run.json: invalid JSON");
    try { parseRunJson("{ SECRETWORD"); } catch (e) { expect(String(e)).not.toContain("SECRETWORD"); }
  });
});

describe("detectApp run.json precedence (AC2, AC4)", () => {
  it("run.json start/build override detected values", () => {
    const d = proj({ scripts: { start: "node a.js", build: "x" } });
    const r = detectApp(d, { start: ["node", "z.js"], build: ["pnpm", "run", "b"] });
    expect(r).toMatchObject({ start: ["node", "z.js"], startSource: "run.json", buildCmd: "pnpm run b" });
    expect(detectApp(d, { build: null }).buildCmd).toBe("true");
    expect(detectApp(d)).toMatchObject({ startSource: "script", buildCmd: "npm run build" });
  });
  it("prisma generate is still prepended", () => {
    const d = proj({ dependencies: { prisma: "1" }, scripts: { start: "node a.js" } }, { "prisma/schema.prisma": "" });
    expect(detectApp(d, { build: ["npm", "run", "b"] }).buildCmd).toBe("node_modules/.bin/prisma generate --schema prisma/schema.prisma && npm run b");
  });
  it("dev-like or missing start: unsupported with runJsonCanFix, runnable with run.json", () => {
    for (const d of [proj({ scripts: { start: "next dev" } }), proj({})]) {
      try { detectApp(d); throw new Error("no throw"); } catch (e) { expect(e).toBeInstanceOf(Unsupported); expect((e as Unsupported).runJsonCanFix).toBe(true); }
      expect(detectApp(d, { start: ["node", "s.js"] }).start).toEqual(["node", "s.js"]);
    }
    try { detectApp(proj({ dependencies: { "@supabase/supabase-js": "1" } })); } catch (e) { expect((e as Unsupported).runJsonCanFix).toBe(false); }
  });
  it("project Dockerfile: build/start ignored", () => {
    const d = proj({ scripts: { start: "node a.js" } }, { Dockerfile: "FROM node" });
    expect(detectApp(d, { start: ["node", "z.js"], build: ["npm", "run", "b"] })).toMatchObject({ dockerfile: "project", start: null, buildCmd: "true", startSource: "project Dockerfile" });
  });
});

describe("createSandbox with run.json (AC2)", () => {
  const mk = (d: string, run?: object) => {
    const id = newRunId();
    try { return { sb: createSandbox(d, id, "small", "/m", "/t/node.Dockerfile", run), id, env: readFileSync(join(runDir(id), "test.env"), "utf8") }; }
    catch (e) { rmSync(runDir(id), { recursive: true, force: true }); throw e; }
  };
  it("merges env_names and applies start (template)", () => {
    const { sb, id, env } = mk(proj({ scripts: { start: "node a.js" } }), { env_names: ["SOME_SECRET", "PATH"], start: ["node", "q.js"] });
    try {
      expect(env).toMatch(/^SOME_SECRET=/m);
      expect(env).not.toMatch(/^PATH=/m);
      expect(sb.plan.start).toEqual(["node", "q.js"]);
    } finally { rmSync(runDir(id), { recursive: true, force: true }); }
  });
  it("project Dockerfile: env_names applied, start ignored", () => {
    const { sb, id, env } = mk(proj({ scripts: { start: "node a.js" } }, { Dockerfile: "FROM node" }), { env_names: ["SOME_SECRET"], start: ["node", "q.js"] });
    try {
      expect(env).toMatch(/^SOME_SECRET=/m);
      expect(sb.plan.start).toBeNull();
      const c = JSON.parse(readFileSync(sb.composePath, "utf8"));
      expect(c.secrets).toBeUndefined();
      expect(c.services.app.build.secrets).toBeUndefined();
    } finally { rmSync(runDir(id), { recursive: true, force: true }); }
  });
});

describe("compose build secret (AC5)", () => {
  const f = (app: object, envFile = "/e") => composeFile({ runId: "vb-1", profile: "small", dbPassword: "x", envFile, mockDir: "/m", app: { context: "/c", dockerfile: "/d", healthPath: "/", ...app } }) as any;
  it("template path has top-level and build secrets", () => {
    const c = f({ buildCmd: "true" }, "/tmp/a$b/test.env");
    expect(c.secrets).toEqual({ vbenv: { file: "/tmp/a$$b/test.env" } });
    expect(c.services.app.build.secrets).toEqual(["vbenv"]);
    expect(c.services.app.env_file).toEqual(["/tmp/a$b/test.env"]);
  });
  it("project Dockerfile path has neither", () => {
    const c = f({});
    expect(c.secrets).toBeUndefined();
    expect(c.services.app.build.secrets).toBeUndefined();
  });
});

const dockerUp = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

describe("run.json file handling", () => {
  it.skipIf(!dockerUp)("symlink run.json is rejected by the CLI", async () => {
    const { spawnSync } = await import("node:child_process");
    const d = proj({ scripts: { start: "node a.js" } });
    mkdirSync(join(d, ".vibe-breakpoint"));
    writeFileSync(join(d, "real.json"), "{}");
    symlinkSync(join(d, "real.json"), join(d, ".vibe-breakpoint/run.json"));
    const r = spawnSync("node", ["skills/vibe-breakpoint/scripts/vibe-breakpoint.mjs", "run", d], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("run.json must be a regular file");
  });
});
