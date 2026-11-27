import { mkdirSync, symlinkSync, readlinkSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeFile, PROFILES } from "../src/sandbox/compose.js";
import { psqlArgs } from "../src/sandbox/sandbox.js";
import { copyProject } from "../src/sandbox/copy.js";
import { envNames } from "../src/sandbox/env-names.js";
import { spawn } from "node:child_process";
import { cleanup, down, exitOf, migrateArgs, newRunId, runDir, RUN_DIR_RE } from "../src/sandbox/sandbox.js";
import { redact, testEnv } from "../src/sandbox/test-env.js";

const tmp = () => mkdtempSync(join(tmpdir(), "vbtest-"));
const put = (root: string, rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const walk = (d: string, base = d): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)]));

describe("copyProject (AC1)", () => {
  it("drops excluded dirs and real env files at any depth, keeps the rest", () => {
    const src = join(tmp(), "build"); // root named like an excluded dir
    const dirs = [".git", "node_modules", ".next", "dist", "build", ".turbo", ".vercel", "coverage", ".vibe-breakpoint"];
    for (const d of dirs) { put(src, `${d}/x.txt`, "x"); put(src, `pkg/a/${d}/x.txt`, "x"); }
    for (const f of [".env", ".env.local", "sub/.env.production"]) put(src, f, "K=V");
    for (const f of [".env.example", ".env.sample", ".env.template"]) put(src, f, "K=");
    put(src, "src/a.ts", "hello");
    const dest = join(tmp(), "out");
    copyProject(src, dest);
    expect(walk(dest).sort()).toEqual([".env.example", ".env.sample", ".env.template", "src/a.ts"]);
    expect(readFileSync(join(dest, "src/a.ts"), "utf8")).toBe("hello");
  });
});

describe("copyProject secret files (AC6)", () => {
  const bad = [".netrc", "_netrc", ".dev.vars", ".dev.vars.production", ".yarnrc.yml", ".yarnrc", ".pgpass", ".git-credentials", ".npmrc", "id_rsa", "id_ed25519", "key.pem", "server.key", "cert.p12", "a.pfx", "serviceAccountKey.json", "my-service-account.json", "config/credentials.json", "client_secret_1.json", "x-firebase-adminsdk-y.json"];
  const good = ["id_rsa.pub", ".env.example", "src/keys.ts", "src/credentials.ts", "package.json", "tsconfig.json", "public/key.svg"];
  it("drops secrets at root and in subfolders and symlinks to them, keeps the rest", () => {
    const src = tmp();
    for (const f of bad) { put(src, f, "s"); put(src, `sub/${f}`, "s"); }
    for (const f of good) put(src, f, "x");
    symlinkSync(".netrc", join(src, "link-to-netrc"));
    const dest = join(tmp(), "out");
    copyProject(src, dest);
    expect(walk(dest).sort()).toEqual([...good].sort());
    expect(existsSync(join(dest, "link-to-netrc"))).toBe(false);
  });
});

describe("node.Dockerfile lockfile install (AC3)", () => {
  it("has pnpm, yarn, npm ci, npm install in order", () => {
    const t = readFileSync("skills/vibe-breakpoint/templates/dockerfiles/node.Dockerfile", "utf8");
    const order = ["corepack enable pnpm && npm_config_dangerously_allow_all_builds=true pnpm_config_dangerously_allow_all_builds=true pnpm install --frozen-lockfile", "corepack enable yarn && yarn install --frozen-lockfile", "elif [ -f package-lock.json ]; then npm ci", "else npm install"].map((s) => t.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const s of ["COPY package*.json pnpm-lock.yaml* yarn.lock* ./", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "YARN_NODE_LINKER=node-modules"]) expect(t).toContain(s);
  });
});

