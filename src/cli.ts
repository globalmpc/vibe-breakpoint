import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES, type Profile } from "./sandbox/compose.js";
import { detectApp, hostBuildDir, Unsupported } from "./sandbox/detect.js";
import { safeWriteOut } from "./sandbox/safe-out.js";
import { envNames } from "./sandbox/env-names.js";
import { parseRunJson, type RunJson } from "./sandbox/run-json.js";
import { appLogs, buildApp, cleanup, createSandbox, down, migrate, missingImages, newRunId, onSignals, pullImages, probeK6, psql, requiredImages, runStage, saveMockLog, up } from "./sandbox/sandbox.js";
import { dbColumns, parseSeed, schemaErrors, seedSize, SIZES, type Seed, type Size } from "./seed/seed.js";
import { loadConfig, parseScenario } from "./load/scenario.js";
import { aggregate, buildResult, isBroken, parseDuration, parseStages, stageFromSummary, type Stage } from "./load/result.js";
import { endpointKey, explainCandidates, keepRows, PROBE_REQUESTS, relTuplesSql, safeText, statsSql, summarize, type Probe, type RawProbe, type StatRow } from "./probe/probe.js";
import { computeFlags, seqScans, type Flag, type SeqScan } from "./probe/flags.js";
import { redact } from "./sandbox/test-env.js";
import { chartSvg, projectLabel, resultError, type Result } from "./render/chart.js";
import { reportMd, type MockCall } from "./render/report.js";
import { svgToPng } from "./render/png.js";
import manifest from "../package.json" with { type: "json" };

const usage = `usage:
  vibe-breakpoint inspect  <project>
  vibe-breakpoint run      <project> [--profile small] [--pull] [--sizes S,M,L] [--stages 10,25,...] [--stage-duration 60] [--keep-on-fail]
  vibe-breakpoint render   <project>
  vibe-breakpoint cleanup  [--all]
  vibe-breakpoint --version
`;

function hostBuildDirOf(project: string): string | null {
  try { return hostBuildDir(readFileSync(join(project, "Dockerfile"), "utf8")); } catch { return null; }
}

const { values, positionals } = parseArgs({
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
    "stage-duration": { type: "string", default: "60" },
  },
});

const cmd = positionals[0];

function fail(msg: string): never {
  console.error(`vibe-breakpoint: ${msg}`);
  process.exit(1);
}

/** run input: undefined if absent; a symlink or non-regular file is a fixed error (never echoes content) */
function inputFile(file: string, label: string): string | undefined {
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isFile()) throw new Error(`${label} must be a regular file (not a symlink or folder)`);
  return readFileSync(file, "utf8");
}

