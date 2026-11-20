// src/cli.ts
import { parseArgs } from "node:util";
import { spawnSync as spawnSync2 } from "node:child_process";
import { lstatSync as lstatSync3, readFileSync as readFileSync5, realpathSync as realpathSync3, statSync as statSync2 } from "node:fs";
import { join as join6 } from "node:path";
import { fileURLToPath } from "node:url";

// src/sandbox/compose.ts
var PROFILES = {
  small: { cpus: 1, mem: "1g" },
  tiny: { cpus: 0.5, mem: "512m" }
};
var MEM_MB = { small: 1024, tiny: 512 };
var esc = (s) => s.replaceAll("$", "$$$$");
function composeFile(o) {
  const labels = { "vibe-breakpoint": "1", "vibe-breakpoint.run": o.runId };
  const { cpus, mem } = PROFILES[o.profile];
  const base = { labels, networks: ["vb-net"] };
  const node = { image: "node:22-alpine", init: true };
  return {
    name: o.runId,
    networks: { "vb-net": { internal: true, labels } },
    services: {
      db: {
        ...base,
        image: "postgres:16",
        command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=all"],
        environment: { POSTGRES_USER: "vb", POSTGRES_PASSWORD: o.dbPassword, POSTGRES_DB: "vb" },
        tmpfs: ["/var/lib/postgresql/data"],
        cpus,
        mem_limit: mem,
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U vb -d vb"], interval: "1s", timeout: "3s", retries: 60 }
      },
      mock: {
        ...base,
        ...node,
        command: ["node", "/mock/server.mjs"],
        volumes: [`${o.mockDir}:/mock:ro`],
        healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:4010/__vb/health"], interval: "1s", timeout: "3s", retries: 30 },
        environment: { MOCK_LATENCY_MS: "0" },
        mem_limit: "256m"
      },
      app: {
        ...base,
        init: true,
        image: "vb-app:" + o.runId,
        build: { context: o.app.context, dockerfile: o.app.dockerfile, labels, ...o.app.buildCmd && { args: { BUILD_CMD: o.app.buildCmd } } },
        ...o.app.command && { command: o.app.command.map(esc) },
        env_file: [o.envFile],
        cpus,
        mem_limit: mem,
        depends_on: { db: { condition: "service_healthy" }, mock: { condition: "service_healthy" } },
        healthcheck: {
          test: ["CMD", "node", "-e", `fetch("http://127.0.0.1:3000"+${esc(JSON.stringify(o.app.healthPath))}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))`],
          // ponytail: probes only during boot so no healthcheck request lands in the probe/load windows (D-041); runs longer than 24 h get one probe per 24 h; needs Engine 25+ (start_interval); upgrade path: CLI-side readiness polling
          interval: "24h",
          start_period: "120s",
          start_interval: "1s",
          timeout: "5s"
        }
      },
      k6: { ...base, image: "grafana/k6", profiles: ["load"], environment: { K6_NO_USAGE_REPORT: "true" } }
    }
  };
}

// src/sandbox/detect.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
var Unsupported = class extends Error {
};
var OTHER = ["go.mod", "requirements.txt", "pyproject.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle", "Cargo.toml"];
var ENTRIES = ["server.js", "index.js", "app.js", "src/server.js", "src/index.js"];
var DEV_LIKE = /\b(next dev|nodemon|ts-node-dev|vite)\b|--watch|tsx watch/;
var bin = (n2) => `node_modules/.bin/${n2}`;
function detectMigrations(dir) {
  const has = (p) => existsSync(join(dir, p));
  if (has("prisma/schema.prisma")) {
    return { kind: "prisma", cmd: has("prisma/migrations") ? [bin("prisma"), "migrate", "deploy"] : [bin("prisma"), "db", "push", "--skip-generate"] };
  }
  const dz = ["ts", "js", "mjs", "cjs"].map((e) => `drizzle.config.${e}`).find(has);
  if (dz) {
    const out2 = /out:\s*["'`]([^"'`]+)/.exec(readFileSync(join(dir, dz), "utf8"))?.[1] ?? "./drizzle";
    return { kind: "drizzle", cmd: [bin("drizzle-kit"), has(join(out2, "meta/_journal.json")) ? "migrate" : "push"] };
  }
  if (["js", "cjs", "mjs", "ts"].some((e) => has(`knexfile.${e}`))) return { kind: "knex", cmd: [bin("knex"), "migrate:latest"] };
  for (const d of ["migrations", "db/migrations"]) {
    if (!has(d)) continue;
    const files = readdirSync(join(dir, d)).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
    if (files.length) return { kind: "sql", files: files.map((f) => `${d}/${f}`) };
  }
  return { kind: "none" };
}
function detectApp(dir) {
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
  let start = null;
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
    migrations: detectMigrations(dir)
  };
}
function healthPath(projectDir) {
  try {
    const p = String(JSON.parse(readFileSync(join(projectDir, ".vibe-breakpoint/scenario.json"), "utf8")).flow[0].path).split("?")[0];
    return p.startsWith("/") && !p.includes("{{") && !p.includes("$") ? p : "/";
  } catch {
    return "/";
  }
}
function fromImages(dockerfile) {
  const stages = /* @__PURE__ */ new Set();
  const out2 = /* @__PURE__ */ new Set();
  for (const line of dockerfile.split("\n")) {
    const m = /^\s*FROM\s+(.*)$/i.exec(line);
    if (!m) continue;
    const t = m[1].trim().split(/\s+/).filter((x) => !x.startsWith("--"));
    const as = t.findIndex((x) => x.toLowerCase() === "as");
    const img = t[0];
    if (as > 0 && t[as + 1]) stages.add(t[as + 1]);
    if (!img || img === "scratch" || img.includes("$") || stages.has(img)) continue;
    out2.add(img);
  }
  return [...out2];
}