describe("envNames (AC2)", () => {
  it.each([
    ["express-pg", "fixtures/express-pg"],
    ["next-drizzle", "fixtures/next-drizzle"],
  ])("matches expected.json for %s", (_n, dir) => {
    const exp = JSON.parse(readFileSync(join(dir, "expected/expected.json"), "utf8")).env_names;
    expect(envNames(dir)).toEqual(exp);
  });
  it("finds names in all code forms and config files", () => {
    const d = tmp();
    put(d, "a.ts", 'process.env.A1; process.env["A2"]; process.env[\'A3\']; process.env[`A4`]; import.meta.env.A5; import.meta.env.MODE; import.meta.env.DEV');
    put(d, "b.py", 'os.environ["B1"]; os.getenv("B2")');
    put(d, "docker-compose.yml", "services:\n  w:\n    image: x\n    environment:\n      - C1=1\n      - C2\n      C3: v\n    ports: ['${C4:-1}']\n  z:\n    other: D_NO\n");
    put(d, "vercel.json", JSON.stringify({ env: { V1: "x" }, build: { env: { V2: "y" } } }));
    put(d, "netlify.toml", "[build.environment]\nN1 = \"x\"\n[other]\nN_NO = 1\n");
    put(d, "node_modules/p/i.js", "process.env.SKIPPED");
    expect(envNames(d)).toEqual(["A1", "A2", "A3", "A4", "A5", "B1", "B2", "C1", "C2", "C3", "C4", "N1", "V1", "V2"]);
  });
  it("real .env yields names only", () => {
    const d = tmp();
    put(d, ".env", "SOME_KEY=FAKESECRET_unit\nexport OTHER=1\n");
    const r = envNames(d);
    expect(r).toEqual(["OTHER", "SOME_KEY"]);
    expect(JSON.stringify(r)).not.toContain("FAKESECRET_");
  });
});

