import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectApp, fromImages, hostBuildDir, healthPath, Unsupported } from "../src/sandbox/detect.js";

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
    expect(detectApp("fixtures/express-pg")).toEqual({ framework: "node", dockerfile: "template", buildCmd: "true", start: ["npm", "run", "start"], startSource: "script", migrations: { kind: "sql", files: ["migrations/001_init.sql"] } });
  });
  it("next-drizzle", () => {
    expect(detectApp("fixtures/next-drizzle")).toEqual({ framework: "nextjs", dockerfile: "template", buildCmd: "npm run build", start: ["npm", "run", "start"], startSource: "script", migrations: { kind: "drizzle", cmd: ["node_modules/.bin/drizzle-kit", "push"] } });
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

describe("host-built Dockerfile falls back", () => {
  it.each(["COPY dist/api api", "ADD ./build /app", "COPY node_modules ./node_modules", "COPY --chown=a:b dist /x"])("%s -> template", (l) => {
    const d = proj({ scripts: { start: "node a.js" } }, { Dockerfile: `FROM node\n${l}\n` });
    expect(detectApp(d)).toMatchObject({ dockerfile: "template", start: ["npm", "run", "start"] });
  });
  it.each(["COPY --from=builder /app/dist ./dist", "COPY . ."])("%s -> project", (l) => {
    expect(detectApp(proj({ scripts: { start: "node a.js" } }, { Dockerfile: `FROM node\n${l}\n` })).dockerfile).toBe("project");
  });
  it("hostBuildDir names the dir", () => {
    expect(hostBuildDir("COPY ./dist/api api")).toBe("dist");
    expect(hostBuildDir("COPY package.json ./")).toBeNull();
  });
  it("nx serve is a dev server", () => {
    expect(() => detectApp(proj({ scripts: { start: "nx serve" } }, { Dockerfile: "COPY dist/api api" }))).toThrow(/dev server/);
  });
});

describe("start from project Dockerfile (D-063)", () => {
  const nx = { scripts: { start: "nx serve", build: "nx build" } };
  const df = (copy: string, cmd: string) => proj(nx, { Dockerfile: `FROM node:lts-alpine\nWORKDIR /app\n${copy}\n${cmd}\n` });
  it("AC1", () => {
    const p = detectApp(df("COPY dist/api api", 'CMD ["node","api"]'));
    expect(p).toMatchObject({ dockerfile: "template", start: ["node", "dist/api"], buildCmd: "npm run build", startFromDockerfile: true });
  });
  it.each([
    ["COPY ./dist/api ./api", 'CMD ["node","api/main.js"]', ["node", "dist/api/main.js"]],
    ["COPY dist/api api", 'ENTRYPOINT ["node"]\nCMD ["api"]', ["node", "dist/api"]],
    ["COPY dist/api api", 'CMD ["node","--enable-source-maps","api"]', ["node", "--enable-source-maps", "dist/api"]],
    ["COPY dist/api /app/api", 'CMD ["node","api"]', ["node", "dist/api"]],
  ])("%s + %s", (c, m, want) => {
    expect(detectApp(df(c, m)).start).toEqual(want);
  });
  it.each(["CMD node api", 'CMD ["npm","start"]', 'CMD ["node","$ENTRY"]', 'CMD ["node","/x/api"]', 'CMD ["node","../api"]', 'CMD ["node","other"]', ""])("not derivable: %s", (m) => {
    expect(() => detectApp(df("COPY dist/api api", m))).toThrow(/dev server/);
  });
  it("hint only for short CMD without $", () => {
    expect(() => detectApp(df("COPY dist/api api", 'CMD ["npm","start"]'))).toThrow(/starts it with \["npm","start"\]/);
    expect(() => detectApp(df("COPY dist/api api", 'CMD ["node","$ENTRY"]'))).not.toThrow(/starts it with/);
    expect(() => detectApp(df("COPY dist/api api", ""))).not.toThrow(/starts it with/);
  });
  it.each([
    ["COPY dist/main.js .", 'CMD ["node","main.js"]', ["node", "dist/main.js"]],
    ["COPY dist/main.js /app/", 'CMD ["node","main.js"]', ["node", "dist/main.js"]],
    ["COPY dist/api/main.js ./", 'CMD ["node","main.js"]', ["node", "dist/api/main.js"]],
    ["COPY dist/main.js app.js", 'CMD ["node","app.js"]', ["node", "dist/main.js"]],
  ])("R1-1 file source: %s + %s", (c, m, want) => {
    expect(detectApp(df(c, m)).start).toEqual(want);
  });
  it("R1-1 file source does not map other paths", () => {
    expect(() => detectApp(df("COPY dist/main.js .", 'CMD ["node","other.js"]'))).toThrow(/dev server/);
  });
  it("R1-2 last CMD/ENTRYPOINT wins", () => {
    expect(detectApp(df("COPY dist/api api", 'CMD ["node","x"]\nCMD ["node","api"]')).start).toEqual(["node", "dist/api"]);
    expect(detectApp(df("COPY dist/api api", 'CMD ["api"]\nENTRYPOINT ["node"]\nCMD ["api"]')).start).toEqual(["node", "dist/api"]);
    expect(() => detectApp(df("COPY dist/api api", 'CMD ["node","api"]\nCMD ["npm","start"]'))).toThrow(/dev server/);
  });
  it("R1-3 CRLF Dockerfile", () => {
    const d = 'FROM node:lts-alpine\r\nWORKDIR /app\r\nCOPY dist/api api\r\nCMD ["node","api"]\r\n';
    expect(detectApp(proj(nx, { Dockerfile: d })).start).toEqual(["node", "dist/api"]);
    expect(hostBuildDir(d)).toBe("dist");
    expect(fromImages(d)).toEqual(["node:lts-alpine"]);
  });
  it("valid start script or main wins", () => {
    expect(detectApp(proj({ scripts: { start: "node a.js" } }, { Dockerfile: 'COPY dist/api api\nCMD ["node","api"]' })).start).toEqual(["npm", "run", "start"]);
  });
});

describe("migrations", () => {
  const m = (files: Record<string, string>) => detectApp(proj({ scripts: { start: "node a.js" } }, files)).migrations;
  it("prisma", () => {
    expect(m({ "prisma/schema.prisma": "", "prisma/migrations/x.sql": "" })).toEqual({ kind: "prisma", cmd: ["node_modules/.bin/prisma", "migrate", "deploy"] });
    expect(m({ "prisma/schema.prisma": "" })).toEqual({ kind: "prisma", cmd: ["node_modules/.bin/prisma", "db", "push", "--skip-generate"] });
  });
  it("prisma custom schema path", () => {
    const mm = (schema: unknown, files: Record<string, string>) => detectApp(proj({ scripts: { start: "node a.js" }, prisma: { schema } }, files)).migrations;
    const s = "src/prisma/schema.prisma";
    expect(mm(s, { [s]: "", "src/prisma/migrations/x.sql": "" })).toEqual({ kind: "prisma", cmd: ["node_modules/.bin/prisma", "migrate", "deploy"] });
    expect(mm(s, { [s]: "" })).toEqual({ kind: "prisma", cmd: ["node_modules/.bin/prisma", "db", "push", "--skip-generate"] });
    expect(mm(5, { "prisma/schema.prisma": "" })).toMatchObject({ kind: "prisma" });
    expect(mm(s, {})).toEqual({ kind: "none" });
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

describe("prisma generate in build", () => {
  const b = (pkg: object, files: Record<string, string>) => detectApp(proj({ scripts: { start: "node a.js", build: "tsc" }, ...pkg }, files)).buildCmd;
  it("prepends generate with the schema path, only when the prisma CLI is a dependency", () => {
    const s = "src/prisma/schema.prisma";
    expect(b({ devDependencies: { prisma: "6" }, prisma: { schema: s } }, { [s]: "" })).toBe("node_modules/.bin/prisma generate --schema src/prisma/schema.prisma && npm run build");
    expect(b({ dependencies: { "@prisma/client": "6" } }, { "prisma/schema.prisma": "" })).toBe("npm run build");
    expect(b({ devDependencies: { prisma: "6" }, prisma: { schema: "src/a b.prisma" } }, { "src/a b.prisma": "" })).toBe("npm run build");
  });
});