// src/sandbox/safe-out.ts
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as join2, sep } from "node:path";
function safeWriteOut(project, rel, data) {
  const root = realpathSync(project);
  const base = join2(root, ".vibe-breakpoint");
  const parts = rel.split("/");
  const file = parts.pop();
  let cur = root;
  for (const p of [".vibe-breakpoint", ...parts]) {
    cur = join2(cur, p);
    let st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) {
      mkdirSync(cur);
      st = lstatSync(cur);
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to write output: ${cur.slice(root.length + 1)} is a symlink`);
    if (!st.isDirectory()) throw new Error(`refusing to write output: ${cur.slice(root.length + 1)} is not a directory`);
  }
  const real = realpathSync(cur);
  if (real !== base && !real.startsWith(base + sep)) throw new Error("refusing to write output: path leaves .vibe-breakpoint");
  const dest = join2(cur, file);
  if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing to write output: ${join2(...parts, file)} is a symlink`);
  const tmp = join2(dirname(dest), `.${file}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// src/sandbox/env-names.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { extname, join as join3 } from "node:path";

// src/sandbox/copy.ts
import { cpSync, lstatSync as lstatSync2, readlinkSync, realpathSync as realpathSync2 } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
var SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  "coverage",
  ".vibe-breakpoint"
]);
var SAFE_ENV = /* @__PURE__ */ new Set([".env.example", ".env.sample", ".env.template"]);
function isRealEnvFile(name) {
  return name === ".npmrc" || name.startsWith(".env") && !SAFE_ENV.has(name);
}
function safeLink(p, root) {
  try {
    if (isAbsolute(readlinkSync(p))) return false;
    const real = realpathSync2(p);
    const rel = relative(root, real);
    return !rel.startsWith("..") && !isAbsolute(rel) && !isRealEnvFile(basename(real));
  } catch {
    return false;
  }
}
function copyProject(src, dest) {
  const root = realpathSync2(src);
  cpSync(root, dest, {
    recursive: true,
    verbatimSymlinks: true,
    // root is never rejected, so a project folder named "build" still copies (D-020)
    filter: (p) => {
      if (p === root) return true;
      const n2 = basename(p);
      if (SKIP_DIRS.has(n2) || isRealEnvFile(n2)) return false;
      return !lstatSync2(p).isSymbolicLink() || safeLink(p, root);
    }
  });
}

// src/sandbox/env-names.ts
var CODE_EXT = /* @__PURE__ */ new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".vue", ".svelte", ".astro"]);
var VITE_BUILTIN = /* @__PURE__ */ new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);
var NAME = "[A-Za-z_][A-Za-z0-9_]*";
var ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/;
var CODE_RES = [
  new RegExp(`process\\.env\\.(${NAME})`, "g"),
  new RegExp(`process\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g"),
  new RegExp(`os\\.environ\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
  new RegExp(`os\\.getenv\\(\\s*["'](${NAME})["']`, "g")
];
var VITE_RE = new RegExp(`import\\.meta\\.env\\.(${NAME})`, "g");
var MAX_BYTES = 1e6;
function matches(re, text, out2, skip) {
  for (const m of text.matchAll(re)) if (!skip?.has(m[1])) out2.add(m[1]);
}
function composeNames(text, out2) {
  matches(new RegExp(`\\$\\{(${NAME})`, "g"), text, out2);
  const lines2 = text.split("\n");
  for (let i = 0; i < lines2.length; i++) {
    const h = /^(\s*)environment:\s*$/.exec(lines2[i]);
    if (!h) continue;
    for (let j = i + 1; j < lines2.length; j++) {
      const l = lines2[j];
      if (!l.trim()) continue;
      if (l.search(/\S/) <= h[1].length) break;
      const m = /^\s*-\s*([A-Za-z_]\w*)\s*(?:=|$)/.exec(l) ?? /^\s*([A-Z_][A-Z0-9_]*)\s*:/.exec(l);
      if (m) out2.add(m[1]);
    }
  }
}
function vercelNames(text, out2) {
  try {
    const j = JSON.parse(text);
    for (const o of [j?.env, j?.build?.env]) if (o && typeof o === "object") {
      for (const k of Object.keys(o)) if (new RegExp(`^${NAME}$`).test(k)) out2.add(k);
    }
  } catch {
  }
}
function netlifyNames(text, out2) {
  let on = false;
  for (const l of text.split("\n")) {
    const h = /^\s*\[(.+)\]\s*$/.exec(l);
    if (h) {
      on = h[1].trim().endsWith("environment");
      continue;
    }
    const m = on && /^\s*([A-Za-z_]\w*)\s*=/.exec(l);
    if (m) out2.add(m[1]);
  }
}
function fileNames(name, text, out2) {
  if (/^\.env/.test(name)) {
    for (const l of text.split("\n")) {
      const m = ENV_LINE.exec(l);
      if (m) out2.add(m[1]);
    }
  } else if (/^docker-compose.*\.ya?ml$/.test(name)) composeNames(text, out2);
  else if (name === "vercel.json") vercelNames(text, out2);
  else if (name === "netlify.toml") netlifyNames(text, out2);
  else if (CODE_EXT.has(extname(name))) {
    for (const re of CODE_RES) matches(re, text, out2);
    matches(VITE_RE, text, out2, VITE_BUILTIN);
  }
}
var relevant = (n2) => n2.startsWith(".env") || /^docker-compose.*\.ya?ml$/.test(n2) || n2 === "vercel.json" || n2 === "netlify.toml" || CODE_EXT.has(extname(n2));
function walk(dir, out2) {
  for (const e of readdirSync2(dir, { withFileTypes: true })) {
    const p = join3(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out2);
    } else if (e.isFile() && relevant(e.name)) {
      if (statSync(p).size > MAX_BYTES) continue;
      fileNames(e.name, readFileSync2(p, "utf8"), out2);
    }
  }
}
function envNames(projectDir) {
  const out2 = /* @__PURE__ */ new Set();
  walk(projectDir, out2);
  return [...out2].sort();
}

// src/sandbox/sandbox.ts
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";

// src/load/result.ts
var SATURATED = 0.85;
var P95_LIMIT_MS = 2e3;
var ERROR_LIMIT = 0.01;
var r1 = (x) => Math.round(x * 10) / 10;
var r2 = (x) => Math.round(x * 100) / 100;
var r4 = (x) => Math.round(x * 1e4) / 1e4;
function parseStages(s) {
  const a = s.split(",").map((x) => /^\d+$/.test(x.trim()) ? Number(x) : NaN);
  if (!a.length || a.some((n2, i) => !(n2 >= 1 && n2 <= 1e3) || i > 0 && n2 <= a[i - 1])) throw new Error(`invalid --stages: ${s}`);
  return a;
}
function parseDuration(s) {
  const n2 = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!(n2 >= 1 && n2 <= 600)) throw new Error(`invalid --stage-duration: ${s}`);
  return n2;
}
function stageFromSummary(summary, users) {
  const m = summary?.metrics;
  const count = m?.http_reqs?.values?.count ?? 0;
  if (!count) return { users, p50_ms: null, p95_ms: null, error_rate: 1, requests: 0 };
  const d = m?.http_req_duration?.values;
  if (!d) throw new Error("k6 summary has no metrics.http_req_duration");
  return { users, p50_ms: r1(d.med), p95_ms: r1(d["p(95)"]), error_rate: r4(m?.http_req_failed?.values?.rate ?? 0), raw_error_rate: m?.http_req_failed?.values?.rate ?? 0, requests: count };
}
var UNITS = { B: 1 / 1048576, kB: 1e3 / 1048576, KiB: 1 / 1024, MB: 1e6 / 1048576, MiB: 1, GB: 1e9 / 1048576, GiB: 1024 };
function parseStatsLine(cpuPerc, memUsage) {
  const cpu = parseFloat(cpuPerc) / 100;
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)/.exec(memUsage.split("/")[0]);
  if (!Number.isFinite(cpu) || !m || !(m[2] in UNITS)) throw new Error(`unparsable docker stats: ${cpuPerc} ${memUsage}`);
  return { cpu, memMb: Math.round(parseFloat(m[1]) * UNITS[m[2]] * 10) / 10 };
}
var mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function aggregate(samples, profile) {
  const cpus = PROFILES[profile].cpus;
  return {
    app_cpu: samples.app.length ? r2(mean(samples.app.map((s) => s.cpu)) / cpus) : null,
    db_cpu: samples.db.length ? r2(mean(samples.db.map((s) => s.cpu)) / cpus) : null,
    app_mem_mb: samples.app.length ? Math.round(Math.max(...samples.app.map((s) => s.memMb))) : null
  };
}
var errRate = (s) => s.raw_error_rate ?? s.error_rate;
var isBroken = (s) => s.p95_ms === null || s.p95_ms > P95_LIMIT_MS || errRate(s) > ERROR_LIMIT;
function breakingPoint(stages) {
  const i = stages.findIndex(isBroken);
  if (i < 0) return null;
  const s = stages[i];
  const p = s.p95_ms === null || s.p95_ms > P95_LIMIT_MS;
  const e = errRate(s) > ERROR_LIMIT;
  return { users_ok: stages[i - 1]?.users ?? 0, users_broke: s.users, reason: p && e ? "p95_and_error_rate" : p ? "p95" : "error_rate" };
}
function limitingResource(s, profile) {
  const c = [["app_cpu", s.app_cpu], ["db_cpu", s.db_cpu], ["memory", s.app_mem_mb === null ? null : s.app_mem_mb / MEM_MB[profile]]];
  const known = c.filter((x) => x[1] !== null);
  if (!known.length) return null;
  const hot = known.filter((x) => x[1] >= SATURATED).sort((a, b) => b[1] - a[1]);
  return hot[0]?.[0] ?? "app_code";
}
function buildResult(o) {
  const bp = breakingPoint(o.stages);
  const broke = bp ? o.stages.find((s) => s.users === bp.users_broke) : null;
  return {
    schema: 1,
    run_id: o.runId,
    tool_version: o.toolVersion,
    profile: o.profile,
    size: o.size,
    stage_duration_s: o.stageDurationS,
    think_time_s: o.thinkTimeS,
    stages: o.stages.map(({ raw_error_rate: _raw, ...s }) => s),
    breaking_point: bp,
    limiting_resource: broke ? limitingResource(broke, o.profile) : null,
    probe: o.probe ?? {},
    flags: o.flags ?? []
  };
}

// src/sandbox/sandbox.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { mkdirSync as mkdirSync2, readdirSync as readdirSync3, existsSync as existsSync2, readFileSync as readFileSync3, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";

// src/sandbox/test-env.ts
import { randomBytes } from "node:crypto";
var MOCK_URL = "http://mock:4010";
var ALWAYS = ["NODE_ENV", "PORT", "DATABASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "RESEND_BASE_URL"];
var hex = (n2) => randomBytes(n2).toString("hex");
var FIXED = {
  NODE_ENV: "production",
  PORT: "3000",
  HOST: "0.0.0.0",
  HOSTNAME: "0.0.0.0",
  NEXTAUTH_URL: "http://app:3000",
  AUTH_URL: "http://app:3000",
  PGHOST: "db",
  PGPORT: "5432",
  PGUSER: "vb",
  PGDATABASE: "vb"
};
var SERVICE_KEYS = [
  ["OPENAI_API_KEY", () => "sk-vbfake" + hex(16)],
  ["ANTHROPIC_API_KEY", () => "sk-ant-vbfake" + hex(16)],
  ["STRIPE_SECRET_KEY", () => "sk_test_vbfake" + hex(12)],
  ["STRIPE_PUBLISHABLE_KEY", () => "pk_test_vbfake" + hex(12)],
  ["STRIPE_WEBHOOK_SECRET", () => "whsec_vbfake" + hex(12)],
  ["RESEND_API_KEY", () => "re_vbfake" + hex(12)]
];
function value(n2, pw) {
  if (n2 === "PGPASSWORD") return pw;
  if (n2 in FIXED) return FIXED[n2];
  const dbUrl = `postgres://vb:${pw}@db:5432/vb`;
  const isUrl = /_(URL|URI)$/.test(n2);
  if (n2 === "DIRECT_URL" || isUrl && n2.split("_").some((t) => ["DATABASE", "POSTGRES", "PG", "DB"].includes(t))) return dbUrl;
  if (n2 === "OPENAI_BASE_URL") return MOCK_URL + "/v1";
  if (n2.endsWith("_BASE_URL")) return MOCK_URL;
  const svc = SERVICE_KEYS.find(([k]) => n2 === k || n2.endsWith("_" + k));
  if (svc) return svc[1]();
  if (n2.includes("SECRET") || n2.startsWith("JWT_") || /_(KEY|TOKEN|PASSWORD)$/.test(n2)) return hex(32);
  if (isUrl) return MOCK_URL;
  return "vibe-breakpoint-placeholder";
}
function testEnv(names, dbPassword) {
  const env = {};
  for (const n2 of /* @__PURE__ */ new Set([...names, ...ALWAYS])) env[n2] = value(n2, dbPassword);
  return env;
}
function envFileText(env) {
  return Object.keys(env).sort().map((k) => `${k}=${env[k]}
`).join("");
}
function redact(text, env) {
  const vals = [...new Set(Object.values(env))].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
  return vals.reduce((t, v) => t.split(v).join("[redacted]"), text);
}

// src/sandbox/sandbox.ts
var TEMP_PREFIX = "vibe-breakpoint-";
var RUN_DIR_RE = /^vibe-breakpoint-(vb-\d{14}-[0-9a-f]{4})$/;
var LABEL = "vibe-breakpoint.run";
function newRunId(now = /* @__PURE__ */ new Date()) {
  const ts = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `vb-${ts}-${randomBytes2(2).toString("hex")}`;
}
var RUN_ID_RE = /^vb-\d{14}-[0-9a-f]{4}$/;
function runDir(runId) {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  return join4(tmpdir(), TEMP_PREFIX + runId);
}
var docker = (args) => spawnSync("docker", args, { encoding: "utf8" });
var lines = (s) => (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
function requiredImages(dir, own) {
  return [.../* @__PURE__ */ new Set(["postgres:16", "node:22-alpine", ...own ? fromImages(readFileSync3(join4(dir, "Dockerfile"), "utf8")) : []])];
}
function createSandbox(project, runId, profile, mockDir, templateDockerfile) {
  const dir = runDir(runId);
  mkdirSync2(dir, { mode: 448 });
  writeFileSync2(join4(dir, "pid"), String(process.pid));
  const copyDir = join4(dir, "project");
  copyProject(project, copyDir);
  const plan = detectApp(copyDir);
  const dbPassword = randomBytes2(16).toString("hex");
  const env = testEnv(envNames(project), dbPassword);
  const envFile = join4(dir, "test.env");
  writeFileSync2(envFile, envFileText(env), { mode: 384 });
  const own = plan.dockerfile === "project";
  const hp = healthPath(project);
  const composePath = join4(dir, "compose.json");
  const app = {
    context: copyDir,
    dockerfile: own ? join4(copyDir, "Dockerfile") : templateDockerfile,
    healthPath: hp,
    ...!own && { buildCmd: plan.buildCmd },
    ...plan.start && { command: plan.start }
  };
  writeFileSync2(composePath, JSON.stringify(composeFile({ runId, profile, dbPassword, envFile, mockDir, app }), null, 2), { mode: 384 });
  const images = requiredImages(copyDir, own);
  return { composePath, copyDir, plan, env, images, healthPath: hp };
}
var tail = (s, n2 = 30) => s.trim().split("\n").slice(-n2).join("\n");
var out = (r) => (r.stdout ?? "") + (r.stderr ?? "");
var compose = (composePath, args, opts = {}) => spawnSync("docker", ["compose", "-f", composePath, ...args], { encoding: "utf8", ...opts });
function missingImages(images) {
  return images.filter((i) => docker(["image", "inspect", i]).status !== 0);
}
function pullImages(images) {
  for (const i of images) {
    const r = docker(["pull", i]);
    if (r.status !== 0) throw new Error(`docker pull ${i} failed: ${tail(out(r), 5)}`);
  }
}
function buildApp(composePath) {
  const r = compose(composePath, ["--progress", "plain", "build", "app"], { env: { ...process.env, COMPOSE_BAKE: "false" } });
  if (r.status !== 0) throw new Error(`app build failed:
${tail(out(r))}`);
}
function up(composePath, services) {
  const r = compose(composePath, ["up", "-d", "--wait", "--wait-timeout", "120", "--pull", "never", "--no-build", ...services]);
  if (r.status !== 0) throw new Error(`docker compose up failed (${services.join(", ")}):
${tail(out(r), 5)}`);
}
function migrateArgs(cmd2) {
  return ["run", "--rm", "--no-deps", "-T", "--entrypoint", cmd2[0], "app", ...cmd2.slice(1)];
}
function migrate(composePath, plan, copyDir) {
  const m = plan.migrations;
  if (m.kind === "none") {
    console.log("vibe-breakpoint: no migrations detected; the app starts on an empty database");
  } else if (m.kind === "sql") {
    for (const f of m.files) {
      const r = compose(composePath, ["exec", "-T", "db", "psql", "-U", "vb", "-d", "vb", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], { input: readFileSync3(join4(copyDir, f)) });
      if (r.status !== 0) throw new Error(`migrations failed (sql: ${f}):
${tail(out(r))}`);
    }
  } else {
    const r = compose(composePath, migrateArgs(m.cmd));
    if (r.status !== 0) throw new Error(`migrations failed (${m.kind}: ${m.cmd.join(" ")}):
${tail(out(r))}`);
  }
}
var psqlArgs = (tx = true) => ["exec", "-T", "db", "psql", "-U", "vb", "-d", "vb", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...tx ? ["-1"] : [], "-f", "-"];
function psql(composePath, sql, tx = true) {
  const r = compose(composePath, psqlArgs(tx), { input: sql, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`psql failed:
${tail(out(r))}`);
  return (r.stdout ?? "").trim();
}
function appLogs(composePath) {
  return tail(out(compose(composePath, ["logs", "--no-color", "--tail", "30", "app"])));
}
function saveMockLog(composePath, project) {
  try {
    if (!existsSync2(composePath)) return;
    const r = compose(composePath, ["exec", "-T", "mock", "wget", "-qO-", "http://127.0.0.1:4010/__vb/log"], { timeout: 5e3 });
    if (r.status !== 0 || !r.stdout) return;
    safeWriteOut(project, "out/mock-log.json", r.stdout);
  } catch {
  }
}
function removeRun(runId) {
  const f = ["--filter", `label=${LABEL}=${runId}`];
  const steps = [
    [["ps", "-aq", ...f], ["rm", "-fv"]],
    [["image", "ls", "-q", ...f], ["image", "rm", "-f"]],
    [["network", "ls", "-q", ...f], ["network", "rm"]],
    [["volume", "ls", "-q", ...f], ["volume", "rm", "-f"]]
  ];
  for (const [list, rm] of steps) {
    const ids = lines(docker(list).stdout);
    if (!ids.length) continue;
    const r = docker([...rm, ...ids]);
    if (r.status !== 0) process.stderr.write(`vibe-breakpoint: ${rm[0]} failed: ${(r.stderr || "").trim()}
`);
  }
}
function down(runId) {
  if (!RUN_ID_RE.test(runId)) return;
  try {
    removeRun(runId);
  } catch (e) {
    process.stderr.write(`vibe-breakpoint: down: ${String(e)}
`);
  }
  try {
    rmSync2(runDir(runId), { recursive: true, force: true });
  } catch {
  }
}
function onSignals(fn) {
  let done = false;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(sig, () => {
      if (!done) {
        done = true;
        fn();
      }
      process.exit(code);
    });
  }
}
function alive(runId) {
  try {
    const pid = Number(readFileSync3(join4(runDir(runId), "pid"), "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function cleanup(all) {
  const ids = /* @__PURE__ */ new Set();
  const dockerAvailable = docker(["version"]).status === 0;
  if (dockerAvailable) {
    const fmt = ["--format", `{{.Label "${LABEL}"}}`, "--filter", "label=vibe-breakpoint=1"];
    for (const list of [["ps", "-a"], ["network", "ls"], ["volume", "ls"]]) for (const id of lines(docker([...list, ...fmt]).stdout)) ids.add(id);
    for (const t of lines(docker(["image", "ls", "vb-app", "--format", "{{.Tag}}"]).stdout)) ids.add(t);
  }
  for (const n2 of readdirSync3(tmpdir())) {
    const m = RUN_DIR_RE.exec(n2);
    if (m) ids.add(m[1]);
  }
  const runs = [...ids].filter((id) => RUN_ID_RE.test(id) && (all || !alive(id)));
  for (const id of runs) {
    if (dockerAvailable) down(id);
    else rmSync2(runDir(id), { recursive: true, force: true });
  }
  return { runs, dockerAvailable };
}
var execFileP = promisify(execFile);
function exitOf(child) {
  return new Promise((res, rej) => {
    child.on("error", (e) => rej(new Error(`could not run docker: ${e.code ?? "spawn error"}`)));
    child.on("close", (c) => res(c));
  });
}
async function runStage(composePath, script, cfg, users, durationS) {
  const ps = (svc) => (compose(composePath, ["ps", "-q", svc]).stdout ?? "").trim();
  const appId = ps("app");
  const dbId = ps("db");
  const vb = JSON.stringify({ ...cfg, users, duration_s: durationS });
  const child = spawn("docker", ["compose", "-f", composePath, "--profile", "load", "run", "--rm", "--no-deps", "-T", "k6", "run", "--quiet", "-e", `VB_CONFIG=${vb}`, "-"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exit = exitOf(child);
  child.stdin.on("error", () => {
  });
  child.stdin.end(script);
  const samples = { app: [], db: [] };
  let done = false;
  const stop = () => {
    done = true;
  };
  exit.then(stop, stop);
  while (!done) {
    try {
      const { stdout: o } = await execFileP("docker", ["stats", "--no-stream", "--format", "{{.ID}}	{{.CPUPerc}}	{{.MemUsage}}", appId, dbId], { timeout: 15e3 });
      for (const l of o.split("\n").filter(Boolean)) {
        const [id, cpu, mem] = l.split("	");
        const list = appId.startsWith(id) ? samples.app : dbId.startsWith(id) ? samples.db : null;
        if (list && !done) list.push(parseStatsLine(cpu, mem));
      }
    } catch {
    }
  }
  const code = await exit;
  const line = stdout.split("\n").find((l) => l.startsWith("VB_SUMMARY "));
  if (code !== 0 || !line) throw new Error(`k6 failed (stage ${users} users):
${tail(stdout + stderr)}`);
  return { summary: JSON.parse(line.slice("VB_SUMMARY ".length)), samples };
}
async function probeK6(composePath, script, cfg) {
  const child = spawn("docker", ["compose", "-f", composePath, "--profile", "load", "run", "--rm", "--no-deps", "-T", "k6", "run", "--quiet", "--log-format", "raw", "-e", `VB_CONFIG=${JSON.stringify(cfg)}`, "-"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exit = exitOf(child);
  child.stdin.on("error", () => {
  });
  child.stdin.end(script);
  const code = await exit;
  const line = stdout.split("\n").find((l) => l.startsWith("VB_PROBE "));
  if (code !== 0 || !line) {
    const safe = stdout.split("\n").filter((l) => !l.includes("VB_")).join("\n");
    throw new Error(`k6 probe failed:
${tail(safe + "\n" + stderr.split("\n").filter((l) => !l.includes("VB_")).join("\n"), 15)}`);
  }
  const res = JSON.parse(line.slice("VB_PROBE ".length));
  const ck = stderr.split("\n").find((l) => l.startsWith("VB_COOKIES "));
  if (ck) res.cookies = JSON.parse(ck.slice("VB_COOKIES ".length));
  return res;
}

// src/seed/seed.ts
import { createHash } from "node:crypto";
var SIZES = ["S", "M", "L"];
var WORDS = "alpha bravo cedar delta ember fjord grove harbor ivory jungle kernel lemon maple noble olive pearl quartz river solar tiger umber velvet willow xenon yellow zephyr amber birch coral dune flint haze".split(" ");
var isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
var isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
function parseSeed(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("seed.json: invalid JSON");
  }
  const errs = [];
  if (!isObj(j)) throw new Error("seed.json: must be a JSON object");
  if (j.schema !== 1) errs.push("schema must be 1");
  if (!Number.isSafeInteger(j.random_seed)) errs.push("random_seed must be a safe integer");
  const sizes = isObj(j.sizes) ? j.sizes : {};
  for (const s of SIZES) if (!isInt(sizes[s], 1, 1e7)) errs.push(`sizes.${s} must be an integer from 1 to 10000000`);
  const tables = Array.isArray(j.tables) ? j.tables : [];
  if (!tables.length) errs.push("tables must be a non-empty array");
  const names = [];
  let pwCols = 0;
  let pwTable;
  tables.forEach((t, ti) => {
    if (!isObj(t) || typeof t.name !== "string" || !t.name) {
      errs.push(`tables[${ti}]: name must be a non-empty string`);
      return;
    }
    const where = `table "${t.name}"`;
    if (names.includes(t.name)) errs.push(`${where}: listed twice`);
    if (typeof t.ratio !== "number" || !Number.isFinite(t.ratio) || t.ratio <= 0) errs.push(`${where}: ratio must be a number > 0`);
    if (!isObj(t.columns) || !Object.keys(t.columns).length) {
      errs.push(`${where}: columns must be a non-empty object`);
      names.push(t.name);
      return;
    }
    for (const [c, g] of Object.entries(t.columns)) {
      const w = `${where}: column "${c}"`;
      if (!isObj(g)) {
        errs.push(`${w}: generator must be an object`);
        continue;
      }
      switch (g.gen) {
        case "email":
        case "auto":
          break;
        case "words":
          if (g.count !== void 0 && !isInt(g.count, 1, 10)) errs.push(`${w}: words count must be an integer 1..10`);
          break;
        case "fk": {
          const m = typeof g.ref === "string" ? /^([^.]+)\.([^.]+)$/.exec(g.ref) : null;
          if (!m) errs.push(`${w}: fk ref must look like "table.column"`);
          else if (!names.includes(m[1]) || m[1] === t.name) errs.push(`${w}: fk ref "${g.ref}" must name a table listed earlier`);
          break;
        }
        case "password_hash":
          if (g.algo !== "bcrypt") errs.push(`${w}: algo "${String(g.algo)}" not supported (bcrypt only)`);
          if (typeof g.plain !== "string" || !g.plain || Buffer.byteLength(g.plain) > 72) errs.push(`${w}: plain must be 1..72 bytes`);
          if (g.cost !== void 0 && !isInt(g.cost, 4, 14)) errs.push(`${w}: cost must be an integer 4..14`);
          pwCols++;
          pwTable = t;
          break;
        default:
          errs.push(`${w}: unknown gen ${JSON.stringify(g.gen)}`);
      }
    }
    names.push(t.name);
  });
  if (typeof j.main_table !== "string" || !names.includes(j.main_table)) errs.push(`main_table "${String(j.main_table)}" is not listed in tables`);
  if (j.test_users !== void 0) {
    if (!isInt(j.test_users, 0, Number.MAX_SAFE_INTEGER)) errs.push("test_users must be an integer >= 0");
    else if (j.test_users > 0) {
      if (pwCols !== 1) errs.push(`test_users needs exactly one password_hash column (found ${pwCols})`);
      else if (!hasEmailGen(pwTable)) errs.push(`test_users needs table "${pwTable.name}" to have an "email" generator column`);
      else if (isInt(sizes.S, 1, 1e7) && j.test_users > Math.max(1, Math.round(sizes.S * pwTable.ratio))) errs.push("test_users exceeds the S row count of the table with password_hash");
    }
  }
  if (errs.length) throw new Error(`seed.json: ${errs.join("; ")}`);
  return j;
}
var rowsFor = (seed, table2, size) => Math.max(1, Math.round(seed.sizes[size] * table2.ratio));
var hasEmailGen = (t) => Object.values(t.columns).some((g) => isObj(g) && g.gen === "email");
var SCHEMA_SQL = `SELECT coalesce(json_agg(json_build_object('table', table_name, 'column', column_name, 'type', data_type, 'nullable', is_nullable = 'YES', 'hasDefault', column_default IS NOT NULL OR is_identity = 'YES' OR is_generated = 'ALWAYS') ORDER BY table_name, ordinal_position), '[]') FROM information_schema.columns WHERE table_schema = current_schema();`;
var AUTO_TYPES = ["text", "character varying", "character", "smallint", "integer", "bigint", "numeric", "real", "double precision", "boolean", "timestamp with time zone", "timestamp without time zone", "date", "uuid", "json", "jsonb"];
function schemaErrors(seed, cols) {
  const errs = [];
  for (const t of seed.tables) {
    const have = cols.filter((c) => c.table === t.name);
    if (!have.length) {
      errs.push(`table "${t.name}" does not exist`);
      continue;
    }
    for (const [c, g] of Object.entries(t.columns)) {
      const dc = have.find((x) => x.column === c);
      if (!dc) {
        errs.push(`table "${t.name}": column "${c}" does not exist`);
        continue;
      }
      if (g.gen === "auto" && !AUTO_TYPES.includes(dc.type)) errs.push(`table "${t.name}": column "${c}": auto does not support type ${dc.type}`);
      if (g.gen === "fk") {
        const [rt, rc] = g.ref.split(".");
        if (!cols.some((x) => x.table === rt && x.column === rc)) errs.push(`table "${t.name}": column "${c}": fk ref "${g.ref}" does not exist`);
      }
    }
    for (const dc of have) {
      if (!Object.hasOwn(t.columns, dc.column) && !dc.nullable && !dc.hasDefault) errs.push(`table "${t.name}": column "${dc.column}" is NOT NULL without a default; add a generator to seed.json`);
    }
  }
  return errs;
}
var q = (s) => `"${s.replaceAll('"', '""')}"`;
var lit = (s) => `'${s.replaceAll("'", "''")}'`;
function fnv(s) {
  let h = 2166136261;
  for (const b of Buffer.from(s)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
function seedSql(seed, cols, size) {
  const all = seed.tables.map((t) => q(t.name)).join(", ");
  let usesPw = false;
  const body = [];
  for (const t of seed.tables) {
    const joins = [];
    const exprs = [];
    for (const [c, g] of Object.entries(t.columns)) {
      const h = (k = "") => `((i::bigint * 2654435761 + ${fnv(`${seed.random_seed}:${t.name}:${c}${k}`)}) % 4294967296)`;
      switch (g.gen) {
        case "email":
          exprs.push(`'user' || i || '@example.test'`);
          break;
        case "words": {
          const n2 = g.count ?? 3;
          const parts = Array.from({ length: n2 }, (_, k) => `(string_to_array(${lit(WORDS.join(","))}, ','))[1 + ${h(`:${k + 1}`)} % ${WORDS.length}]`);
          exprs.push(`concat_ws(' ', ${parts.join(", ")})`);
          break;
        }
        case "fk": {
          const [rt, rc] = g.ref.split(".");
          const a = `r${joins.length}`;
          joins.push(`(SELECT array_agg(${q(rc)} ORDER BY ${q(rc)}) AS a FROM ${q(rt)}) ${a}`);
          exprs.push(`${a}.a[(1 + ${h()} % cardinality(${a}.a))::int]`);
          break;
        }
        case "password_hash": {
          usesPw = true;
          const salt = createHash("sha256").update(`${seed.random_seed}:salt`).digest("hex").slice(0, 21);
          const setting = `$2a$${String(g.cost ?? 10).padStart(2, "0")}$${salt}.`;
          const a = `p${joins.length}`;
          joins.push(`(SELECT crypt(${lit(g.plain)}, ${lit(setting)}) AS h) ${a}`);
          exprs.push(`${a}.h`);
          break;
        }
        case "auto": {
          const type = cols.find((x) => x.table === t.name && x.column === c)?.type ?? "";
          const hh = h();
          if (["text", "character varying", "character"].includes(type)) exprs.push(`${lit(`${c} `)} || i`);
          else if (["smallint", "integer", "bigint"].includes(type)) exprs.push(`(${hh} % 1000)::${type}`);
          else if (["numeric", "real", "double precision"].includes(type)) exprs.push(`(${hh} % 100000) / 100.0`);
          else if (type === "boolean") exprs.push(`${hh} % 2 = 0`);
          else if (type.startsWith("timestamp") || type === "date") exprs.push(`(timestamp '2025-01-01' - (${hh} % 31536000) * interval '1 second')::${type}`);
          else if (type === "uuid") exprs.push(`md5(${lit(`${fnv(`${seed.random_seed}:${t.name}:${c}`)}:`)} || i)::uuid`);
          else if (type === "json" || type === "jsonb") exprs.push(`'{}'::${type}`);
          else throw new Error(`auto does not support type ${type} (${t.name}.${c})`);
          break;
        }
      }
    }
    body.push(`INSERT INTO ${q(t.name)} (${Object.keys(t.columns).map(q).join(", ")}) SELECT ${exprs.join(", ")} FROM generate_series(1, ${rowsFor(seed, t, size)}) AS g(i)${joins.map((x) => `, ${x}`).join("")};`);
  }
  return [
    ...usesPw ? ["CREATE EXTENSION IF NOT EXISTS pgcrypto;"] : [],
    `TRUNCATE ${all} RESTART IDENTITY CASCADE;`,
    ...body,
    `ANALYZE ${all};`
  ].join("\n");
}
function checksumSql(seed) {
  const parts = seed.tables.map((t, i) => `SELECT ${i} AS idx, ${lit(t.name)} AS tbl, count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS sum FROM (SELECT ${Object.keys(t.columns).map(q).join(", ")} FROM ${q(t.name)}) x`);
  return `SELECT json_agg(json_build_object('table', tbl, 'rows', n, 'checksum', sum) ORDER BY idx) FROM (${parts.join(" UNION ALL ")}) s;`;
}
function dbColumns(composePath) {
  return JSON.parse(psql(composePath, SCHEMA_SQL));
}
function seedSize(composePath, seed, cols, size) {
  try {
    const t0 = performance.now();
    psql(composePath, seedSql(seed, cols, size));
    const ms = Math.round(performance.now() - t0);
    return { size, ms, tables: JSON.parse(psql(composePath, checksumSql(seed))) };
  } catch (e) {
    throw new Error(`seeding ${size} failed:
${e instanceof Error ? e.message : String(e)}`);
  }
}

// src/load/scenario.ts
var METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
var PLACEHOLDERS = ["user.email", "user.password", "random.email"];
var isObj2 = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
var bad = (m) => {
  throw new Error(`scenario.json: ${m}`);
};
function strings(x, out2 = []) {
  if (typeof x === "string") out2.push(x);
  else if (Array.isArray(x)) x.forEach((v) => strings(v, out2));
  else if (isObj2(x)) Object.values(x).forEach((v) => strings(v, out2));
  return out2;
}
var pwColumn = (seed) => seed.tables.flatMap((t) => Object.values(t.columns)).find((g) => g.gen === "password_hash");
var emailTable = (seed) => seed.tables.find((t) => Object.values(t.columns).some((g) => g.gen === "email"));
function parseScenario(text, seed) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return bad("invalid JSON");
  }
  if (!isObj2(j)) return bad("must be a JSON object");
  if (j.schema !== 1) bad("schema must be 1");
  const flow = j.flow;
  if (!Array.isArray(flow) || flow.length < 1 || flow.length > 20) return bad("flow must have 1 to 20 steps");
  const names = /* @__PURE__ */ new Set();
  const used = /* @__PURE__ */ new Set();
  for (const s of flow) {
    if (!isObj2(s)) return bad("each flow step must be an object");
    if (typeof s.name !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(s.name)) return bad(`step name ${JSON.stringify(s.name)} must match [A-Za-z0-9_-]{1,40}`);
    if (names.has(s.name)) bad(`duplicate step name "${s.name}"`);
    names.add(s.name);
    if (typeof s.method !== "string" || !METHODS.includes(s.method)) return bad(`step "${s.name}": method must be one of ${METHODS.join(", ")}`);
    if (typeof s.path !== "string" || !s.path.startsWith("/") || s.path.startsWith("//") || /[\s\\]/.test(s.path)) return bad(`step "${s.name}": path must start with a single "/" and have no spaces or backslashes`);
    if (s.body !== void 0 && !isObj2(s.body)) return bad(`step "${s.name}": body must be a JSON object`);
    if (s.save !== void 0 && (!isObj2(s.save) || typeof s.save.cookie !== "boolean")) return bad(`step "${s.name}": save must be {"cookie": boolean}`);
    for (const str of [s.path, ...strings(s.body)]) for (const m of str.matchAll(/\{\{([^}]*)\}\}/g)) {
      if (!PLACEHOLDERS.includes(m[1])) bad(`step "${s.name}": unknown placeholder {{${m[1]}}}`);
      used.add(m[1]);
    }
  }
  if (!flow.some((s) => !s.save?.cookie)) bad("at least one step must not be a cookie-saving step");
  const think = j.think_time_s ?? 1;
  if (typeof think !== "number" || !(think >= 0 && think <= 60)) bad("think_time_s must be a number from 0 to 60");
  const probe = j.probe_endpoints;
  if (probe !== void 0) {
    if (!Array.isArray(probe) || probe.some((p) => typeof p !== "string" || !names.has(p))) bad("probe_endpoints must name flow steps");
  }
  for (const u of used) {
    if (u.startsWith("user.") && !((seed?.test_users ?? 0) >= 1 && seed.tables.some((t) => Object.values(t.columns).some((g) => g.gen === "password_hash") && hasEmailGen(t)))) bad(`scenario uses {{${u}}} but seed.json has no test_users with a password_hash table that has an email generator column`);
    if (u === "random.email" && !(seed && emailTable(seed))) bad(`scenario uses {{${u}}} but seed.json has no table with an email column`);
  }
  return { schema: 1, flow, think_time_s: think, ...probe !== void 0 && { probe_endpoints: probe } };
}
function loadConfig(sc, seed, size) {
  const pw = seed && pwColumn(seed);
  const et = seed && emailTable(seed);
  return {
    base: "http://app:3000",
    flow: sc.flow,
    think_time_s: sc.think_time_s,
    test_users: seed?.test_users ?? 0,
    password: pw && pw.gen === "password_hash" ? pw.plain : "",
    email_rows: seed && et && size ? rowsFor(seed, et, size) : 1
  };
}

// src/probe/probe.ts
var PROBE_REQUESTS = 5;
var r12 = (x) => Math.round(x * 10) / 10;
var r22 = (x) => Math.round(x * 100) / 100;
function statsSql(schema) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new Error(`unsafe schema name for pg_stat_statements: ${JSON.stringify(schema)}`);
  return `SELECT coalesce(json_agg(json_build_object('queryid', queryid::text, 'query', query, 'calls', calls, 'total_ms', total_exec_time, 'rows', rows)), '[]') FROM ${schema}.pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND toplevel;`;
}
var DROP_PREFIX = ["explain", "analyze", "set ", "show ", "discard ", "reset "];
function keep(q2) {
  const t = q2.trim().toLowerCase();
  if (t.includes("pg_stat_statements")) return false;
  if (t === "begin" || t === "commit") return false;
  if (DROP_PREFIX.some((p) => t.startsWith(p))) return false;
  return t.replace(/;+$/, "").trim() !== "select $1";
}
function keepRows(rows) {
  const by = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (!keep(r.query)) continue;
    const g = by.get(r.queryid);
    if (g) {
      g.calls += r.calls;
      g.total_ms += r.total_ms;
      g.rows += r.rows;
    } else by.set(r.queryid, { ...r });
  }
  return [...by.values()];
}
var safeText = (text, env) => redact(text, env).slice(0, 500);
function summarize(rows, n2, env) {
  const k = keepRows(rows);
  const sum = (f) => k.reduce((a, r) => a + f(r), 0);
  return {
    queries_per_req: r22(sum((r) => r.calls) / n2),
    db_ms_per_req: r12(sum((r) => r.total_ms) / n2),
    rows_per_req: r22(sum((r) => r.rows) / n2),
    top_queries: [...k].sort((a, b) => b.total_ms - a.total_ms).slice(0, 5).map((r) => ({
      query: safeText(r.query, env),
      calls_per_req: r22(r.calls / n2),
      mean_ms: r12(r.calls ? r.total_ms / r.calls : 0),
      rows_per_req: r22(r.rows / n2)
    }))
  };
}
function endpointKey(step, taken) {
  const base = `${step.method} ${step.path.split("?")[0]}`;
  const key = taken.has(base) ? `${base} (${step.name})` : base;
  taken.add(key);
  return key;
}
function explainCandidates(rows) {
  return rows.filter((r) => /^\s*(select|with)\b/i.test(r.query) && !/[;\\]/.test(r.query.trimEnd().replace(/;$/, ""))).sort((a, b) => b.total_ms - a.total_ms).slice(0, 10).map((r) => r.query.trimEnd().replace(/;$/, ""));
}
var sqlLit = (s) => `'${s.replace(/\0/g, "").replace(/'/g, "''")}'`;
function relTuplesSql(rels) {
  const vals = rels.map((r) => `(${sqlLit(r.schema)}, ${sqlLit(r.table)})`).join(", ");
  return `SELECT coalesce(json_agg(json_build_object('s', v.s, 't', v.t, 'n', coalesce((SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = v.s AND c.relname = v.t), 0))), '[]') FROM (VALUES ${vals}) AS v(s, t);`;
}

// src/probe/flags.ts
var r23 = (x) => Math.round(x * 100) / 100;
var isObj3 = (x) => typeof x === "object" && x !== null;
function seqScans(planJson) {
  const out2 = [];
  const walk2 = (x) => {
    if (Array.isArray(x)) return x.forEach(walk2);
    if (!isObj3(x)) return;
    if (x["Node Type"] === "Seq Scan" && typeof x["Filter"] === "string" && typeof x["Relation Name"] === "string") {
      out2.push({ schema: typeof x["Schema"] === "string" ? x["Schema"] : "", table: x["Relation Name"], filter: x["Filter"] });
    }
    walk2(x["Plan"]);
    walk2(x["Plans"]);
  };
  walk2(planJson);
  return out2;
}
var SIZE_ORDER = ["S", "M", "L"];
var sumOf = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
function computeFlags(raw, n2, sizes, scans, env = {}) {
  const flags = [];
  const g = sizes.L / sizes.S;
  for (const endpoint of Object.keys(raw)) {
    const by = raw[endpoint];
    const S = by.S, L = by.L;
    if (!S || !L) continue;
    const per = (f) => {
      const o = {};
      for (const z of SIZE_ORDER) if (by[z]) o[z] = r23(sumOf(by[z], f) / n2);
      return o;
    };
    const qS = sumOf(S, (r) => r.calls) / n2, qL = sumOf(L, (r) => r.calls) / n2;
    if (qS > 0 && qL >= 3 * qS) {
      flags.push({
        flag: "n_plus_one",
        endpoint,
        evidence: { metric: "queries_per_req", by_size: per((r) => r.calls) },
        cause: "The number of database queries per request grows with the amount of data, which usually means a query runs once per row inside a loop.",
        fix: "Fetch the related rows with one query (a join or a WHERE id IN (...) lookup) instead of one query per row."
      });
    }
    const rS = sumOf(S, (r) => r.rows) / n2, rL = sumOf(L, (r) => r.rows) / n2;
    if (g >= 2 && rS > 0 && rL > rS && rL >= 0.5 * g * rS) {
      flags.push({
        flag: "unbounded_fetch",
        endpoint,
        evidence: { metric: "rows_per_req", by_size: per((r) => r.rows) },
        cause: "The rows returned per request grow with the table size, so the endpoint reads everything instead of one page.",
        fix: "Add a LIMIT with pagination (or a cursor) and select only the columns the response needs."
      });
    }
    for (const ql of L) {
      const qs = S.find((r) => r.queryid === ql.queryid);
      if (!qs || !qs.calls || !ql.calls) continue;
      const mS = qs.total_ms / qs.calls, mL = ql.total_ms / ql.calls;
      if (!(mS > 0 && mL >= 5 * mS)) continue;
      const scan = (scans[ql.queryid] ?? []).find((s) => s.table_rows >= 1e4);
      if (!scan) continue;
      const bySize = {};
      for (const z of SIZE_ORDER) {
        const row = by[z]?.find((r) => r.queryid === ql.queryid);
        if (row && row.calls) bySize[z] = r23(row.total_ms / row.calls);
      }
      flags.push({
        flag: "missing_index",
        endpoint,
        evidence: { metric: "mean_ms", by_size: bySize, query: safeText(ql.query, env), seq_scan: { ...scan, filter: safeText(scan.filter, env) } },
        cause: `This query reads every row of "${scan.table}" (Seq Scan) to apply the filter ${safeText(scan.filter, env)}, so it gets slower as the table grows.`,
        fix: `Add an index on the column(s) used in the filter ${safeText(scan.filter, env)} on table "${scan.table}".`
      });
    }
  }
  return flags.sort((a, b) => a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : a.flag < b.flag ? -1 : a.flag > b.flag ? 1 : 0);
}

// src/render/chart.ts
import { basename as basename2 } from "node:path";
var REPO_URL = "github.com/globalmpc/vibe-breakpoint";
var W = 1080;
var H = 1350;
var X0 = 40;
var X1 = 1040;
var PX0 = 160;
var PX1 = 1020;
var PY0 = 330;
var PY1 = 820;
var INK = "#111827";
var BLUE = "#2563eb";
var RED = "#dc2626";
var GRID = "#e5e7eb";
var GREY = "#6b7280";
var r13 = (x) => Math.round(x * 10) / 10;
var xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
var ascii = (s) => s.replace(/[^\x20-\x7e]/g, "?");
var group = (n2) => n2.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function fmtMs(x) {
  return x < 10 ? `${x.toFixed(1)} ms` : x < 1e3 ? `${Math.round(x)} ms` : `${(x / 1e3).toFixed(1)} s`;
}
function fmtNum(x) {
  if (x < 10) return String(Math.round(x * 100) / 100);
  const n2 = String(Math.round(x));
  return x >= 1e4 ? group(n2) : n2;
}
function projectLabel(dir) {
  return cleanName(basename2(dir));
}
function cleanName(s) {
  const t = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return !t ? "app" : t.length > 22 ? `${t.slice(0, 21)}\u2026` : t;
}
var profileLine = (p) => {
  const mem = (mb) => mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
  const side = `${PROFILES[p].cpus} CPU / ${mem(MEM_MB[p])}`;
  return `${p} server: ${side} app, ${side} db`;
};
var reasonSuffix = (bp, errorRate) => bp.reason === "p95" ? "(too slow)" : bp.reason === "error_rate" ? `(${((errorRate ?? 0) * 100).toFixed(1)} % errors)` : "(slow + errors)";
var FLAG_NAMES = { n_plus_one: "N+1 queries", missing_index: "missing index", unbounded_fetch: "reads whole table" };
function worstEndpoint(probe) {
  let best = null, bv = -1;
  for (const k of Object.keys(probe).sort()) {
    const by = probe[k];
    const e = by.L ?? by.M ?? by.S;
    if (e && e.db_ms_per_req > bv) {
      best = k;
      bv = e.db_ms_per_req;
    }
  }
  return best;
}
function resultError(x) {
  const o = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const numOrNull = (v) => v === null || num(v);
  if (!o(x) || x.schema !== 1) return "unsupported schema";
  if (typeof x.profile !== "string" || !(x.profile in PROFILES)) return "unknown profile";
  if (typeof x.run_id !== "string" || typeof x.tool_version !== "string") return "missing run_id or tool_version";
  if (!num(x.stage_duration_s) || !num(x.think_time_s)) return "bad timing fields";
  if (!Array.isArray(x.stages) || !Array.isArray(x.flags) || !o(x.probe)) return "stages, flags or probe have the wrong type";
  for (const s of x.stages) {
    if (!o(s) || !num(s.users) || !num(s.error_rate) || !["p50_ms", "p95_ms", "app_cpu", "db_cpu", "app_mem_mb"].every((k) => numOrNull(s[k]))) return "bad stage";
  }
  const bp = x.breaking_point;
  if (bp !== null && (!o(bp) || !num(bp.users_ok) || !num(bp.users_broke) || !["p95", "error_rate", "p95_and_error_rate"].includes(String(bp.reason)))) return "bad breaking_point";
  if (x.limiting_resource !== null && !["app_cpu", "db_cpu", "memory", "app_code"].includes(String(x.limiting_resource))) return "bad limiting_resource";
  for (const by of Object.values(x.probe)) {
    if (!o(by)) return "bad probe";
    for (const [z, e] of Object.entries(by)) {
      if (!SIZES.includes(z) || !o(e) || !num(e.queries_per_req) || !num(e.db_ms_per_req) || !num(e.rows_per_req)) return "bad probe";
    }
  }
  for (const f of x.flags) {
    if (!o(f) || !["n_plus_one", "missing_index", "unbounded_fetch"].includes(String(f.flag)) || typeof f.endpoint !== "string" || !o(f.evidence) || !o(f.evidence.by_size)) return "bad flag";
    if (typeof f.cause !== "string" || typeof f.fix !== "string") return "bad flag";
  }
  if (!x.stages.length && !Object.keys(x.probe).length) return "no stages and no probe";
  return null;
}
function chartSvg(result, projectName) {
  const out2 = [];
  const text = (x, y, fs, s, o = {}) => {
    const avail = o.anchor === "end" ? x - X0 : o.anchor === "middle" ? 2 * Math.min(x - X0, X1 - x) : X1 - x;
    const max = Math.floor(avail / (0.6 * fs));
    const cs = [...s];
    const t = cs.length > max ? `${cs.slice(0, Math.max(0, max - 1)).join("")}\u2026` : s;
    out2.push(`<text x="${r13(x)}" y="${r13(y)}" font-size="${fs}" fill="${o.fill ?? INK}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.bold ? ' font-weight="bold"' : ""}>${xmlEscape(t)}</text>`);
  };
  const line = (x1, y1, x2, y2, stroke, extra = "") => out2.push(`<line x1="${r13(x1)}" y1="${r13(y1)}" x2="${r13(x2)}" y2="${r13(y2)}" stroke="${stroke}" stroke-width="3"${extra}/>`);
  const { stages, breaking_point: bp, probe, flags } = result;
  out2.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Liberation Mono, monospace">`);
  out2.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  text(X0, 70, 40, `VIBE BREAKPOINT \u2014 ${cleanName(projectName)}`, { bold: true });
  let h1, h2;
  if (!stages.length) [h1, h2] = ["Data-growth probe only", "no load test in this run"];
  else if (bp && bp.users_ok > 0) [h1, h2] = [`Handles ~${fmtNum(bp.users_ok)} users`, "at the same time"];
  else if (bp) [h1, h2] = [`Broke at ${fmtNum(bp.users_broke)} users`, "the first stage tested"];
  else [h1, h2] = [`Handles ${fmtNum(stages[stages.length - 1].users)}+ users`, "no breaking point found"];
  text(X0, 150, 64, h1, { bold: true });
  text(X0, 200, 40, h2);
  text(X0, 270, 32, "p95 response time by users", { bold: true });
  if (!stages.length) {
    text(540, 575, 32, "No load test in this run", { anchor: "middle", fill: GREY });
  } else {
    const n2 = stages.length;
    const maxP = Math.max(2e3, ...stages.map((s) => s.p95_ms ?? 0));
    const yMax = Math.ceil(maxP * 1.1 / 500) * 500;
    const py = (v) => PY1 - v / yMax * (PY1 - PY0);
    const px = (i) => PX0 + (i + 0.5) * (PX1 - PX0) / n2;
    for (let i = 0; i <= 4; i++) {
      const y = py(yMax * i / 4);
      line(PX0, y, PX1, y, GRID);
      text(PX0 - 10, y + 10, 28, fmtMs(yMax * i / 4), { anchor: "end" });
    }
    const step = Math.ceil(n2 / 10);
    stages.forEach((s, i) => {
      if (i % step === 0 || i === n2 - 1) text(px(i), 855, 28, fmtNum(s.users), { anchor: "middle" });
    });
    line(PX0, py(2e3), PX1, py(2e3), RED, ' stroke-dasharray="12 8"');
    text(PX0 + 8, py(2e3) - 8, 28, "2 s limit", { fill: RED });
    const pts = stages.map((s, i) => `${r13(px(i))},${r13(py(s.p95_ms ?? yMax))}`).join(" ");
    out2.push(`<polyline points="${pts}" fill="none" stroke="${BLUE}" stroke-width="4"/>`);
    stages.forEach((s, i) => {
      const x = px(i), y = py(s.p95_ms ?? yMax);
      if (s.p95_ms === null) {
        line(x - 9, y - 9, x + 9, y + 9, RED);
        line(x - 9, y + 9, x + 9, y - 9, RED);
      } else out2.push(`<circle cx="${r13(x)}" cy="${r13(y)}" r="7" fill="${BLUE}"/>`);
    });
    if (bp) {
      const i = stages.findIndex((s) => s.users === bp.users_broke);
      if (i >= 0) {
        const x = px(i);
        line(x, PY0, x, PY1, RED, ' stroke-dasharray="8 8"');
        out2.push(`<circle cx="${r13(x)}" cy="${r13(py(stages[i].p95_ms ?? yMax))}" r="11" fill="${RED}"/>`);
        const label = `broke at ${fmtNum(bp.users_broke)} users ${reasonSuffix(bp, stages[i].error_rate)}`;
        if (x <= 540) text(x + 8, PY0 + 25, 28, label, { fill: RED, bold: true });
        else text(x - 8, PY0 + 25, 28, label, { anchor: "end", fill: RED, bold: true });
      }
    }
    const ran = { app_cpu: "app CPU", db_cpu: "database CPU", memory: "memory", app_code: "no resource (app code)" };
    if (result.limiting_resource) text(X0, 900, 28, `ran out: ${ran[result.limiting_resource]}`);
  }
  const worst = worstEndpoint(probe);
  if (!worst) {
    text(X0, 980, 32, "No data-growth probe in this run", { fill: GREY });
  } else {
    text(X0, 970, 32, `As data grows: ${ascii(worst)}`, { bold: true });
    text(X0, 1015, 28, "data", { bold: true });
    text(700, 1015, 28, "queries/req", { anchor: "end", bold: true });
    text(X1, 1015, 28, "db time/req", { anchor: "end", bold: true });
    line(X0, 1028, X1, 1028, GRID);
    let y = 1065;
    for (const [z, name] of [["S", "small"], ["M", "medium"], ["L", "large"]]) {
      const e = probe[worst][z];
      if (!e) continue;
      text(X0, y, 28, name);
      text(700, y, 28, fmtNum(e.queries_per_req), { anchor: "end" });
      text(X1, y, 28, fmtMs(e.db_ms_per_req), { anchor: "end" });
      y += 40;
    }
    const kinds = [...new Set(flags.filter((f) => f.endpoint === worst).map((f) => FLAG_NAMES[f.flag]))];
    if (kinds.length) text(X0, y + 15, 28, `found: ${kinds.join(", ")}`, { fill: RED });
  }
  text(X0, 1245, 28, profileLine(result.profile));
  text(X0, 1295, 28, REPO_URL, { fill: GREY });
  text(X0, 1330, 28, 'search "vibe-breakpoint" on GitHub', { fill: GREY });
  out2.push("</svg>");
  return out2.join("\n") + "\n";
}

// src/render/report.ts
var SZ = ["S", "M", "L"];
var cell = (s) => ascii(s).replace(/\|/g, "\\|");
var n = (v, f = fmtNum) => v === null || v === void 0 ? "\u2013" : f(v);
var pct = (v) => n(v, (x) => String(Math.round(x * 1e3) / 10));
var table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
var fence = (body, lang = "") => {
  const k = Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1));
  const f = "`".repeat(k);
  return `${f}${lang}
${body}
${f}`;
};
var arrow = (f) => SZ.filter((z) => f.evidence.by_size[z] !== void 0).map((z) => `${z} ${fmtNum(f.evidence.by_size[z])}`).join(" \u2192 ");
var METRIC = { queries_per_req: "queries per request", mean_ms: "ms per query", rows_per_req: "rows per request" };
function fixPrompt(f) {
  const by = f.evidence.by_size, S = fmtNum(by.S ?? 0), L = fmtNum(by.L ?? 0), ep = ascii(f.endpoint);
  if (f.flag === "n_plus_one") return `In my app, the endpoint ${ep} runs one database query per item: ${S} queries per request with small data, ${L} with large data. Find the loop in its handler that queries the database once per row and replace it with one query (a join or WHERE id IN (...)). Keep the response the same.`;
  if (f.flag === "unbounded_fetch") return `In my app, the endpoint ${ep} returns every row: ${S} rows per request with small data, ${L} with large data. Add pagination (LIMIT with a page or cursor parameter, default 50) and select only the columns the response needs. Update callers that expect the full list.`;
  const sc = f.evidence.seq_scan;
  return `In my app, the endpoint ${ep} gets slower as table "${sc?.table ?? "?"}" grows (${S} ms -> ${L} ms per query) because this query scans the whole table:
${f.evidence.query ?? ""}
Filter: ${sc?.filter ?? ""}
Add an index on the filtered column(s) of "${sc?.table ?? "?"}" using this project's migration setup. Do not change other tables.`;
}
function reportMd({ result, project, mockLog, seedSizes, codeLocations }) {
  const { stages, breaking_point: bp, probe, flags } = result;
  const prof = profileLine(result.profile);
  const o = [`# vibe-breakpoint report: ${project}`, ""];
  let v;
  if (!stages.length) v = "no load test ran, only the data-growth probe.";
  else if (bp && bp.users_ok > 0) v = `the app handled about ${fmtNum(bp.users_ok)} users at the same time and broke at ${fmtNum(bp.users_broke)} users.`;
  else if (bp) v = `the app broke at ${fmtNum(bp.users_broke)} users, the first stage tested.`;
  else v = `the app handled ${fmtNum(stages[stages.length - 1].users)} users with no breaking point found.`;
  const problems = flags.length;
  o.push("## 1. Verdict", "", `On a simulated ${result.profile} server, ${v}${Object.keys(probe).length ? ` ${problems} data-growth problem(s) found.` : ""}`, "");
  o.push("## 2. Breaking point", "");
  if (!stages.length) o.push("No load test ran.", "");
  else {
    o.push("The app counts as broken when p95 is above 2 s or more than 1 % of requests fail.", "");
    o.push(table(
      ["users", "p50", "p95", "errors %", "app CPU %", "db CPU %", "app memory MB"],
      stages.map((s) => [fmtNum(s.users), n(s.p50_ms, fmtMs), n(s.p95_ms, fmtMs), String(Math.round(s.error_rate * 1e3) / 10), pct(s.app_cpu), pct(s.db_cpu), n(s.app_mem_mb)])
    ), "");
    const ran = { app_cpu: "the app's CPU", db_cpu: "the database's CPU", memory: "the app's memory", app_code: "no resource was saturated, so the slowdown is in the app code or its queries" };
    o.push(`What ran out: ${result.limiting_resource ? ran[result.limiting_resource] : bp ? "not measured" : "nothing (no break)"}.`, "");
    if (bp) o.push(`Break reason: ${reasonSuffix(bp, stages.find((s) => s.users === bp.users_broke)?.error_rate).slice(1, -1)}.`, "");
  }
  o.push("## 3. Data growth findings", "");
  const eps = Object.keys(probe).sort();
  if (!eps.length) o.push("No data-growth probe ran (needs seed.json and scenario.json with probe_endpoints).", "");
  else {
    const rows = [];
    for (const ep of eps) for (const z of SZ) {
      const e = probe[ep][z];
      if (e) rows.push([cell(ep), z, fmtNum(e.queries_per_req), fmtMs(e.db_ms_per_req), fmtNum(e.rows_per_req)]);
    }
    o.push(table(["endpoint", "size", "queries/req", "db ms/req", "rows/req"], rows), "");
    const w = worstEndpoint(probe);
    if (w) o.push(`Slowest endpoint as data grows: ${cell(w)}.`, "");
    if (!flags.length) o.push("No data-growth problems found.", "");
    flags.forEach((f, i) => {
      o.push(`### ${i + 1}. ${FLAG_NAMES[f.flag]} on \`${ascii(f.endpoint).replace(/`/g, "'")}\``, "");
      o.push(`Cause: ${f.cause}`, "", `Numbers: ${METRIC[f.evidence.metric]} ${arrow(f)}`, "");
      if (f.flag === "missing_index") {
        o.push(`Table: ${f.evidence.seq_scan?.table ?? "?"} (${fmtNum(f.evidence.seq_scan?.table_rows ?? 0)} rows)`, "");
        if (f.evidence.query) o.push(fence(f.evidence.query, "sql"), "");
      }
      o.push(`Fix: ${f.fix}`, "", "Fix prompt for Claude Code:", "", fence(fixPrompt(f), "text"), "");
    });
  }
  o.push("## 4. Code locations", "", codeLocations !== void 0 ? codeLocations.replace(/\s+$/, "") : "No code locations yet. Run /vibe-breakpoint so Claude can point to the code.", "");
  o.push("## 5. Test setup", "", `- ${prof}`);
  o.push(`- Data sizes: ${seedSizes ? `S ${fmtNum(seedSizes.S)} / M ${fmtNum(seedSizes.M)} / L ${fmtNum(seedSizes.L)} rows (main table)` : "no seed.json: the app's empty database after migrations"}`);
  if (stages.length) o.push(`- Load test ran on data size ${result.size ?? "none"}, stages ${stages.map((s) => s.users).join(", ")}, ${result.stage_duration_s} s each, think time ${result.think_time_s} s`);
  o.push("- Scenario: .vibe-breakpoint/scenario.json", "", "What was mocked: Set up as local mocks: OpenAI, Anthropic, Stripe, Resend (no internet during the run).", "");
  if (!mockLog) o.push("Mock log not found; outside calls were blocked but not counted.", "");
  else if (!mockLog.length) o.push("The app made no calls to outside services.", "");
  else {
    const rows = [...mockLog].sort((a, b) => b.count - a.count || (a.service + a.method + a.path < b.service + b.method + b.path ? -1 : 1)).slice(0, 20);
    o.push(table(["service", "method", "path", "count"], rows.map((c) => [c.service === "unknown" ? "other (answered with an empty reply)" : cell(c.service), cell(c.method), cell(c.path), fmtNum(c.count)])), "");
  }
  o.push("Changes made in the copy:", "", "- fake values for every env name", "- outside services pointed at the local mock", "- a throwaway Postgres", "- further changes, if any, are listed in section 4", "");
  o.push(
    "## 6. Limits",
    "",
    `- This is a local estimate on a simulated ${result.profile} server, not your hosting.`,
    "- Outside services were replaced by an instant mock, so their latency and rate limits are not measured.",
    "- Real traffic and real data differ, and the test rows are generated.",
    "- Hosting adds network, cold starts and connection limits.",
    "",
    `Run ${ascii(result.run_id)}, vibe-breakpoint ${ascii(result.tool_version)}.`,
    ""
  );
  return o.join("\n");
}

// src/render/png.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join5 } from "node:path";

// node_modules/@resvg/resvg-wasm/index.mjs
var wasm;
var heap = new Array(128).fill(void 0);
heap.push(void 0, null, true, false);
var heap_next = heap.length;
function addHeapObject(obj) {
  if (heap_next === heap.length)
    heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];
  heap[idx] = obj;
  return idx;
}
function getObject(idx) {
  return heap[idx];
}
function dropObject(idx) {
  if (idx < 132)
    return;
  heap[idx] = heap_next;
  heap_next = idx;
}
function takeObject(idx) {
  const ret = getObject(idx);
  dropObject(idx);
  return ret;
}
var WASM_VECTOR_LEN = 0;
var cachedUint8Memory0 = null;
function getUint8Memory0() {
  if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
    cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8Memory0;
}
var cachedTextEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder("utf-8") : { encode: () => {
  throw Error("TextEncoder not available");
} };
var encodeString = typeof cachedTextEncoder.encodeInto === "function" ? function(arg, view) {
  return cachedTextEncoder.encodeInto(arg, view);
} : function(arg, view) {
  const buf = cachedTextEncoder.encode(arg);
  view.set(buf);
  return {
    read: arg.length,
    written: buf.length
  };
};
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8Memory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8Memory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127)
      break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
    const ret = encodeString(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function isLikeNone(x) {
  return x === void 0 || x === null;
}
var cachedInt32Memory0 = null;
function getInt32Memory0() {
  if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
    cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
  }
  return cachedInt32Memory0;
}
var cachedTextDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }) : { decode: () => {
  throw Error("TextDecoder not available");
} };
if (typeof TextDecoder !== "undefined") {
  cachedTextDecoder.decode();
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}
function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
  return instance.ptr;
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    wasm.__wbindgen_exn_store(addHeapObject(e));
  }
}
var BBoxFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_bbox_free(ptr >>> 0));
var BBox = class _BBox {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_BBox.prototype);
    obj.__wbg_ptr = ptr;
    BBoxFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    BBoxFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_bbox_free(ptr);
  }
  /**
  * @returns {number}
  */
  get x() {
    const ret = wasm.__wbg_get_bbox_x(this.__wbg_ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set x(arg0) {
    wasm.__wbg_set_bbox_x(this.__wbg_ptr, arg0);
  }
  /**
  * @returns {number}
  */
  get y() {
    const ret = wasm.__wbg_get_bbox_y(this.__wbg_ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set y(arg0) {
    wasm.__wbg_set_bbox_y(this.__wbg_ptr, arg0);
  }
  /**
  * @returns {number}
  */
  get width() {
    const ret = wasm.__wbg_get_bbox_width(this.__wbg_ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set width(arg0) {
    wasm.__wbg_set_bbox_width(this.__wbg_ptr, arg0);
  }
  /**
  * @returns {number}
  */
  get height() {
    const ret = wasm.__wbg_get_bbox_height(this.__wbg_ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set height(arg0) {
    wasm.__wbg_set_bbox_height(this.__wbg_ptr, arg0);
  }
};
var RenderedImageFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_renderedimage_free(ptr >>> 0));
var RenderedImage = class _RenderedImage {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_RenderedImage.prototype);
    obj.__wbg_ptr = ptr;
    RenderedImageFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    RenderedImageFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_renderedimage_free(ptr);
  }
  /**
  * Get the PNG width
  * @returns {number}
  */
  get width() {
    const ret = wasm.renderedimage_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
  * Get the PNG height
  * @returns {number}
  */
  get height() {
    const ret = wasm.renderedimage_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
  * Write the image data to Uint8Array
  * @returns {Uint8Array}
  */
  asPng() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.renderedimage_asPng(retptr, this.__wbg_ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r14 = getInt32Memory0()[retptr / 4 + 1];
      var r24 = getInt32Memory0()[retptr / 4 + 2];
      if (r24) {
        throw takeObject(r14);
      }
      return takeObject(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * Get the RGBA pixels of the image
  * @returns {Uint8Array}
  */
  get pixels() {
    const ret = wasm.renderedimage_pixels(this.__wbg_ptr);
    return takeObject(ret);
  }
};
var ResvgFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_resvg_free(ptr >>> 0));
var Resvg = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    ResvgFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_resvg_free(ptr);
  }
  /**
  * @param {Uint8Array | string} svg
  * @param {string | undefined} [options]
  * @param {Array<any> | undefined} [custom_font_buffers]
  */
  constructor(svg, options, custom_font_buffers) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      var ptr0 = isLikeNone(options) ? 0 : passStringToWasm0(options, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      var len0 = WASM_VECTOR_LEN;
      wasm.resvg_new(retptr, addHeapObject(svg), ptr0, len0, isLikeNone(custom_font_buffers) ? 0 : addHeapObject(custom_font_buffers));
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r14 = getInt32Memory0()[retptr / 4 + 1];
      var r24 = getInt32Memory0()[retptr / 4 + 2];
      if (r24) {
        throw takeObject(r14);
      }
      this.__wbg_ptr = r0 >>> 0;
      return this;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * Get the SVG width
  * @returns {number}
  */
  get width() {
    const ret = wasm.resvg_width(this.__wbg_ptr);
    return ret;
  }
  /**
  * Get the SVG height
  * @returns {number}
  */
  get height() {
    const ret = wasm.resvg_height(this.__wbg_ptr);
    return ret;
  }
  /**
  * Renders an SVG in Wasm
  * @returns {RenderedImage}
  */
  render() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.resvg_render(retptr, this.__wbg_ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r14 = getInt32Memory0()[retptr / 4 + 1];
      var r24 = getInt32Memory0()[retptr / 4 + 2];
      if (r24) {
        throw takeObject(r14);
      }
      return RenderedImage.__wrap(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * Output usvg-simplified SVG string
  * @returns {string}
  */
  toString() {
    let deferred1_0;
    let deferred1_1;
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.resvg_toString(retptr, this.__wbg_ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r14 = getInt32Memory0()[retptr / 4 + 1];
      deferred1_0 = r0;
      deferred1_1 = r14;
      return getStringFromWasm0(r0, r14);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
  * Calculate a maximum bounding box of all visible elements in this SVG.
  *
  * Note: path bounding box are approx values.
  * @returns {BBox | undefined}
  */
  innerBBox() {
    const ret = wasm.resvg_innerBBox(this.__wbg_ptr);
    return ret === 0 ? void 0 : BBox.__wrap(ret);
  }
  /**
  * Calculate a maximum bounding box of all visible elements in this SVG.
  * This will first apply transform.
  * Similar to `SVGGraphicsElement.getBBox()` DOM API.
  * @returns {BBox | undefined}
  */
  getBBox() {
    const ret = wasm.resvg_getBBox(this.__wbg_ptr);
    return ret === 0 ? void 0 : BBox.__wrap(ret);
  }
  /**
  * Use a given `BBox` to crop the svg. Currently this method simply changes
  * the viewbox/size of the svg and do not move the elements for simplicity
  * @param {BBox} bbox
  */
  cropByBBox(bbox) {
    _assertClass(bbox, BBox);
    wasm.resvg_cropByBBox(this.__wbg_ptr, bbox.__wbg_ptr);
  }
  /**
  * @returns {Array<any>}
  */
  imagesToResolve() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.resvg_imagesToResolve(retptr, this.__wbg_ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r14 = getInt32Memory0()[retptr / 4 + 1];
      var r24 = getInt32Memory0()[retptr / 4 + 2];
      if (r24) {
        throw takeObject(r14);
      }
      return takeObject(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * @param {string} href
  * @param {Uint8Array} buffer
  */
  resolveImage(href, buffer) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      const ptr0 = passStringToWasm0(href, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.resvg_resolveImage(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(buffer));
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r14 = getInt32Memory0()[retptr / 4 + 1];
      if (r14) {
        throw takeObject(r0);
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
};
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        if (module.headers.get("Content-Type") != "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function __wbg_get_imports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbg_new_28c511d9baebfa89 = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_memory = function() {
    const ret = wasm.memory;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_buffer_12d079cc21e14bdb = function(arg0) {
    const ret = getObject(arg0).buffer;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb = function(arg0, arg1, arg2) {
    const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
    takeObject(arg0);
  };
  imports.wbg.__wbg_new_63b92bc8671ed464 = function(arg0) {
    const ret = new Uint8Array(getObject(arg0));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_values_839f3396d5aac002 = function(arg0) {
    const ret = getObject(arg0).values();
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_next_196c84450b364254 = function() {
    return handleError(function(arg0) {
      const ret = getObject(arg0).next();
      return addHeapObject(ret);
    }, arguments);
  };
  imports.wbg.__wbg_done_298b57d23c0fc80c = function(arg0) {
    const ret = getObject(arg0).done;
    return ret;
  };
  imports.wbg.__wbg_value_d93c65011f51a456 = function(arg0) {
    const ret = getObject(arg0).value;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_instanceof_Uint8Array_2b3bbecd033d19f6 = function(arg0) {
    let result;
    try {
      result = getObject(arg0) instanceof Uint8Array;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbindgen_string_get = function(arg0, arg1) {
    const obj = getObject(arg1);
    const ret = typeof obj === "string" ? obj : void 0;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
  };
  imports.wbg.__wbg_new_16b304a2cfa7ff4a = function() {
    const ret = new Array();
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_push_a5b05aedc7234f9f = function(arg0, arg1) {
    const ret = getObject(arg0).push(getObject(arg1));
    return ret;
  };
  imports.wbg.__wbg_length_c20a40f15020d68a = function(arg0) {
    const ret = getObject(arg0).length;
    return ret;
  };
  imports.wbg.__wbg_set_a47bac70306a19a7 = function(arg0, arg1, arg2) {
    getObject(arg0).set(getObject(arg1), arg2 >>> 0);
  };
  imports.wbg.__wbindgen_throw = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  return imports;
}
function __wbg_init_memory(imports, maybe_memory) {
}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedInt32Memory0 = null;
  cachedUint8Memory0 = null;
  return wasm;
}
async function __wbg_init(input) {
  if (wasm !== void 0)
    return wasm;
  if (typeof input === "undefined") {
    input = new URL("index_bg.wasm", void 0);
  }
  const imports = __wbg_get_imports();
  if (typeof input === "string" || typeof Request === "function" && input instanceof Request || typeof URL === "function" && input instanceof URL) {
    input = fetch(input);
  }
  __wbg_init_memory(imports);
  const { instance, module } = await __wbg_load(await input, imports);
  return __wbg_finalize_init(instance, module);
}
var dist_default = __wbg_init;
var initialized = false;
var initWasm = async (module_or_path) => {
  if (initialized) {
    throw new Error("Already initialized. The `initWasm()` function can be used only once.");
  }
  await dist_default(await module_or_path);
  initialized = true;
};
var Resvg2 = class extends Resvg {
  /**
   * @param {Uint8Array | string} svg
   * @param {ResvgRenderOptions | undefined} options
   */
  constructor(svg, options) {
    if (!initialized)
      throw new Error("Wasm has not been initialized. Call `initWasm()` function.");
    const font = options?.font;
    if (!!font && isCustomFontsOptions(font)) {
      const serializableOptions = {
        ...options,
        font: {
          ...font,
          fontBuffers: void 0
        }
      };
      super(svg, JSON.stringify(serializableOptions), font.fontBuffers);
    } else {
      super(svg, JSON.stringify(options));
    }
  }
};
function isCustomFontsOptions(value2) {
  return Object.prototype.hasOwnProperty.call(value2, "fontBuffers");
}

// src/render/png.ts
var ready;
async function svgToPng(svg, assetsDir) {
  ready ??= initWasm(readFileSync4(join5(assetsDir, "resvg.wasm")));
  try {
    await ready;
  } catch (e) {
    ready = void 0;
    throw e;
  }
  const fontBuffers = ["Regular", "Bold"].map((w) => new Uint8Array(readFileSync4(join5(assetsDir, `LiberationMono-${w}.ttf`))));
  return new Resvg2(svg, { font: { fontBuffers, defaultFontFamily: "Liberation Mono", loadSystemFonts: false }, fitTo: { mode: "original" } }).render().asPng();
}

// package.json
var package_default = {
  name: "vibe-breakpoint-dev",
  version: "0.1.0",
  private: true,
  type: "module",
  engines: {
    node: "^22.12.0 || ^24.0.0 || >=26.0.0"
  },
  scripts: {
    build: `esbuild src/cli.ts --bundle --platform=node --format=esm --target=node20 --outfile=skills/vibe-breakpoint/scripts/vibe-breakpoint.mjs && node -e "const f=require('fs');f.mkdirSync('skills/vibe-breakpoint/assets',{recursive:true});f.copyFileSync('node_modules/@resvg/resvg-wasm/index_bg.wasm','skills/vibe-breakpoint/assets/resvg.wasm')"`,
    pretest: "npm run build",
    test: "vitest run",
    "test:e2e": "npm run build && vitest run --config vitest.e2e.config.ts",
    typecheck: "tsc"
  },
  devDependencies: {
    "@resvg/resvg-wasm": "2.6.2",
    "@types/node": "^26.6.6",
    esbuild: "^0.28.2",
    typescript: "^7.0.2",
    vitest: "^5.1.1"
  }
};

// src/cli.ts
var usage = `usage:
  vibe-breakpoint inspect  <project>
  vibe-breakpoint run      <project> [--profile small] [--pull] [--sizes S,M,L] [--stages 10,25,...] [--stage-duration 60] [--keep-on-fail]
  vibe-breakpoint render   <project>
  vibe-breakpoint cleanup  [--all]
  vibe-breakpoint --version
`;
var { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    version: { type: "boolean" },
    help: { type: "boolean" },
    all: { type: "boolean" },
    profile: { type: "string", default: "small" },
    "keep-on-fail": { type: "boolean" },
    hold: { type: "boolean" },
    pull: { type: "boolean" },
    sizes: { type: "string", default: "S,M,L" },
    stages: { type: "string", default: "10,25,50,100,200,400" },
    "stage-duration": { type: "string", default: "60" }
  }
});
var cmd = positionals[0];
function fail(msg) {
  console.error(`vibe-breakpoint: ${msg}`);
  process.exit(1);
}
function inputFile(file, label) {
  const st = lstatSync3(file, { throwIfNoEntry: false });
  if (!st) return void 0;
  if (!st.isFile()) throw new Error(`${label} must be a regular file (not a symlink or folder)`);
  return readFileSync5(file, "utf8");
}
async function runCmd(project) {
  const isDir = (p) => {
    try {
      return statSync2(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (!project || !isDir(project)) fail("project not found");
  const profile = String(values.profile);
  if (!(profile in PROFILES)) fail(`unknown profile: ${profile}`);
  if (spawnSync2("docker", ["version"], { stdio: "ignore" }).status !== 0) fail("Docker is not available");
  const mockDir = fileURLToPath(new URL("../templates/mock", import.meta.url));
  const template = fileURLToPath(new URL("../templates/dockerfiles/node.Dockerfile", import.meta.url));
  const runId = newRunId();
  let composePath = "";
  const save = () => {
    if (composePath) saveMockLog(composePath, project);
  };
  onSignals(() => {
    save();
    down(runId);
  });
  let failed = false;
  let env = {};
  try {
    const sizes = [...new Set(String(values.sizes).split(","))].map((x) => {
      if (!SIZES.includes(x)) throw new Error(`unknown size: ${x}`);
      return x;
    });
    const seedFile = join6(project, ".vibe-breakpoint", "seed.json");
    let seed;
    const seedText = inputFile(seedFile, "seed.json");
    if (seedText !== void 0) seed = parseSeed(seedText);
    else console.log("vibe-breakpoint: no seed.json; skipping seeding");
    const stages = parseStages(String(values.stages));
    const durationS = parseDuration(String(values["stage-duration"]));
    const scenarioFile = join6(project, ".vibe-breakpoint", "scenario.json");
    const scenarioText = inputFile(scenarioFile, "scenario.json");
    const scenario = scenarioText !== void 0 ? parseScenario(scenarioText, seed) : void 0;
    if (!scenario) console.log("vibe-breakpoint: no scenario.json; skipping load test");
    const sb = createSandbox(project, runId, profile, mockDir, template);
    composePath = sb.composePath;
    env = sb.env;
    if (scenario) sb.images.push("grafana/k6");
    const missing = missingImages(sb.images);
    console.log(`vibe-breakpoint: building app image from ${sb.plan.dockerfile === "project" ? "project Dockerfile" : "template node.Dockerfile"} (network access during build only; the app runs offline)`);
    console.log(`vibe-breakpoint: images: ${sb.images.map((i) => `${i} (${missing.includes(i) ? "missing" : "local"})`).join(", ")}`);
    if (missing.length) {
      if (!values.pull) throw new Error(`images not available locally: ${missing.join(", ")}; re-run with --pull after the user agrees`);
      pullImages(missing);
    }
    buildApp(composePath);
    up(composePath, ["db", "mock"]);
    migrate(composePath, sb.plan, sb.copyDir);
    const probeSteps = scenario?.probe_endpoints?.length ? scenario.flow.filter((st) => scenario.probe_endpoints.includes(st.name)) : [];
    const probing = Boolean(seed && scenario && probeSteps.length);
    if (scenario && !seed) console.log("vibe-breakpoint: no seed.json; skipping query probe");
    else if (scenario && !probeSteps.length) console.log("vibe-breakpoint: no probe_endpoints; skipping query probe");
    let statSchema = "";
    if (probing) {
      psql(composePath, "CREATE SCHEMA IF NOT EXISTS vb_probe; CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA vb_probe;");
      statSchema = psql(composePath, "SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_stat_statements';").replace(/^"(.*)"$/, "$1");
    }
    let cols = [];
    if (seed) {
      cols = dbColumns(composePath);
      const errs = schemaErrors(seed, cols);
      if (errs.length) throw new Error(`seed.json: ${errs.join("; ")}`);
    }
    try {
      up(composePath, ["app"]);
    } catch (e) {
      throw new Error(`app did not become healthy within 120 s (the health check needs Docker Engine 25 or newer) (GET ${sb.healthPath}):
${appLogs(composePath)}
${e instanceof Error ? e.message : ""}`);
    }
    console.log(`vibe-breakpoint: sandbox ready ${runId}`);
    const probe = {};
    const raw = {};
    const scans = {};
    const probeScript = probing ? readFileSync5(fileURLToPath(new URL("../templates/k6/probe.js", import.meta.url)), "utf8") : "";
    const keys = /* @__PURE__ */ new Map();
    if (probing) {
      const taken = /* @__PURE__ */ new Set();
      for (const st of probeSteps) keys.set(st.name, endpointKey(st, taken));
    }
    const readStats = () => keepRows(JSON.parse(psql(composePath, statsSql(statSchema), false)));
    const explainAtL = () => {
      psql(composePath, "ANALYZE;", false);
      const found = [];
      for (const ep of Object.keys(raw)) for (const rows of [raw[ep].L ?? []]) for (const text of explainCandidates(rows)) {
        const qid = rows.find((r) => r.query.trimEnd().replace(/;$/, "") === text).queryid;
        try {
          const plan = JSON.parse(psql(composePath, `SET statement_timeout='10s'; EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ${text}`, false));
          for (const sc of seqScans(plan)) found.push({ qid, ...sc });
        } catch {
        }
      }
      const rels = [...new Map(found.filter((f) => f.schema).map((f) => [`${f.schema}.${f.table}`, { schema: f.schema, table: f.table }])).values()];
      if (!rels.length) return;
      let sizesByRel = /* @__PURE__ */ new Map();
      try {
        const rows = JSON.parse(psql(composePath, relTuplesSql(rels)));
        sizesByRel = new Map(rows.map((r) => [`${r.s}.${r.t}`, Number(r.n)]));
      } catch {
        return;
      }
      for (const f of found) (scans[f.qid] ??= []).push({ table: f.table, filter: safeText(f.filter, env), table_rows: sizesByRel.get(`${f.schema}.${f.table}`) ?? 0 });
    };
    const probeSize = async (size) => {
      const base = { ...loadConfig(scenario, seed, size), targets: probeSteps.map((st) => st.name), iterations: PROBE_REQUESTS };
      const prepRes = await probeK6(composePath, probeScript, { ...base, mode: "prep" });
      if (prepRes.fails) throw new Error(`probe warm-up failed for size ${size}`);
      for (const st of probeSteps) {
        const key = keys.get(st.name);
        psql(composePath, `SELECT ${statSchema}.pg_stat_statements_reset();`, false);
        const res = await probeK6(composePath, probeScript, { ...base, mode: "run", cookies: prepRes.cookies ?? {}, targets: [st.name] });
        if (res.fails > 0) {
          console.log(`vibe-breakpoint: probe ${key} size ${size}: ${res.fails} of ${PROBE_REQUESTS} requests failed; skipped`);
          continue;
        }
        const rows = readStats();
        const e = summarize(rows, PROBE_REQUESTS, env);
        (probe[key] ??= {})[size] = e;
        (raw[key] ??= {})[size] = rows;
        console.log(`vibe-breakpoint: probe ${key} size ${size}: ${e.queries_per_req} queries/req, ${e.db_ms_per_req} ms db/req, ${e.rows_per_req} rows/req`);
      }
      if (size === "L") explainAtL();
    };
    if (seed) {
      for (const size of sizes) {
        const r = seedSize(composePath, seed, cols, size);
        console.log(`vibe-breakpoint: seeded ${r.size} in ${r.ms} ms ${JSON.stringify(r.tables)}`);
        if (probing && !values.hold) await probeSize(size);
      }
    }
    if (values.hold) {
      setInterval(() => {
      }, 1 << 30);
      await new Promise(() => {
      });
    }
    let flags = [];
    let resultBase;
    if (probing && seed) {
      if (sizes.includes("S") && sizes.includes("L")) {
        flags = computeFlags(raw, PROBE_REQUESTS, seed.sizes, scans, env);
        for (const f of flags) console.log(`vibe-breakpoint: flag ${f.flag} ${f.endpoint} (${f.evidence.metric} S ${f.evidence.by_size.S} -> L ${f.evidence.by_size.L})`);
      } else console.log("vibe-breakpoint: flags need sizes S and L; skipping flags");
      resultBase = { runId, toolVersion: package_default.version, profile, size: null, stageDurationS: durationS, thinkTimeS: scenario.think_time_s, stages: [], probe, flags };
      safeWriteOut(project, "out/result.json", JSON.stringify(buildResult(resultBase), null, 2));
    }
    if (scenario) {
      const rampSize = sizes.includes("M") ? "M" : sizes[sizes.length - 1] ?? null;
      const cfgSize = seed ? rampSize : null;
      if (seed && cfgSize === "M" && sizes[sizes.length - 1] !== "M") {
        const r = seedSize(composePath, seed, dbColumns(composePath), "M");
        console.log(`vibe-breakpoint: seeded ${r.size} in ${r.ms} ms ${JSON.stringify(r.tables)}`);
      }
      const script = readFileSync5(fileURLToPath(new URL("../templates/k6/load.js", import.meta.url)), "utf8");
      const cfg = loadConfig(scenario, seed, cfgSize);
      console.log(`vibe-breakpoint: load test on size ${cfgSize}: stages ${stages.join(",")} x ${durationS} s`);
      const done = [];
      for (const users of stages) {
        const { summary, samples } = await runStage(composePath, script, cfg, users, durationS);
        const st = { ...stageFromSummary(summary, users), ...aggregate(samples, profile) };
        done.push(st);
        safeWriteOut(project, `out/k6/${users}.json`, JSON.stringify(summary));
        console.log(`vibe-breakpoint: stage ${users} users: p50 ${st.p50_ms} ms, p95 ${st.p95_ms} ms, errors ${(st.error_rate * 100).toFixed(2)} %, app cpu ${st.app_cpu}, db cpu ${st.db_cpu}, app mem ${st.app_mem_mb} MB`);
        if (isBroken(st)) break;
      }
      const result = buildResult({ runId, toolVersion: package_default.version, profile, size: cfgSize, stageDurationS: durationS, thinkTimeS: scenario.think_time_s, stages: done, probe, flags });
      safeWriteOut(project, "out/result.json", JSON.stringify(result, null, 2));
      const bp = result.breaking_point;
      console.log(bp ? `vibe-breakpoint: breaking point ${bp.users_broke} users (${bp.reason}); handles about ${bp.users_ok}; limiting: ${result.limiting_resource}` : `vibe-breakpoint: no breaking point up to ${done[done.length - 1].users}`);
    }
  } catch (e) {
    failed = true;
    const msg = redact(e instanceof Error ? e.message : String(e), env);
    if (e instanceof Unsupported) {
      console.error(`vibe-breakpoint: unsupported because ${msg}`);
      process.exitCode = 2;
    } else {
      console.error(`vibe-breakpoint: ${msg}`);
      process.exitCode = 1;
    }
  } finally {
    if (failed && values["keep-on-fail"]) console.error(`vibe-breakpoint: kept run ${runId}; remove with: vibe-breakpoint cleanup --all`);
    else {
      save();
      down(runId);
    }
  }
}
function readRegular(file) {
  try {
    return lstatSync3(file).isFile() ? readFileSync5(file, "utf8") : void 0;
  } catch {
    return void 0;
  }
}
var DB_DEPS = ["@prisma/client", "prisma", "drizzle-orm", "knex", "pg", "postgres", "@supabase/supabase-js", "firebase", "firebase-admin", "mysql2", "mongoose", "sequelize", "typeorm"];
function inspectCmd(project) {
  if (!project || !statSync2(project, { throwIfNoEntry: false })?.isDirectory()) fail("project not found");
  const d = spawnSync2("docker", ["version"], { stdio: "ignore" });
  const docker2 = d.status === 0 ? { available: true, reason: null } : { available: false, reason: d.error ? "the docker command was not found" : "the Docker daemon is not running or not reachable" };
  let plan;
  let unsupported = null;
  try {
    plan = detectApp(project);
  } catch (e) {
    unsupported = e instanceof Unsupported ? e.message : "package.json could not be parsed";
  }
  let dbDeps = [];
  try {
    const pkg = JSON.parse(readFileSync5(join6(project, "package.json"), "utf8"));
    const all = { ...pkg.devDependencies, ...pkg.dependencies };
    dbDeps = DB_DEPS.filter((n2) => n2 in all).sort();
  } catch {
  }
  const images = plan ? [.../* @__PURE__ */ new Set([...requiredImages(project, plan.dockerfile === "project"), "grafana/k6"])] : [];
  const isFile = (f) => lstatSync3(join6(project, ".vibe-breakpoint", f), { throwIfNoEntry: false })?.isFile() ?? false;
  const info = {
    schema: 1,
    tool_version: package_default.version,
    docker: docker2,
    supported: Boolean(plan),
    unsupported_reason: unsupported,
    framework: plan?.framework ?? null,
    dockerfile: plan?.dockerfile ?? null,
    migrations: plan?.migrations.kind ?? null,
    db_deps: dbDeps,
    env_names: envNames(project),
    images,
    missing_images: docker2.available && plan ? missingImages(images) : null,
    has_scenario: isFile("scenario.json"),
    has_seed: isFile("seed.json")
  };
  const text = JSON.stringify(info, null, 2);
  try {
    safeWriteOut(project, "inspect.json", text);
  } catch (e) {
    fail(e instanceof Error ? e.message : "could not write inspect.json");
  }
  console.log(text);
}
async function renderCmd(project) {
  if (!project || !statSync2(project, { throwIfNoEntry: false })?.isDirectory()) fail("project not found");
  const base = join6(project, ".vibe-breakpoint");
  const resFile = join6(base, "out", "result.json");
  const st = lstatSync3(resFile, { throwIfNoEntry: false });
  if (!st) fail('no out/result.json; run "vibe-breakpoint run <project>" first');
  if (!st.isFile()) fail("result.json is not a regular file");
  let result;
  try {
    result = JSON.parse(readFileSync5(resFile, "utf8"));
  } catch {
    fail("result.json is not valid JSON");
  }
  const bad2 = resultError(result);
  if (bad2) fail(`result.json: ${bad2}`);
  let mockLog;
  try {
    const m = JSON.parse(readRegular(join6(base, "out", "mock-log.json")) ?? "");
    if (Array.isArray(m.calls) && m.calls.every((c) => typeof c?.service === "string" && typeof c.method === "string" && typeof c.path === "string" && Number.isFinite(c.count))) mockLog = m.calls;
  } catch {
  }
  let seedSizes;
  try {
    seedSizes = parseSeed(readRegular(join6(base, "seed.json")) ?? "").sizes;
  } catch {
  }
  const name = projectLabel(realpathSync3(project));
  const svg = chartSvg(result, name);
  safeWriteOut(project, "out/chart.svg", svg);
  safeWriteOut(project, "out/report.md", reportMd({ result, project: name, mockLog, seedSizes, codeLocations: readRegular(join6(base, "code-locations.md")) }));
  const wrote = ["out/chart.svg", "out/report.md"];
  try {
    safeWriteOut(project, "out/chart.png", Buffer.from(await svgToPng(svg, fileURLToPath(new URL("../assets/", import.meta.url)))));
    wrote.splice(1, 0, "out/chart.png");
  } catch (e) {
    console.error(`vibe-breakpoint: PNG skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`vibe-breakpoint: wrote ${wrote.join(", ")}`);
}
if (values.version) {
  console.log(package_default.version);
} else if (values.help) {
  process.stdout.write(usage);
} else if (cmd === "cleanup") {
  const r = cleanup(Boolean(values.all));
  console.log(r.runs.length ? `vibe-breakpoint: removed ${r.runs.join(", ")}` : "vibe-breakpoint: nothing to clean");
  if (!r.dockerAvailable) console.log("vibe-breakpoint: Docker not available; only temp folders were removed");
} else if (cmd === "run") {
  await runCmd(positionals[1]);
} else if (cmd === "render") {
  await renderCmd(positionals[1]);
} else if (cmd === "inspect") {
  inspectCmd(positionals[1]);
} else {
  process.stderr.write(usage);
  process.exitCode = 1;
}
