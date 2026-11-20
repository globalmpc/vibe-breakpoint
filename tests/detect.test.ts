import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectApp, fromImages, healthPath, Unsupported } from "../src/sandbox/detect.js";

const tmp = () => mkdtempSync(join(tmpdir(), "vbdetect-"));
const put = (root: string, rel: string, text = "") => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const proj = (pkg: object, files: Record<string, string> = {}) => {
  const d = tmp();
  put(d, "package.json", JSON.stringify(pkg));
  for (const [f, t] of Object.entries(files)) put(d, f, t);
  return d;
};

describe("detectApp fixtures (AC5)", () => {
  it("express-pg", () => {
    expect(detectApp("fixtures/express-pg")).toEqual({ framework: "node", dockerfile: "template", buildCmd: "true", start: ["npm", "run", "start"], migrations: { kind: "sql", files: ["migrations/001_init.sql"] } });
  });
  it("next-drizzle", () => {
    expect(detectApp("fixtures/next-drizzle")).toEqual({ framework: "nextjs", dockerfile: "template", buildCmd: "npm run build", start: ["npm", "run", "start"], migrations: { kind: "drizzle", cmd: ["node_modules/.bin/drizzle-kit", "push"] } });
  });
});

describe("detectApp unsupported and start", () => {
  it("go.mod only", () => {
    const d = tmp();
    put(d, "go.mod");
    expect(() => detectApp(d)).toThrow(/go\.mod.*Node/);
    expect(() => detectApp(tmp())).toThrow(Unsupported);
  });
  it("supabase without/with pg", () => {
    expect(() => detectApp(proj({ dependencies: { "@supabase/supabase-js": "1" }, main: "x.js" }))).toThrow(/Supabase\/Firebase client API/);
    expect(() => detectApp(proj({ dependencies: { "@supabase/supabase-js": "1", pg: "1" } }, { "server.js": "" }))).not.toThrow();
  });
  it("next dev start becomes next start", () => {
    const p = detectApp(proj({ dependencies: { next: "14" }, scripts: { start: "next dev" } }));
    expect(p.start).toEqual(["node_modules/.bin/next", "start"]);
    expect(p.buildCmd).toBe("node_modules/.bin/next build");
  });
  it("nodemon with no entry", () => {
    expect(() => detectApp(proj({ scripts: { start: "nodemon x.js" } }))).toThrow(/no start script/);
  });
  it("entry file fallback and project Dockerfile", () => {
    expect(detectApp(proj({}, { "src/index.js": "" })).start).toEqual(["node", "src/index.js"]);
    const p = detectApp(proj({ scripts: { start: "node a.js" } }, { Dockerfile: "FROM node" }));
    expect(p.dockerfile).toBe("project");
    expect(p.start).toBeNull();
  });
});

describe("migrations", () => {
  const m = (files: Record<string, string>) => detectApp(proj({ scripts: { start: "node a.js" } }, files)).migrations;
  it("prisma", () => {
    expect(m({ "prisma/schema.prisma": "", "prisma/migrations/x.sql": "" })).toEqual({ kind: "prisma", cmd: ["node_modules/.bin/prisma", "migrate", "deploy"] });
    expect(m({ "prisma/schema.prisma": "" })).toEqual({ kind: "prisma", cmd: ["node_modules/.bin/prisma", "db", "push", "--skip-generate"] });
  });
  it("drizzle", () => {
    const cfg = `export default { out: "./db/out" }`;
    expect(m({ "drizzle.config.ts": cfg, "db/out/meta/_journal.json": "{}" })).toEqual({ kind: "drizzle", cmd: ["node_modules/.bin/drizzle-kit", "migrate"] });
    expect(m({ "drizzle.config.ts": cfg })).toEqual({ kind: "drizzle", cmd: ["node_modules/.bin/drizzle-kit", "push"] });
  });
  it("knex, sql, none", () => {
    expect(m({ "knexfile.js": "" })).toEqual({ kind: "knex", cmd: ["node_modules/.bin/knex", "migrate:latest"] });
    expect(m({ "migrations/010_b.sql": "", "migrations/002_a.sql": "", "migrations/002_a.down.sql": "" })).toEqual({ kind: "sql", files: ["migrations/002_a.sql", "migrations/010_b.sql"] });
    expect(m({})).toEqual({ kind: "none" });
  });
});

describe("healthPath", () => {
  const withScenario = (path?: string) => {
    const d = tmp();
    if (path !== undefined) put(d, ".vibe-breakpoint/scenario.json", JSON.stringify({ flow: [{ path }] }));
    return d;
  };
  it.each([[undefined, "/"], ["/api/users?email={{random.email}}", "/api/users"], ["api/x", "/"], ["/a/{{id}}", "/"], ["/ok", "/ok"]])("%s -> %s", (i, o) => {
    expect(healthPath(withScenario(i))).toBe(o);
  });
});

describe("fromImages", () => {
  it("skips stages, scratch, platform vars", () => {
    expect(fromImages("FROM node:20 AS build\nFROM build\nFROM --platform=$X node:18\nFROM scratch\nFROM nginx:1 AS web\nFROM ${BASE}\n")).toEqual(["node:20", "node:18", "nginx:1"]);
  });
});
