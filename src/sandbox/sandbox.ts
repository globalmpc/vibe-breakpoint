import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { parseStatsLine, type Sample } from "../load/result.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWriteOut } from "./safe-out.js";
import { composeFile, type Profile } from "./compose.js";
import { copyProject } from "./copy.js";
import { detectApp, fromImages, healthPath, type AppPlan } from "./detect.js";
import { envNames } from "./env-names.js";
import { envFileText, testEnv } from "./test-env.js";
import { RESERVED_ENV, type RunJson } from "./run-json.js";

export const TEMP_PREFIX = "vibe-breakpoint-";
export const RUN_DIR_RE = /^vibe-breakpoint-(vb-\d{14}-[0-9a-f]{4})$/;
const LABEL = "vibe-breakpoint.run";

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `vb-${ts}-${randomBytes(2).toString("hex")}`;
}

export const RUN_ID_RE = /^vb-\d{14}-[0-9a-f]{4}$/;

export function runDir(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  return join(tmpdir(), TEMP_PREFIX + runId);
}

const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const lines = (s: string | null | undefined) => (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

export function requiredImages(dir: string, own: boolean): string[] {
  return [...new Set(["postgres:16", "node:22-alpine", ...(own ? fromImages(readFileSync(join(dir, "Dockerfile"), "utf8")) : [])])];
}

export type Sandbox = { composePath: string; copyDir: string; plan: AppPlan; env: Record<string, string>; images: string[]; healthPath: string };

export function createSandbox(project: string, runId: string, profile: Profile, mockDir: string, templateDockerfile: string, run: RunJson = {}): Sandbox {
  const dir = runDir(runId);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "pid"), String(process.pid));
  const copyDir = join(dir, "project");
  copyProject(project, copyDir);
  const plan = detectApp(copyDir, run);
  const dbPassword = randomBytes(16).toString("hex");
  const env = testEnv([...new Set([...envNames(project), ...(run.env_names ?? [])])].filter((n) => !RESERVED_ENV.test(n)), dbPassword);
  const envFile = join(dir, "test.env");
  writeFileSync(envFile, envFileText(env), { mode: 0o600 });
  const own = plan.dockerfile === "project";
  const hp = healthPath(project);
  const composePath = join(dir, "compose.json");
  const app = {
    context: copyDir,
    dockerfile: own ? join(copyDir, "Dockerfile") : templateDockerfile,
    healthPath: hp,
    ...(!own && { buildCmd: plan.buildCmd }),
    ...(plan.start && { command: plan.start }),
  };
  writeFileSync(composePath, JSON.stringify(composeFile({ runId, profile, dbPassword, envFile, mockDir, app }), null, 2), { mode: 0o600 });
  const images = requiredImages(copyDir, own);
  return { composePath, copyDir, plan, env, images, healthPath: hp };
}

const tail = (s: string, n = 30) => s.trim().split("\n").slice(-n).join("\n");
const out = (r: { stdout?: string | null; stderr?: string | null }) => (r.stdout ?? "") + (r.stderr ?? "");
const compose = (composePath: string, args: string[], opts: object = {}) => spawnSync("docker", ["compose", "-f", composePath, ...args], { encoding: "utf8", ...opts });

export function missingImages(images: string[]): string[] {
  return images.filter((i) => docker(["image", "inspect", i]).status !== 0);
}

export function pullImages(images: string[]): void {
  for (const i of images) {
    const r = docker(["pull", i]);
    if (r.status !== 0) throw new Error(`docker pull ${i} failed: ${tail(out(r), 5)}`);
  }
}

export function buildApp(composePath: string): void {
  // Compose 5 builds through bake by default, which refuses the template Dockerfile outside the context (D-022).
  const r = compose(composePath, ["--progress", "plain", "build", "app"], { env: { ...process.env, COMPOSE_BAKE: "false" } });
  if (r.status !== 0) throw new Error(`app build failed:\n${tail(out(r))}`);
}

export function up(composePath: string, services: string[]): void {
  const r = compose(composePath, ["up", "-d", "--wait", "--wait-timeout", "120", "--pull", "never", "--no-build", ...services]);
  if (r.status !== 0) throw new Error(`docker compose up failed (${services.join(", ")}):\n${tail(out(r), 5)}`);
}