async function runCmd(project: string | undefined) {
  const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  if (!project || !isDir(project)) fail("project not found");
  const profile = String(values.profile);
  if (!(profile in PROFILES)) fail(`unknown profile: ${profile}`);
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) fail("Docker is not available");
  const mockDir = fileURLToPath(new URL("../templates/mock", import.meta.url));
  const template = fileURLToPath(new URL("../templates/dockerfiles/node.Dockerfile", import.meta.url));
  const runId = newRunId();
    let composePath = "";
  const save = () => { if (composePath) saveMockLog(composePath, project); };
  onSignals(() => { save(); down(runId); });
  let failed = false;
  let env: Record<string, string> = {};
  try {
    const sizes = [...new Set(String(values.sizes).split(","))].map((x) => {
      if (!(SIZES as readonly string[]).includes(x)) throw new Error(`unknown size: ${x}`);
      return x as Size;
    });
    const seedFile = join(project, ".vibe-breakpoint", "seed.json");
    let seed: Seed | undefined;
    const seedText = inputFile(seedFile, "seed.json");
    if (seedText !== undefined) seed = parseSeed(seedText);
    else console.log("vibe-breakpoint: no seed.json; skipping seeding");
    const stages = parseStages(String(values.stages));
    const durationS = parseDuration(String(values["stage-duration"]));
    const scenarioFile = join(project, ".vibe-breakpoint", "scenario.json");
    const scenarioText = inputFile(scenarioFile, "scenario.json");
    const scenario = scenarioText !== undefined ? parseScenario(scenarioText, seed) : undefined;
    if (!scenario) console.log("vibe-breakpoint: no scenario.json; skipping load test");
    const runText = inputFile(join(project, ".vibe-breakpoint", "run.json"), "run.json");
    const runJson = runText !== undefined ? parseRunJson(runText) : undefined;
    const sb = createSandbox(project, runId, profile as Profile, mockDir, template, runJson);
    composePath = sb.composePath;
    env = sb.env;
    if (scenario) sb.images.push("grafana/k6");
    const missing = missingImages(sb.images);
    const hostDir = sb.plan.dockerfile === "template" ? hostBuildDirOf(project) : null;
    if (hostDir) console.log(`vibe-breakpoint: project Dockerfile not used: it copies ${hostDir}/ from the host build; using the template`);
    if (sb.plan.startFromDockerfile) console.log(`vibe-breakpoint: start command taken from the project Dockerfile (${sb.plan.start?.join(" ")})`);
    console.log(`vibe-breakpoint: building app image from ${sb.plan.dockerfile === "project" ? "project Dockerfile" : "template node.Dockerfile"} (network access during build only; the app runs offline)`);
    console.log(`vibe-breakpoint: images: ${sb.images.map((i) => `${i} (${missing.includes(i) ? "missing" : "local"})`).join(", ")}`);
    if (missing.length) {
      if (!values.pull) throw new Error(`images not available locally: ${missing.join(", ")}; re-run with --pull after the user agrees`);
      pullImages(missing);
    }
    buildApp(composePath);
    up(composePath, ["db", "mock"]);
    migrate(composePath, sb.plan, sb.copyDir);
    const probeSteps = scenario?.probe_endpoints?.length ? scenario.flow.filter((st) => scenario.probe_endpoints!.includes(st.name)) : [];
    const probing = Boolean(seed && scenario && probeSteps.length);
    if (scenario && !seed) console.log("vibe-breakpoint: no seed.json; skipping query probe");
    else if (scenario && !probeSteps.length) console.log("vibe-breakpoint: no probe_endpoints; skipping query probe");
    let statSchema = "";
    if (probing) {
      psql(composePath, "CREATE SCHEMA IF NOT EXISTS vb_probe; CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA vb_probe;");
      statSchema = psql(composePath, "SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pg_stat_statements';").replace(/^"(.*)"$/, "$1");
    }
    let cols: ReturnType<typeof dbColumns> = [];
    if (seed) {
      cols = dbColumns(composePath);
      const errs = schemaErrors(seed, cols);
      if (errs.length) throw new Error(`seed.json: ${errs.join("; ")}`);
    }
    try {
      up(composePath, ["app"]);
    } catch (e) {
      throw new Error(`app did not start: app did not become healthy within 120 s (the health check needs Docker Engine 25 or newer) (GET ${sb.healthPath}):\n${appLogs(composePath)}\n${e instanceof Error ? e.message : ""}`);
    }
    console.log(`vibe-breakpoint: sandbox ready ${runId}`);
    const probe: Probe = {};
    const raw: RawProbe = {};
    const scans: Record<string, SeqScan[]> = {};
    const probeScript = probing ? readFileSync(fileURLToPath(new URL("../templates/k6/probe.js", import.meta.url)), "utf8") : "";
    const keys = new Map<string, string>();
    if (probing) { const taken = new Set<string>(); for (const st of probeSteps) keys.set(st.name, endpointKey(st, taken)); }
    const readStats = () => keepRows(JSON.parse(psql(composePath, statsSql(statSchema), false)) as StatRow[]);
    const explainAtL = () => {
      psql(composePath, "ANALYZE;", false);
      const found: { qid: string; schema: string; table: string; filter: string }[] = [];
      for (const ep of Object.keys(raw)) for (const rows of [raw[ep].L ?? []]) for (const text of explainCandidates(rows)) {
        const qid = rows.find((r) => r.query.trimEnd().replace(/;$/, "") === text)!.queryid;
        try {
          const plan = JSON.parse(psql(composePath, `SET statement_timeout='10s'; EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ${text}`, false));
          for (const sc of seqScans(plan)) found.push({ qid, ...sc });
        } catch { /* no evidence for this query */ }
      }
      const rels = [...new Map(found.filter((f) => f.schema).map((f) => [`${f.schema}.${f.table}`, { schema: f.schema, table: f.table }])).values()];
      if (!rels.length) return;
      let sizesByRel = new Map<string, number>();
      try {
        const rows = JSON.parse(psql(composePath, relTuplesSql(rels))) as { s: string; t: string; n: number }[];
        sizesByRel = new Map(rows.map((r) => [`${r.s}.${r.t}`, Number(r.n)]));
      } catch { return; }
      for (const f of found) (scans[f.qid] ??= []).push({ table: f.table, filter: safeText(f.filter, env), table_rows: sizesByRel.get(`${f.schema}.${f.table}`) ?? 0 });
    };
    const probeSize = async (size: Size) => {
      const base = { ...loadConfig(scenario!, seed, size), targets: probeSteps.map((st) => st.name), iterations: PROBE_REQUESTS };
      const prepRes = await probeK6(composePath, probeScript, { ...base, mode: "prep" });
      if (prepRes.fails) throw new Error(`probe warm-up failed for size ${size}`);
      for (const st of probeSteps) {
        const key = keys.get(st.name)!;
        psql(composePath, `SELECT ${statSchema}.pg_stat_statements_reset();`, false);
        const res = await probeK6(composePath, probeScript, { ...base, mode: "run", cookies: prepRes.cookies ?? {}, targets: [st.name] });
        if (res.fails > 0) { console.log(`vibe-breakpoint: probe ${key} size ${size}: ${res.fails} of ${PROBE_REQUESTS} requests failed; skipped`); continue; }
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
    if (values.hold) { setInterval(() => {}, 1 << 30); await new Promise<never>(() => {}); } // timer keeps the loop alive until a signal
    let flags: Flag[] = [];
    let resultBase: Parameters<typeof buildResult>[0] | undefined;
    if (probing && seed) {
      if (sizes.includes("S") && sizes.includes("L")) {
        flags = computeFlags(raw, PROBE_REQUESTS, seed.sizes, scans, env);
        for (const f of flags) console.log(`vibe-breakpoint: flag ${f.flag} ${f.endpoint} (${f.evidence.metric} S ${f.evidence.by_size.S} -> L ${f.evidence.by_size.L})`);
      } else console.log("vibe-breakpoint: flags need sizes S and L; skipping flags");
      resultBase = { runId, toolVersion: manifest.version, profile: profile as Profile, size: null, stageDurationS: durationS, thinkTimeS: scenario!.think_time_s, stages: [], probe, flags };
      safeWriteOut(project, "out/result.json", JSON.stringify(buildResult(resultBase), null, 2));
    }
    if (scenario) {
      const rampSize: Size | null = sizes.includes("M") ? "M" : sizes[sizes.length - 1] ?? null;
      const cfgSize = seed ? rampSize : null;
      if (seed && cfgSize === "M" && sizes[sizes.length - 1] !== "M") {
        const r = seedSize(composePath, seed, dbColumns(composePath), "M");
        console.log(`vibe-breakpoint: seeded ${r.size} in ${r.ms} ms ${JSON.stringify(r.tables)}`);
      }
      const script = readFileSync(fileURLToPath(new URL("../templates/k6/load.js", import.meta.url)), "utf8");
      const cfg = loadConfig(scenario, seed, cfgSize);
      console.log(`vibe-breakpoint: load test on size ${cfgSize}: stages ${stages.join(",")} x ${durationS} s`);
      const done: Stage[] = [];
      for (const users of stages) {
        const { summary, samples } = await runStage(composePath, script, cfg, users, durationS);
        const st: Stage = { ...stageFromSummary(summary, users), ...aggregate(samples, profile as Profile) };
        done.push(st);
        safeWriteOut(project, `out/k6/${users}.json`, JSON.stringify(summary));
        console.log(`vibe-breakpoint: stage ${users} users: p50 ${st.p50_ms} ms, p95 ${st.p95_ms} ms, errors ${(st.error_rate * 100).toFixed(2)} %, app cpu ${st.app_cpu}, db cpu ${st.db_cpu}, app mem ${st.app_mem_mb} MB`);
        if (isBroken(st)) break;
      }
      const result = buildResult({ runId, toolVersion: manifest.version, profile: profile as Profile, size: cfgSize, stageDurationS: durationS, thinkTimeS: scenario.think_time_s, stages: done, probe, flags });
      safeWriteOut(project, "out/result.json", JSON.stringify(result, null, 2));
      const bp = result.breaking_point;
      console.log(bp
        ? `vibe-breakpoint: breaking point ${bp.users_broke} users (${bp.reason}); ${bp.users_ok > 0 ? `handles about ${bp.users_ok}` : "broke at the first stage tested"}; limiting: ${result.limiting_resource}`
        : `vibe-breakpoint: no breaking point up to ${done[done.length - 1].users}`);
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
    else { save(); down(runId); }
  }
}

/** file content only if it is a regular, non-symlink file; else undefined (never throws, never echoes) */
function readRegular(file: string): string | undefined {
  try { return lstatSync(file).isFile() ? readFileSync(file, "utf8") : undefined; } catch { return undefined; }
}

const DB_DEPS = ["@prisma/client", "prisma", "drizzle-orm", "knex", "pg", "postgres", "@supabase/supabase-js", "firebase", "firebase-admin", "mysql2", "mongoose", "sequelize", "typeorm"];

function inspectCmd(project: string | undefined) {
  if (!project || !statSync(project, { throwIfNoEntry: false })?.isDirectory()) fail("project not found");
  const d = spawnSync("docker", ["version"], { stdio: "ignore" });
  const docker = d.status === 0
    ? { available: true, reason: null }
    : { available: false, reason: d.error ? "the docker command was not found" : "the Docker daemon is not running or not reachable" };
  let plan: ReturnType<typeof detectApp> | undefined;
  let unsupported: string | null = null;
  let run: RunJson = {};
  let runError: string | null = null;
  const runText = readRegular(join(project, ".vibe-breakpoint", "run.json"));
  if (runText !== undefined) { try { run = parseRunJson(runText); } catch (e) { runError = e instanceof Error ? e.message : "run.json is not valid"; } }
  let canFix = false;
  try { plan = detectApp(project, run); } catch (e) { unsupported = e instanceof Unsupported ? e.message : "package.json could not be parsed"; canFix = e instanceof Unsupported && e.runJsonCanFix; }
  let dbDeps: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    const all = { ...pkg.devDependencies, ...pkg.dependencies };
    dbDeps = DB_DEPS.filter((n) => n in all).sort();
  } catch { /* unreadable: no db deps */ }
  const images = plan ? [...new Set([...requiredImages(project, plan.dockerfile === "project"), "grafana/k6"])] : [];
  const isFile = (f: string) => lstatSync(join(project, ".vibe-breakpoint", f), { throwIfNoEntry: false })?.isFile() ?? false;
  const info = {
    schema: 1,
    tool_version: manifest.version,
    docker,
    supported: Boolean(plan),
    unsupported_reason: unsupported,
    framework: plan?.framework ?? null,
    dockerfile: plan?.dockerfile ?? null,
    migrations: plan?.migrations.kind ?? null,
    db_deps: dbDeps,
    env_names: envNames(project),
    images,
    missing_images: docker.available && plan ? missingImages(images) : null,
    has_scenario: isFile("scenario.json"),
    has_seed: isFile("seed.json"),
    build: plan && plan.dockerfile === "template" && plan.buildCmd !== "true" ? plan.buildCmd : null,
    start: plan?.start?.join(" ") ?? null,
    start_source: plan?.startSource ?? null,
    has_run: isFile("run.json"),
    ...(runError && { run_json_error: runError }),
    ...(canFix && { run_json_can_fix: true }),
  };
  const text = JSON.stringify(info, null, 2);
  try { safeWriteOut(project, "inspect.json", text); } catch (e) { fail(e instanceof Error ? e.message : "could not write inspect.json"); }
  console.log(text);
}

async function renderCmd(project: string | undefined) {
  if (!project || !statSync(project, { throwIfNoEntry: false })?.isDirectory()) fail("project not found");
  const base = join(project, ".vibe-breakpoint");
  const resFile = join(base, "out", "result.json");
  const st = lstatSync(resFile, { throwIfNoEntry: false });
  if (!st) fail('no out/result.json; run "vibe-breakpoint run <project>" first');
  if (!st.isFile()) fail("result.json is not a regular file");
  let result: Result;
  try { result = JSON.parse(readFileSync(resFile, "utf8")); } catch { fail("result.json is not valid JSON"); }
  const bad = resultError(result);
  if (bad) fail(`result.json: ${bad}`);
  let mockLog: MockCall[] | undefined;
  try {
    const m = JSON.parse(readRegular(join(base, "out", "mock-log.json")) ?? "");
    if (Array.isArray(m.calls) && m.calls.every((c: MockCall) => typeof c?.service === "string" && typeof c.method === "string" && typeof c.path === "string" && Number.isFinite(c.count))) mockLog = m.calls;
  } catch { /* absent or invalid */ }
  let seedSizes: Seed["sizes"] | undefined;
  try { seedSizes = parseSeed(readRegular(join(base, "seed.json")) ?? "").sizes; } catch { /* absent or invalid */ }
  const name = projectLabel(realpathSync(project));
  const svg = chartSvg(result, name);
  safeWriteOut(project, "out/chart.svg", svg);
  safeWriteOut(project, "out/report.md", reportMd({ result, project: name, mockLog, seedSizes, codeLocations: readRegular(join(base, "code-locations.md")) }));
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
  console.log(manifest.version);
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
