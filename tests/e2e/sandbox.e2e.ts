import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, lstatSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isRealEnvFile } from "../../src/sandbox/copy.js";
import { RUN_DIR_RE, runDir } from "../../src/sandbox/sandbox.js";

const bundle = resolve("skills/vibe-breakpoint/scripts/vibe-breakpoint.mjs");
const FIXTURES = ["express-pg", "next-drizzle"].map((n) => resolve("fixtures", n));
const tmpProjects: Record<string, string> = {}; // name -> temp copy (fixtures are never mutated)
const copyFixture = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), "vbe2e-"));
  cpSync(resolve("fixtures", name), d, { recursive: true });
  return d;
};
const dk = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8" });
const ids = (...a: string[]) => (dk(...a).stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean).sort();

// Tree hash. Real env files: stat only, never read (rule 3).
function treeHash(root: string): string {
  const rows: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && e.name === ".vibe-breakpoint") continue;
      const st = lstatSync(p);
      const rel = p.slice(root.length);
      if (e.isDirectory()) { rows.push(`${rel} d ${st.mtimeMs}`); walk(p); }
      else {
        const content = isRealEnvFile(e.name) ? "-" : createHash("sha256").update(readFileSync(p)).digest("hex");
        rows.push(`${rel} f ${st.size} ${st.mtimeMs} ${content}`);
      }
    }
  };
  walk(root);
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

const labelled = () => ({
  containers: ids("ps", "-aq", "--filter", "label=vibe-breakpoint=1"),
  networks: ids("network", "ls", "-q", "--filter", "label=vibe-breakpoint=1"),
  volumesLabelled: ids("volume", "ls", "-q", "--filter", "label=vibe-breakpoint=1"),
  volumes: ids("volume", "ls", "-q"),
  images: ids("image", "ls", "vb-app", "--format", "{{.Tag}}"),
  dirs: readdirSync(tmpdir()).filter((n) => RUN_DIR_RE.test(n)).sort(),
});
const runResources = (id: string) => [
  ...ids("ps", "-aq", "--filter", `label=vibe-breakpoint.run=${id}`),
  ...ids("network", "ls", "-q", "--filter", `label=vibe-breakpoint.run=${id}`),
  ...ids("volume", "ls", "-q", "--filter", `label=vibe-breakpoint.run=${id}`),
  ...ids("image", "ls", `vb-app:${id}`, "-q"),
];

let before: ReturnType<typeof labelled>;
const treeBefore: Record<string, string> = {};
let output = ""; // all CLI stdout/stderr
const scans: string[] = []; // text scanned while runs were live