describe("testEnv (AC3)", () => {
  const pw = "pw123";
  const db = `postgres://vb:${pw}@db:5432/vb`;
  const e = testEnv(
    ["HOST", "NEXTAUTH_URL", "PGPASSWORD", "PGHOST", "SUPABASE_DB_URL", "DIRECT_URL", "APP_URL", "MY_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "NEXTAUTH_SECRET", "JWT_FOO", "X_TOKEN", "DB_PASSWORD", "LOG_LEVEL"],
    pw,
  );
  it("applies the D-016 rows", () => {
    expect(e).toMatchObject({
      NODE_ENV: "production", PORT: "3000", HOST: "0.0.0.0", NEXTAUTH_URL: "http://app:3000",
      PGPASSWORD: pw, PGHOST: "db", DATABASE_URL: db, SUPABASE_DB_URL: db, DIRECT_URL: db,
      OPENAI_BASE_URL: "http://mock:4010/v1", ANTHROPIC_BASE_URL: "http://mock:4010", RESEND_BASE_URL: "http://mock:4010",
      MY_BASE_URL: "http://mock:4010", APP_URL: "http://mock:4010", LOG_LEVEL: "vibe-breakpoint-placeholder",
    });
    expect(e.OPENAI_API_KEY).toMatch(/^sk-vbfake[0-9a-f]{32}$/);
    expect(e.ANTHROPIC_API_KEY).toMatch(/^sk-ant-vbfake/);
    expect(e.STRIPE_SECRET_KEY).toMatch(/^sk_test_vbfake[0-9a-f]{24}$/);
    expect(e.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).toMatch(/^pk_test_vbfake/);
    expect(e.STRIPE_WEBHOOK_SECRET).toMatch(/^whsec_vbfake/);
    expect(e.RESEND_API_KEY).toMatch(/^re_vbfake/);
    for (const k of ["NEXTAUTH_SECRET", "JWT_FOO", "X_TOKEN", "DB_PASSWORD"]) expect(e[k]).toMatch(/^[0-9a-f]{64}$/);
  });
  it("always sets base names and values are compose-safe and random", () => {
    expect(Object.keys(testEnv([], pw)).sort()).toEqual(["ANTHROPIC_BASE_URL", "DATABASE_URL", "NODE_ENV", "OPENAI_BASE_URL", "PORT", "RESEND_BASE_URL"]);
    for (const v of Object.values(e)) expect(v).toMatch(/^[A-Za-z0-9_:/@.\-]+$/);
    expect(testEnv(["JWT_SECRET"], pw).JWT_SECRET).not.toBe(testEnv(["JWT_SECRET"], pw).JWT_SECRET);
  });
});

describe("composeFile (AC4)", () => {
  const c = (p: "small" | "tiny") => composeFile({ runId: "vb-1", profile: p, dbPassword: "x", envFile: "/e", mockDir: "/m", app: { context: "/c", dockerfile: "/t/node.Dockerfile", buildCmd: "npm run build", command: ["npm", "run", "start"], healthPath: "/" } }) as any;
  it("has isolated, labelled services", () => {
    const f = c("small");
    expect(f.networks["vb-net"].internal).toBe(true);
    const labels = { "vibe-breakpoint": "1", "vibe-breakpoint.run": "vb-1" };
    expect(f.networks["vb-net"].labels).toEqual(labels);
    for (const s of Object.values<any>(f.services)) {
      expect(s.labels).toEqual(labels);
      expect(s.networks).toEqual(["vb-net"]);
      expect(s.ports).toBeUndefined();
    }
    expect(f.services.db.tmpfs).toEqual(["/var/lib/postgresql/data"]);
    expect(f.services.db.command).toContain("shared_preload_libraries=pg_stat_statements");
    expect(f.services.db.command).toContain("pg_stat_statements.track=all");
    expect(f.services.k6.profiles).toEqual(["load"]);
  });
  it("uses profile limits", () => {
    for (const p of ["small", "tiny"] as const) {
      const f = c(p);
      for (const s of ["app", "db"]) {
        expect(f.services[s].cpus).toBe(PROFILES[p].cpus);
        expect(f.services[s].mem_limit).toBe(PROFILES[p].mem);
      }
    }
    expect(PROFILES.small).toEqual({ cpus: 1, mem: "1g" });
    expect(PROFILES.tiny).toEqual({ cpus: 0.5, mem: "512m" });
  });
});

describe("run ids and cleanup (AC6c/d)", () => {
  it("newRunId matches the dir regex", () => {
    expect(RUN_DIR_RE.test("vibe-breakpoint-" + newRunId())).toBe(true);
  });
  it("cleanup survives without Docker and ignores non-matching dirs", () => {
    const t = tmp();
    mkdirSync(join(t, "vibe-breakpoint-foo"));
    mkdirSync(join(t, "vibe-breakpoint-vb-20260101000000-abcd"));
    const old = { TMPDIR: process.env.TMPDIR, DOCKER_HOST: process.env.DOCKER_HOST };
    process.env.TMPDIR = t;
    process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
    try {
      const r = cleanup(false);
      expect(r.dockerAvailable).toBe(false);
      expect(r.runs).toEqual(["vb-20260101000000-abcd"]);
      expect(readdirSync(t)).toEqual(["vibe-breakpoint-foo"]);
    } finally {
      for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });
});

describe("untrusted run ids (R1-1)", () => {
  it("runDir rejects and down never removes a crafted id", () => {
    const victim = mkdtempSync(join(tmpdir(), "vb-victim-"));
    writeFileSync(join(victim, "keep"), "x");
    const crafted = `x/../${victim.slice(tmpdir().length + 1)}`;
    try {
      expect(() => runDir(crafted)).toThrow();
      expect(() => runDir("vb-20260101000000-zzzz")).toThrow();
      down(crafted);
      expect(readFileSync(join(victim, "keep"), "utf8")).toBe("x");
    } finally {
      rmSync(victim, { recursive: true, force: true });
    }
  });
});

describe("app service (AC6)", () => {
  const mk = (app: object) => (composeFile({ runId: "vb-1", profile: "small", dbPassword: "x", envFile: "/e", mockDir: "/m", app: { context: "/c", dockerfile: "/d", healthPath: "/", ...app } }) as any).services.app;
  it("builds a labelled image, runs on vb-net only", () => {
    const a = mk({ buildCmd: "npm run build", command: ["npm", "run", "start"] });
    expect(a.image).toBe("vb-app:vb-1");
    expect(a.build.context).toBe("/c");
    expect(a.build.labels).toEqual({ "vibe-breakpoint": "1", "vibe-breakpoint.run": "vb-1" });
    expect(a.build.args.BUILD_CMD).toBe("npm run build");
    expect(a.command).toEqual(["npm", "run", "start"]);
    expect(a.networks).toEqual(["vb-net"]);
    expect(a.ports).toBeUndefined();
  });
  it("project Dockerfile: no command, no args", () => {
    const a = mk({ dockerfile: "/c/Dockerfile" });
    expect(a.command).toBeUndefined();
    expect(a.build.args).toBeUndefined();
  });
  it("health path is JSON-escaped in the node -e script", () => {
    const script = mk({ healthPath: `/a'b"c` }).healthcheck.test[3];
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain(JSON.stringify(`/a'b"c`));
  });
  it("escapes $ so host env vars are not interpolated (N1)", () => {
    const a = mk({ command: ["node", "${AWS_SECRET_ACCESS_KEY}.js"], healthPath: "/${X}" });
    expect(a.command).toEqual(["node", "$${AWS_SECRET_ACCESS_KEY}.js"]);
    for (const s of [...a.command, a.healthcheck.test[3]]) expect(s.replaceAll("$$", "")).not.toContain("${");
  });
  it("healthcheck probes only during boot (D-041)", () => {
    const h = mk({}).healthcheck;
    expect(h).toMatchObject({ interval: "24h", start_period: "120s", start_interval: "1s", timeout: "5s" });
    expect(h).not.toHaveProperty("retries");
    expect(h.test.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
  });
  it("migration runs with --entrypoint, rest after the service (N3)", () => {
    expect(migrateArgs(["node_modules/.bin/prisma", "migrate", "deploy"])).toEqual(["run", "--rm", "--no-deps", "-T", "--entrypoint", "node_modules/.bin/prisma", "app", "migrate", "deploy"]);
  });
  it("a spawn failure rejects with a clear error instead of an unhandled event (N5)", async () => {
    await expect(exitOf(spawn("/nonexistent/docker-vb", []))).rejects.toThrow(/could not run docker: ENOENT/);
  });
});

describe("redact (AC7)", () => {
  it("replaces long values only, longest first", () => {
    const t = redact("u=postgres://vb:abcd1234ef@db x=prod p=3000", { DATABASE_URL: "postgres://vb:abcd1234ef@db:5432/vb", PGPASSWORD: "abcd1234ef", PORT: "3000" });
    expect(t).not.toContain("abcd1234ef");
    expect(t).toContain("3000");
  });
});

describe("copyProject symlinks (AC8)", () => {
  it("keeps only safe relative links", () => {
    const outside = tmp();
    put(outside, "outside.txt", "o");
    const src = tmp();
    put(src, "sub/file", "f");
    put(src, ".env", "K=V");
    put(src, ".env.local", "K=V");
    symlinkSync("sub/file", join(src, "a"));
    symlinkSync(join(src, "sub/file"), join(src, "abs"));
    symlinkSync(join(outside, "outside.txt"), join(src, "out-abs"));
    symlinkSync("../" + join(outside, "outside.txt").split("/").slice(-2).join("/"), join(src, "out-rel"));
    symlinkSync(".env.local", join(src, "cfg"));
    symlinkSync("y", join(src, "x"));
    symlinkSync(".env", join(src, "y"));
    symlinkSync("nope", join(src, "dangling"));
    const dest = join(tmp(), "out");
    copyProject(src, dest);
    const has = (n: string) => { try { lstatSync(join(dest, n)); return true; } catch { return false; } };
    expect(readlinkSync(join(dest, "a"))).toBe("sub/file");
    for (const n of ["abs", "out-abs", "out-rel", "cfg", "x", "y", "dangling", ".env", ".env.local"]) expect(has(n)).toBe(false);
  });
  it("copies when the root path is itself a symlink", () => {
    const real = tmp();
    put(real, "a.txt", "a");
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    const dest = join(tmp(), "out");
    copyProject(link, dest);
    expect(existsSync(join(dest, "a.txt"))).toBe(true);
  });
});

describe("pr1 round 3 (B3, B5)", () => {
  it("drops .npmrc at any depth and symlinks to one, keeps .env.example", () => {
    const src = tmp();
    put(src, ".npmrc", "//registry:_authToken=x");
    put(src, "sub/.npmrc", "x");
    put(src, ".env.example", "K=");
    put(src, "a.ts", "a");
    symlinkSync(".npmrc", join(src, "link-rc"));
    const dest = join(tmp(), "out");
    copyProject(src, dest);
    expect(walk(dest).sort()).toEqual([".env.example", "a.ts"]);
    expect(existsSync(join(dest, "link-rc"))).toBe(false);
  });
  it("psql is transactional (-1) by default, not for probe control queries", () => {
    expect(psqlArgs()).toContain("-1");
    expect(psqlArgs(false)).not.toContain("-1");
  });
});
