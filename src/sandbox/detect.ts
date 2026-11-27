import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SKIP_DIRS } from "./copy.js";
import type { RunJson } from "./run-json.js";

export class Unsupported extends Error { constructor(m: string, readonly runJsonCanFix = false) { super(m); } } // message = text after "unsupported because "

export type Migrations =
  | { kind: "prisma" | "drizzle" | "knex"; cmd: string[] }
  | { kind: "sql"; files: string[] }
  | { kind: "none" };
export type AppPlan = {
  framework: "nextjs" | "node";
  dockerfile: "project" | "template";
  buildCmd: string;
  start: string[] | null;
  startFromDockerfile?: true; // D-063
  startSource: "script" | "main" | "entry file" | "dockerfile" | "run.json" | "project Dockerfile";
  migrations: Migrations;
};

const OTHER = ["go.mod", "requirements.txt", "pyproject.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle", "Cargo.toml"];
const ENTRIES = ["server.js", "index.js", "app.js", "src/server.js", "src/index.js"];
const DEV_LIKE = /\b(next dev|nodemon|ts-node-dev|vite|nx serve)\b|--watch|tsx watch/;
const bin = (n: string) => `node_modules/.bin/${n}`;

// first skipped dir (dist, build, ...) that a COPY/ADD without --from takes from the host, else null (D-059)
// ponytail: single-line instructions only (no `\` continuations, no JSON-array form). Add when a real repo uses them.
export function hostBuildDir(dockerfile: string): string | null {
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m) continue;
    const t = m[1].trim().split(/\s+/);
    if (t.some((x) => /^--from\b/.test(x))) continue;
    for (const src of t.filter((x) => !x.startsWith("--")).slice(0, -1)) {
      const seg = src.replace(/^(\.\/)+/, "").split("/")[0];
      if (SKIP_DIRS.has(seg)) return seg;
    }
  }
  return null;
}

// start command from the project Dockerfile when it copies a host-built dir (D-063): `node <path>` mapped through the COPY back to the host dir
// ponytail: single-line, exec-form, `node`-only, one COPY mapping, final stage. Add multi-stage/shell-form/`npm` CMD support when a real repo needs it.
export function dockerfileStart(dockerfile: string): { start: string[] | null; text: string | null } {
  const lines = dockerfile.split(/\r?\n/);
  const last = lines.map((l) => /^\s*FROM\s/i.test(l)).lastIndexOf(true);
  let workdir = "";
  const copies: [string, string][] = [];
  const cmds: { kind: string; text: string }[] = [];
  for (const line of lines.slice(last + 1)) {
    const m = /^\s*(WORKDIR|COPY|ADD|CMD|ENTRYPOINT)\s+(.*)$/i.exec(line);
    if (!m) continue;
    const kind = m[1].toUpperCase(), text = m[2].trim();
    if (kind === "WORKDIR") workdir = text;
    else if (kind === "CMD" || kind === "ENTRYPOINT") cmds.push({ kind, text });
    else {
      const t = text.split(/\s+/);
      if (t.some((x) => /^--from\b/.test(x))) continue;
      const a = t.filter((x) => !x.startsWith("--"));
      if (a.length >= 2) for (const src of a.slice(0, -1)) copies.push([src, a[a.length - 1]]);
    }
  }
  const lastCmd = cmds[cmds.length - 1]?.text ?? null; // Docker uses the last CMD/ENTRYPOINT
  const hint = lastCmd && lastCmd.length <= 80 && !lastCmd.includes("$") ? lastCmd : null;
  const arr = (kind: string): string[] | null => {
    const c = [...cmds].reverse().find((x) => x.kind === kind);
    if (!c) return [];
    try { const v = JSON.parse(c.text); return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null; } catch { return null; }
  };
  const ep = arr("ENTRYPOINT"), cmd = arr("CMD");
  const argv = ep && cmd ? [...ep, ...cmd] : null;
  if (!argv || argv[0] !== "node" || argv.length < 2 || argv.some((x) => x.includes("$") || x.startsWith("/") && !x.startsWith("--") || x.split("/").includes(".."))) return { start: null, text: hint };
  const norm = (x: string) => x.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  const i = argv.findIndex((x, k) => k > 0 && !x.startsWith("-"));
  if (i < 0) return { start: null, text: hint };
  const p = norm(argv[i]);
  for (const [src, destRaw] of copies) {
    let dest = norm(destRaw);
    if (dest.startsWith("/")) {
      const w = norm(workdir);
      if (w && dest === w) dest = ".";
      else if (!w || !dest.startsWith(w + "/")) continue;
      else dest = dest.slice(w.length + 1);
    }
    if (dest === ".") dest = "";
    const s = norm(src);
    if (!SKIP_DIRS.has(s.split("/")[0])) continue;
    if (/\.[^/]+$/.test(s)) { // file source (R1-1): only the file itself can be the entry
      const b = s.split("/").pop()!;
      if (p === dest || p === (dest ? `${dest}/${b}` : b)) { const out = [...argv]; out[i] = s; return { start: out, text: hint }; }
      continue;
    }
    const rest = dest === "" ? p : p === dest ? "" : p.startsWith(dest + "/") ? p.slice(dest.length + 1) : null;
    if (rest === null) continue;
    const out = [...argv];
    out[i] = rest ? `${s}/${rest}` : s;
    return { start: out, text: hint };
  }
  return { start: null, text: hint };
}