/** --entrypoint skips a project ENTRYPOINT; cmd[0] is always a fixed node_modules/.bin/<tool> path (detect.ts) */
export function migrateArgs(cmd: string[]): string[] {
  return ["run", "--rm", "--no-deps", "-T", "--entrypoint", cmd[0], "app", ...cmd.slice(1)];
}

export function migrate(composePath: string, plan: AppPlan, copyDir: string): void {
  const m = plan.migrations;
  if (m.kind === "none") {
    console.log("vibe-breakpoint: no migrations detected; the app starts on an empty database");
  } else if (m.kind === "sql") {
    for (const f of m.files) {
      const r = compose(composePath, ["exec", "-T", "db", "psql", "-U", "vb", "-d", "vb", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], { input: readFileSync(join(copyDir, f)) });
      if (r.status !== 0) throw new Error(`migrations failed (sql: ${f}):\n${tail(out(r))}`);
    }
  } else {
    const r = compose(composePath, migrateArgs(m.cmd));
    if (r.status !== 0) throw new Error(`migrations failed (${m.kind}: ${m.cmd.join(" ")}):\n${tail(out(r))}`);
  }
}

/** psql arg list; seeding/migrations stay in one transaction (-1), probe control queries must not (BEGIN/COMMIT would count in the measured window). */
export const psqlArgs = (tx = true): string[] => ["exec", "-T", "db", "psql", "-U", "vb", "-d", "vb", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...(tx ? ["-1"] : []), "-f", "-"];

