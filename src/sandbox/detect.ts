import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class Unsupported extends Error {} // message = text after "unsupported because "

export type Migrations =
  | { kind: "prisma" | "drizzle" | "knex"; cmd: string[] }
  | { kind: "sql"; files: string[] }
  | { kind: "none" };
export type AppPlan = {
  framework: "nextjs" | "node";
  dockerfile: "project" | "template";
  buildCmd: string;
  start: string[] | null;
  migrations: Migrations;
};

const OTHER = ["go.mod", "requirements.txt", "pyproject.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle", "Cargo.toml"];
const ENTRIES = ["server.js", "index.js", "app.js", "src/server.js", "src/index.js"];
const DEV_LIKE = /\b(next dev|nodemon|ts-node-dev|vite)\b|--watch|tsx watch/;
const bin = (n: string) => `node_modules/.bin/${n}`;

function detectMigrations(dir: string): Migrations {
  const has = (p: string) => existsSync(join(dir, p));
  if (has("prisma/schema.prisma")) {
    return { kind: "prisma", cmd: has("prisma/migrations") ? [bin("prisma"), "migrate", "deploy"] : [bin("prisma"), "db", "push", "--skip-generate"] };
  }
  const dz = ["ts", "js", "mjs", "cjs"].map((e) => `drizzle.config.${e}`).find(has);
  if (dz) {
    const out = /out:\s*["'`]([^"'`]+)/.exec(readFileSync(join(dir, dz), "utf8"))?.[1] ?? "./drizzle";
    return { kind: "drizzle", cmd: [bin("drizzle-kit"), has(join(out, "meta/_journal.json")) ? "migrate" : "push"] };
  }
  if (["js", "cjs", "mjs", "ts"].some((e) => has(`knexfile.${e}`))) return { kind: "knex", cmd: [bin("knex"), "migrate:latest"] };
  for (const d of ["migrations", "db/migrations"]) {
    if (!has(d)) continue;
    const files = readdirSync(join(dir, d)).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
    if (files.length) return { kind: "sql", files: files.map((f) => `${d}/${f}`) };
  }
  return { kind: "none" };
}

export function detectApp(dir: string): AppPlan {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) {
    const other = OTHER.find((f) => existsSync(join(dir, f)));
    throw new Unsupported(other ? `the backend is not Node (found ${other}); v0.1 supports Node backends only` : "no package.json found; v0.1 supports Node backends only");
  }
  const pkg = JSON.parse(readFileSync(pj, "utf8"));
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  if (["@supabase/supabase-js", "firebase", "firebase-admin"].some((d) => d in deps) && !["pg", "postgres", "@prisma/client", "knex"].some((d) => d in deps)) {
    throw new Unsupported("the app reaches its database through the Supabase/Firebase client API, not a direct Postgres connection");
  }
  const nextjs = "next" in deps;
  const scripts = pkg.scripts ?? {};
  const devLike = typeof scripts.start === "string" && DEV_LIKE.test(scripts.start);
  const project = existsSync(join(dir, "Dockerfile"));
  let start: string[] | null = null;
  if (!project) {
    if (typeof scripts.start === "string" && !devLike) start = ["npm", "run", "start"];
    else if (nextjs) start = [bin("next"), "start"];
    else if (pkg.main && existsSync(join(dir, pkg.main))) start = ["node", pkg.main];
    else {
      const f = ENTRIES.find((e) => existsSync(join(dir, e)));
      if (!f) throw new Unsupported(`no start script and no entry file (looked for: ${ENTRIES.join(", ")})${devLike ? "; the start script runs a dev server" : ""}`);
      start = ["node", f];
    }
  }
  return {
    framework: nextjs ? "nextjs" : "node",
    dockerfile: project ? "project" : "template",
    buildCmd: project ? "true" : scripts.build ? "npm run build" : nextjs ? bin("next") + " build" : "true",
    start,
    migrations: detectMigrations(dir),
  };
}

export function healthPath(projectDir: string): string {
  try {
    const p = String(JSON.parse(readFileSync(join(projectDir, ".vibe-breakpoint/scenario.json"), "utf8")).flow[0].path).split("?")[0];
    return p.startsWith("/") && !p.includes("{{") && !p.includes("$") ? p : "/";
  } catch {
    return "/";
  }
}

export function fromImages(dockerfile: string): string[] {
  const stages = new Set<string>();
  const out = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    const m = /^\s*FROM\s+(.*)$/i.exec(line);
    if (!m) continue;
    const t = m[1].trim().split(/\s+/).filter((x) => !x.startsWith("--"));
    const as = t.findIndex((x) => x.toLowerCase() === "as");
    const img = t[0];
    if (as > 0 && t[as + 1]) stages.add(t[as + 1]);
    if (!img || img === "scratch" || img.includes("$") || stages.has(img)) continue;
    out.add(img);
  }
  return [...out];
}