type Held = { child: ChildProcess; id: string; exit: Promise<number | null> };
function hold(project: string, ...extra: string[]): Promise<Held> {
  const child = spawn("node", [bundle, "run", project, "--hold", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return new Promise((res, rej) => {
    let buf = "";
    const on = (d: Buffer) => {
      buf += d;
      output += d;
      const m = /sandbox ready (vb-\d{14}-[0-9a-f]{4})/.exec(buf);
      if (m) res({ child, id: m[1], exit });
    };
    child.stdout!.on("data", on);
    child.stderr!.on("data", on);
    exit.then((c) => rej(new Error(`exited ${c} before ready: ${buf}`)));
  });
}
const svc = (id: string, s: string) => ids("ps", "-q", "--filter", `label=vibe-breakpoint.run=${id}`, "--filter", `label=com.docker.compose.service=${s}`)[0];
// run a command inside the mock container (it has busybox wget)
const fromMock = (id: string, ...args: string[]) => dk("exec", svc(id, "mock"), "wget", "-qO-", ...args).stdout;
const withTimeout = <T>(p: Promise<T>, ms = 60_000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

function scanRun(id: string, app: string) {
  const d = runDir(id);
  const files = (x: string): string[] => readdirSync(x, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(x, e.name)) : [join(x, e.name)]));
  for (const f of files(d)) {
    expect(f.split("/").pop()!.startsWith(".env") && isRealEnvFile(f.split("/").pop()!)).toBe(false);
    scans.push(readFileSync(f, "utf8"));
  }
  scans.push(dk("inspect", app).stdout);
}

const probe = `
const net=require("net"),http=require("http");
const c=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:p});s.setTimeout(5000);s.on("connect",()=>{s.destroy();r(true)});s.on("error",()=>r(false));s.on("timeout",()=>{s.destroy();r(false)})});
(async()=>{
 const out={ext1:await c("1.1.1.1",443),ext2:await c("example.com",443),db:await c("db",5432)};
 out.mock=await new Promise(r=>http.get("http://mock:4010/",x=>{x.resume();r(x.statusCode)}).on("error",()=>r(0)));
 console.log(JSON.stringify(out));
})();`;

beforeAll(() => {
  if (dk("info").status !== 0) throw new Error("Docker is not available (docker info failed)");
  for (const img of ["postgres:16", "node:22-alpine"]) {
    if (dk("image", "inspect", img).status !== 0) throw new Error(`image ${img} missing locally; e2e never pulls. Run: docker pull ${img}`);
  }
  for (const f of FIXTURES) treeBefore[f] = treeHash(f);
  for (const n of ["express-pg", "next-drizzle"]) { tmpProjects[n] = copyFixture(n); treeBefore[tmpProjects[n]] = treeHash(tmpProjects[n]); }
  before = labelled();
});

describe.each([
  ["express-pg", "SIGINT", 130],
  ["next-drizzle", "SIGTERM", 143],
] as const)("sandbox %s", (name, sig, code) => {
  it("boots healthy, isolated, migrated; tears down on signal", async () => {
    const project = tmpProjects[name];
    const h = await hold(project);
    const app = svc(h.id, "app");
    const db = svc(h.id, "db");
    expect(app && db && svc(h.id, "mock")).toBeTruthy();

    // (a) internal network, app attached only to it
    const nets = ids("network", "ls", "-q", "--filter", `label=vibe-breakpoint.run=${h.id}`);
    expect(nets).toHaveLength(1);
    expect(JSON.parse(dk("network", "inspect", nets[0]).stdout)[0].Internal).toBe(true);
    const attached = Object.keys(JSON.parse(dk("inspect", app).stdout)[0].NetworkSettings.Networks);
    expect(attached).toHaveLength(1);

    // (b) egress blocked, db and mock reachable
    const r = JSON.parse(dk("exec", app, "node", "-e", probe).stdout);
    expect(r).toEqual({ ext1: false, ext2: false, db: true, mock: 200 });

    // (c) pg_stat_statements preloaded
    expect(dk("exec", db, "psql", "-U", "vb", "-d", "vb", "-tAc", "SHOW shared_preload_libraries").stdout).toContain("pg_stat_statements");

    // (d) test.env names include the fixture's expected names
    const expected: string[] = JSON.parse(readFileSync(join(project, "expected/expected.json"), "utf8")).env_names;
    const names = readFileSync(join(runDir(h.id), "test.env"), "utf8").split("\n").map((l) => l.split("=")[0]);
    for (const n of expected) expect(names).toContain(n);

    // (e) migrations applied: the app reads its tables
    expect(Array.isArray(JSON.parse(fromMock(h.id, "http://app:3000/api/projects")))).toBe(true);

    // (f) outside call hits the mock, which logs it without bodies
    if (name === "express-pg") {
      const r = JSON.parse(fromMock(h.id, "--header=Content-Type: application/json", `--post-data={"text":"vb-body-marker"}`, "http://app:3000/api/summary"));
      expect(r.summary).toBe("vibe-breakpoint mock response");
    }

    scanRun(h.id, app);

    h.child.kill(sig);
    expect(await withTimeout(h.exit)).toBe(code);
    if (name === "express-pg") {
      const raw = readFileSync(join(project, ".vibe-breakpoint/out/mock-log.json"), "utf8");
      scans.push(raw);
      expect(JSON.parse(raw).calls).toContainEqual({ service: "openai", method: "POST", path: "/v1/chat/completions", count: 1 });
      expect(raw).not.toContain("vb-body-marker");
    }
    expect(runResources(h.id)).toEqual([]);
    expect(existsSync(runDir(h.id))).toBe(false);
  });
});

describe("run without --hold and cleanup", () => {
  it("run next-drizzle exits 0 and leaves nothing", async () => {
    const child = spawn("node", [bundle, "run", tmpProjects["next-drizzle"]], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout!.on("data", (d) => (buf += d));
    child.stderr!.on("data", (d) => (buf += d));
    const c = await withTimeout(new Promise<number | null>((r) => child.on("exit", r)), 600_000);
    output += buf;
    expect(c).toBe(0);
    const m = /sandbox ready (vb-\d{14}-[0-9a-f]{4})/.exec(buf);
    expect(m).toBeTruthy();
    expect(runResources(m![1])).toEqual([]);
    expect(existsSync(runDir(m![1]))).toBe(false);
  });

  it("cleanup spares a live run; removes a SIGKILLed one", async () => {
    const live = await hold(tmpProjects["express-pg"]);
    const dead = await hold(tmpProjects["express-pg"]);
    dead.child.kill("SIGKILL");
    await dead.exit;
    expect(runResources(dead.id).length).toBeGreaterThan(0);
    expect(existsSync(runDir(dead.id))).toBe(true);

    const r = spawnSync("node", [bundle, "cleanup"], { encoding: "utf8" });
    output += r.stdout + r.stderr;
    expect(r.status).toBe(0);
    expect(runResources(dead.id)).toEqual([]);
    expect(existsSync(runDir(dead.id))).toBe(false);
    // live run untouched
    expect(dk("inspect", "-f", "{{.State.Running}}", svc(live.id, "app")).stdout.trim()).toBe("true");

    live.child.kill("SIGINT");
    await withTimeout(live.exit);
    expect(runResources(live.id)).toEqual([]);
  });
});

const runCli = async (project: string, ...extra: string[]): Promise<{ code: number | null; text: string }> => {
  const child = spawn("node", [bundle, "run", project, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout!.on("data", (d) => (text += d));
  child.stderr!.on("data", (d) => (text += d));
  const code = await withTimeout(new Promise<number | null>((r) => child.on("exit", r)), 600_000);
  output += text;
  return { code, text };
};

describe("failure paths", () => {
  it("broken boot: exit 1, redacted, nothing left", async () => {
    const p = copyFixture("express-pg");
    writeFileSync(join(p, "src/server.js"), 'console.log("vb-broken-boot", process.env.DATABASE_URL); process.exit(1);\n');
    const { code, text } = await runCli(p);
    expect(code).toBe(1);
    expect(text).toContain("app did not become healthy");
    expect(text).toContain("vb-broken-boot");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("postgres://vb:");
    expect(text).not.toContain("sandbox ready");
    expect(labelled().images).toEqual(before.images);
  });
  it("unsupported project: exit 2, no docker resources", async () => {
    const p = mkdtempSync(join(tmpdir(), "vbe2e-"));
    writeFileSync(join(p, "go.mod"), "module x\n");
    const { code, text } = await runCli(p);
    expect(code).toBe(2);
    expect(text).toContain("vibe-breakpoint: unsupported because");
    expect(labelled()).toEqual(before);
  });
});

const withSeed = (name: string): string => {
  const p = copyFixture(name);
  mkdirSync(join(p, ".vibe-breakpoint"), { recursive: true });
  writeFileSync(join(p, ".vibe-breakpoint/seed.json"), readFileSync(resolve("fixtures", name, "expected/seed.json")));
  treeBefore[p] = treeHash(p);
  return p;
};
const seededLines = (text: string) => Object.fromEntries([...text.matchAll(/seeded ([SML]) in (\d+) ms (\[.*\])/g)].map((m) => [m[1], { ms: Number(m[2]), json: m[3] }]));

describe("seeding", () => {
  it.each([["express-pg"], ["next-drizzle"]])("%s: deterministic S and L, twice", async (name) => {
    const p = withSeed(name);
    const a = await runCli(p, "--sizes", "S,L");
    const b = await runCli(p, "--sizes", "S,L");
    expect([a.code, b.code]).toEqual([0, 0]);
    const la = seededLines(a.text), lb = seededLines(b.text);
    expect(Object.keys(la)).toEqual(["S", "L"]);
    for (const k of ["S", "L"]) expect(la[k].json).toBe(lb[k].json);
    const rows = (k: string) => JSON.parse(la[k].json).map((t: { table: string; rows: number; checksum: string }) => { expect(t.checksum).toMatch(/^[0-9a-f]{32}$/); return `${t.table}:${t.rows}`; });
    expect(rows("S")).toEqual(["users:100", "projects:1000"]);
    expect(rows("L")).toEqual(["users:10000", "projects:100000"]);
    console.log(`seed L ${name}: ${la.L.ms} ms`);
    expect(la.L.ms).toBeLessThan(120_000);
  });

  it("express-pg: FK, bcrypt, test users, app sees data", async () => {
    const h = await hold(withSeed("express-pg"), "--sizes", "S");
    const q = (sql: string) => dk("exec", svc(h.id, "db"), "psql", "-U", "vb", "-d", "vb", "-tAc", sql).stdout.trim();
    expect(q("SELECT count(*) FROM projects p LEFT JOIN users u ON u.id = p.owner_id WHERE u.id IS NULL")).toBe("0");
    expect(q("SELECT bool_and(crypt('vb-test-password', password_hash) = password_hash) FROM users WHERE id <= 50")).toBe("t");
    expect(q("SELECT email FROM users WHERE id = 1")).toBe("user1@example.test");
    expect(q("SELECT count(*) FROM users WHERE password_hash NOT LIKE '$2a$10$%'")).toBe("0");
    const list = JSON.parse(fromMock(h.id, "http://app:3000/api/projects"));
    expect(Array.isArray(list) && list.length > 0).toBe(true);
    h.child.kill("SIGINT");
    await withTimeout(h.exit);
    expect(runResources(h.id)).toEqual([]);
  });

  it("seed.json missing a NOT NULL column: exit 1, nothing left", async () => {
    const p = withSeed("express-pg");
    const f = join(p, ".vibe-breakpoint/seed.json");
    const s = JSON.parse(readFileSync(f, "utf8"));
    delete s.tables[0].columns.password_hash;
    delete s.test_users;
    writeFileSync(f, JSON.stringify(s));
    const { code, text } = await runCli(p);
    expect(code).toBe(1);
    expect(text).toContain("password_hash");
    expect(text).not.toContain("sandbox ready");
    expect(labelled().containers).toEqual(before.containers);
    expect(labelled().dirs).toEqual(before.dirs);
  });

  it("no seed.json: skip line; unknown size: exit 1 before docker", async () => {
    const a = await runCli(copyFixture("next-drizzle"));
    expect(a.code).toBe(0);
    expect(a.text).toContain("vibe-breakpoint: no seed.json; skipping seeding");
    const b = await runCli(copyFixture("next-drizzle"), "--sizes", "X");
    expect(b.code).toBe(1);
    expect(b.text).toContain("unknown size: X");
    expect(labelled().dirs).toEqual(before.dirs);
  });
});

describe("global checks", () => {
  it("project untouched", () => {
    for (const f of Object.keys(treeBefore)) expect(treeHash(f)).toBe(treeBefore[f]);
  });
  it("no secrets leaked", () => {
    const hay = [...scans, output, readFileSync(bundle, "utf8")];
    expect(scans.length).toBeGreaterThan(0);
    for (const t of hay) expect(t).not.toContain("FAKESECRET_");
  });
  it("cleanup: nothing left behind", () => {
    const after = labelled();
    for (const k of Object.keys(after) as (keyof typeof after)[]) {
      expect(after[k].filter((x) => !before[k].includes(x))).toEqual([]);
    }
  });
});