export function psql(composePath: string, sql: string, tx = true): string {
  const r = compose(composePath, psqlArgs(tx), { input: sql, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`psql failed:\n${tail(out(r))}`);
  return (r.stdout ?? "").trim();
}

export function appLogs(composePath: string): string {
  return tail(out(compose(composePath, ["logs", "--no-color", "--tail", "30", "app"])));
}

export function saveMockLog(composePath: string, project: string): void {
  try {
    if (!existsSync(composePath)) return;
    const r = compose(composePath, ["exec", "-T", "mock", "wget", "-qO-", "http://127.0.0.1:4010/__vb/log"], { timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return;
    safeWriteOut(project, "out/mock-log.json", r.stdout);
  } catch { /* best effort */ }
}

function removeRun(runId: string): void {
  const f = ["--filter", `label=${LABEL}=${runId}`];
  const steps: [string[], string[]][] = [
    [["ps", "-aq", ...f], ["rm", "-fv"]],
    [["image", "ls", "-q", ...f], ["image", "rm", "-f"]],
    [["network", "ls", "-q", ...f], ["network", "rm"]],
    [["volume", "ls", "-q", ...f], ["volume", "rm", "-f"]],
  ];
  for (const [list, rm] of steps) {
    const ids = lines(docker(list).stdout);
    if (!ids.length) continue;
    const r = docker([...rm, ...ids]);
    if (r.status !== 0) process.stderr.write(`vibe-breakpoint: ${rm[0]} failed: ${(r.stderr || "").trim()}\n`);
  }
}

export function down(runId: string): void {
  if (!RUN_ID_RE.test(runId)) return; // never touch docker or disk for an untrusted id
  try { removeRun(runId); } catch (e) { process.stderr.write(`vibe-breakpoint: down: ${String(e)}\n`); }
  try { rmSync(runDir(runId), { recursive: true, force: true }); } catch { /* best effort */ }
}

export function onSignals(fn: () => void): void {
  let done = false;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(sig, () => {
      if (!done) { done = true; fn(); }
      process.exit(code);
    });
  }
}

function alive(runId: string): boolean {
  try {
    const pid = Number(readFileSync(join(runDir(runId), "pid"), "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function cleanup(all: boolean): { runs: string[]; dockerAvailable: boolean } {
  const ids = new Set<string>();
  const dockerAvailable = docker(["version"]).status === 0;
  if (dockerAvailable) {
    const fmt = ["--format", `{{.Label "${LABEL}"}}`, "--filter", "label=vibe-breakpoint=1"];
    for (const list of [["ps", "-a"], ["network", "ls"], ["volume", "ls"]]) for (const id of lines(docker([...list, ...fmt]).stdout)) ids.add(id);
    for (const t of lines(docker(["image", "ls", "vb-app", "--format", "{{.Tag}}"]).stdout)) ids.add(t);
  }
  for (const n of readdirSync(tmpdir())) { const m = RUN_DIR_RE.exec(n); if (m) ids.add(m[1]); }
  const runs = [...ids].filter((id) => RUN_ID_RE.test(id) && (all || !alive(id)));
  for (const id of runs) {
    if (dockerAvailable) down(id);
    else rmSync(runDir(id), { recursive: true, force: true });
  }
  return { runs, dockerAvailable };
}

const execFileP = promisify(execFile);

/** Resolves with the exit code; a spawn failure (e.g. docker missing) becomes a rejection so cleanup still runs. */
export function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((res, rej) => {
    child.on("error", (e) => rej(new Error(`could not run docker: ${(e as NodeJS.ErrnoException).code ?? "spawn error"}`)));
    child.on("close", (c) => res(c));
  });
}

/** One k6 container per stage (constant VUs); samples app/db CPU+memory with `docker stats` while it runs. */
export async function runStage(composePath: string, script: string, cfg: object, users: number, durationS: number): Promise<{ summary: unknown; samples: { app: Sample[]; db: Sample[] } }> {
  const ps = (svc: string) => (compose(composePath, ["ps", "-q", svc]).stdout ?? "").trim();
  const appId = ps("app");
  const dbId = ps("db");
  const vb = JSON.stringify({ ...cfg, users, duration_s: durationS });
  const child = spawn("docker", ["compose", "-f", composePath, "--profile", "load", "run", "--rm", "--no-deps", "-T", "k6", "run", "--quiet", "-e", `VB_CONFIG=${vb}`, "-"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const exit = exitOf(child);
  child.stdin.on("error", () => {});
  child.stdin.end(script);
  const samples = { app: [] as Sample[], db: [] as Sample[] };
  let done = false;
  const stop = () => { done = true; };
  exit.then(stop, stop); // a rejection is rethrown by `await exit` below
  while (!done) {
    try {
      const { stdout: o } = await execFileP("docker", ["stats", "--no-stream", "--format", "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}", appId, dbId], { timeout: 15000 });
      for (const l of o.split("\n").filter(Boolean)) {
        const [id, cpu, mem] = l.split("\t");
        const list = appId.startsWith(id) ? samples.app : dbId.startsWith(id) ? samples.db : null;
        if (list && !done) list.push(parseStatsLine(cpu, mem));
      }
    } catch { /* stats are best effort */ }
  }
  const code = await exit;
  const line = stdout.split("\n").find((l) => l.startsWith("VB_SUMMARY "));
  if (code !== 0 || !line) throw new Error(`k6 failed (stage ${users} users):\n${tail(stdout + stderr)}`);
  return { summary: JSON.parse(line.slice("VB_SUMMARY ".length)), samples };
}

/** One k6 probe container (async so signal traps still run). Returns the parsed VB_PROBE line.
 *  The VB_PROBE line can carry cookies: never printed; on failure every VB_ line is dropped from the message. */
export async function probeK6(composePath: string, script: string, cfg: object): Promise<{ fails: number; cookies?: Record<string, string[]>; login?: number[] }> {
  const child = spawn("docker", ["compose", "-f", composePath, "--profile", "load", "run", "--rm", "--no-deps", "-T", "k6", "run", "--quiet", "--log-format", "raw", "-e", `VB_CONFIG=${JSON.stringify(cfg)}`, "-"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const exit = exitOf(child);
  child.stdin.on("error", () => {});
  child.stdin.end(script);
  const code = await exit;
  const line = stdout.split("\n").find((l) => l.startsWith("VB_PROBE "));
  if (code !== 0 || !line) {
    const safe = stdout.split("\n").filter((l) => !l.includes("VB_")).join("\n");
    throw new Error(`k6 probe failed:\n${tail(safe + "\n" + stderr.split("\n").filter((l) => !l.includes("VB_")).join("\n"), 15)}`);
  }
  const res = JSON.parse(line.slice("VB_PROBE ".length));
  const ck = stderr.split("\n").find((l) => l.startsWith("VB_COOKIES "));
  if (ck) res.cookies = JSON.parse(ck.slice("VB_COOKIES ".length)); // cookies after warm-up (rotation)
  return res;
}