function prismaSchema(dir: string, pkg: { prisma?: { schema?: unknown } }): string | null {
  const custom = typeof pkg.prisma?.schema === "string" ? pkg.prisma.schema : "";
  const schema = custom && existsSync(join(dir, custom)) ? custom : "prisma/schema.prisma";
  return existsSync(join(dir, schema)) ? schema : null;
}

// prisma generate in the image build (the client is not generated by npm ci). ponytail: only when the prisma CLI is a dependency and the schema path is plain; prisma.config.ts is not read.
function prismaGenerate(dir: string, pkg: { prisma?: { schema?: unknown } }, deps: Record<string, unknown>): string {
  const schema = prismaSchema(dir, pkg);
  return schema && "prisma" in deps && /^[\w./-]+$/.test(schema) && !schema.includes("..") ? `${bin("prisma")} generate --schema ${schema}` : "";
}

function detectMigrations(dir: string, pkg: { prisma?: { schema?: unknown } }): Migrations {
  const has = (p: string) => existsSync(join(dir, p));
  const schema = prismaSchema(dir, pkg);
  if (schema) {
    return { kind: "prisma", cmd: has(join(dirname(schema), "migrations")) ? [bin("prisma"), "migrate", "deploy"] : [bin("prisma"), "db", "push", "--skip-generate"] };
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

export function detectApp(dir: string, run: RunJson = {}): AppPlan {
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
  const df = existsSync(join(dir, "Dockerfile")) ? readFileSync(join(dir, "Dockerfile"), "utf8") : null;
  const project = df !== null && hostBuildDir(df) === null;
  let start: string[] | null = null;
  let fromDockerfile = false;
  let startSource: AppPlan["startSource"] = "project Dockerfile";
  if (!project) {
    if (run.start) { start = run.start; startSource = "run.json"; } // D-068: run.json wins on the template path
    else if (typeof scripts.start === "string" && !devLike) { start = ["npm", "run", "start"]; startSource = "script"; }
    else if (nextjs) { start = [bin("next"), "start"]; startSource = "script"; }
    else if (pkg.main && existsSync(join(dir, pkg.main))) { start = ["node", pkg.main]; startSource = "main"; }
    else {
      const f = ENTRIES.find((e) => existsSync(join(dir, e)));
      if (f) { start = ["node", f]; startSource = "entry file"; }
      else {
        const d = df !== null ? dockerfileStart(df) : null;
        if (d?.start) { start = d.start; fromDockerfile = true; startSource = "dockerfile"; }
        else throw new Unsupported(`no start script and no entry file (looked for: ${ENTRIES.join(", ")})${devLike ? "; the start script runs a dev server" : ""}${d?.text ? `; the project Dockerfile starts it with ${d.text}` : ""}`, true);
      }
    }
  }
  return {
    framework: nextjs ? "nextjs" : "node",
    dockerfile: project ? "project" : "template",
    buildCmd: project ? "true" : [prismaGenerate(dir, pkg, deps), run.build !== undefined ? (run.build?.join(" ") ?? "") : scripts.build ? "npm run build" : nextjs ? bin("next") + " build" : ""].filter(Boolean).join(" && ") || "true",
    start,
    startSource,
    ...(fromDockerfile && { startFromDockerfile: true as const }),
    migrations: detectMigrations(dir, pkg),
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
  for (const line of dockerfile.split(/\r?\n/)) {
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
