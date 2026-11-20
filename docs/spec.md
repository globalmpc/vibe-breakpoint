# vibe-breakpoint — Spec (contracts)

Contracts between modules. If one proves wrong, record a decision and update this file in the same phase.

## 1. Flow & CLI

```
Claude (skill): routes + main flow + schema ──► scenario.json, seed.json
script: copy project ──► sandbox (compose: app, db, mock, k6) ──► boot + migrate
script: seed S/M/L ──► query probe ──► load ramp ──► result.json
script: render ──► chart.svg/.png, report.md        Claude: explains in plain language
script: teardown (always)
```

CLI (bundle: `${CLAUDE_PLUGIN_ROOT}/scripts/vibe-breakpoint.mjs`):

```
vibe-breakpoint inspect  <project>              # env names, framework, DB/ORM, Docker availability → .vibe-breakpoint/inspect.json (D-048)
vibe-breakpoint run      <project> [--profile small] [--pull] [--sizes S,M,L] [--stages 10,25,50,100,200,400] [--stage-duration 60] [--keep-on-fail]
vibe-breakpoint render   <project>
vibe-breakpoint cleanup  [--all]                # remove labelled resources + temp folders (without --all: only runs whose owner pid is dead)
vibe-breakpoint --version
```

**`inspect <project>` (Phase 7).** Writes `<project>/.vibe-breakpoint/inspect.json` via `safeWriteOut` and prints the same JSON. Keys: `schema, tool_version, docker{available,reason}, supported, unsupported_reason, framework, dockerfile, migrations, db_deps, env_names, images, missing_images, has_scenario, has_seed`. Docker missing or an unsupported project is data (exit 0); exit 1 only for `project not found` or a refused write. See D-048.

**`render <project>` (Phase 6).** Reads `<project>/.vibe-breakpoint/out/result.json` (regular file only, never a symlink; errors never echo file content, D-047), plus optional `out/mock-log.json`, `seed.json` (sizes only) and `code-locations.md`. Writes `out/chart.svg`, `out/chart.png`, `out/report.md` via `safeWriteOut`. A PNG failure prints `PNG skipped: <reason>` and still exits 0. Missing/invalid input exits 1 with a fixed message.

Phase 2 `run`: checks, copy, `detectApp` (unsupported: exit 2, `vibe-breakpoint: unsupported because <reason>`), test.env, compose.json, announce build source and images, ensure images local (`--pull` pulls missing ones; otherwise exit 1 with the list), `compose build app`, `up --wait db mock`, migrations, `up --wait app`, then `vibe-breakpoint: sandbox ready <runId>`. `finally`/signal: save `out/mock-log.json`, then `down`. Exit codes: 0 ok, 1 run failed, 2 unsupported project (signals 130/143/129). Failure output is the last 30 lines, passed through `redact()` (D-025).

Phase 3 `run`: `--sizes` (default `S,M,L`; an unknown size exits 1 with `unknown size: X` before Docker). If `<project>/.vibe-breakpoint/seed.json` exists (read from the real project, not the copy) it is validated before Docker; otherwise `vibe-breakpoint: no seed.json; skipping seeding`. After migrations and before `up app`, each size is seeded in order (one transaction: TRUNCATE ... RESTART IDENTITY CASCADE, INSERT ... SELECT from `generate_series`, ANALYZE) and printed as `vibe-breakpoint: seeded <size> in <ms> ms [{"table","rows","checksum"}]`. The DB keeps the last size. See D-028.

Phase 4 `run`: `--stages` and `--stage-duration` are validated before Docker (`invalid --stages: X`, `invalid --stage-duration: X`, exit 1), as is `scenario.json` (`vibe-breakpoint: scenario.json: <reason>`, exit 1). Without `scenario.json`: `vibe-breakpoint: no scenario.json; skipping load test`. With it, `grafana/k6` is added to the images (needs `--pull` if missing). After `sandbox ready` (and never with `--hold`) the ramp runs on size `M` (reseeded if needed), one k6 container per stage, printing `vibe-breakpoint: stage <u> users: p50 .. ms, p95 .. ms, errors .. %, app cpu .., db cpu .., app mem .. MB`, stops after the first broken stage, writes `out/result.json` and `out/k6/<users>.json`, and prints the breaking point. See D-033..D-036.

Hidden `--hold` keeps it up until SIGINT/SIGTERM/SIGHUP (exit 130/143/129). See D-018, D-019.

`run` reads `<project>/.vibe-breakpoint/scenario.json` and `seed.json` (written by the skill). All outputs go to `<project>/.vibe-breakpoint/out/`. Nothing else in the project is written.

## 2. Run identity

- Run id: `vb-<yyyymmddhhmmss>-<4 random hex>`.
- Compose project name = run id. Label on every resource: `vibe-breakpoint.run=<run id>`, plus `vibe-breakpoint=1`.
- Temp folder: `$TMPDIR/vibe-breakpoint-<run id>/`.

## 3. Sandbox copy & test env

**Copy excludes** (matched by basename at any depth, never the root; D-020): `.git/`, `node_modules/`, `.next/`, `dist/`, `build/`, `.turbo/`, `.vercel/`, `coverage/`, `.vibe-breakpoint/`, `.npmrc` (may hold registry tokens; D-056), and every `.env*` except `.env.example` / `.env.sample` / `.env.template`. Symlinks that resolve to `.npmrc` or a real env file are dropped too.

**Env names** (`src/sandbox/env-names.ts`, the only module allowed to touch real env files):
1. `.env.example` / `.sample` / `.template` names.
2. Code references: `process.env.X`, `process.env["X"]`, `import.meta.env.X`, `os.environ["X"]`, `os.getenv("X")`.
3. Config files: env keys in `docker-compose*.yml`, `vercel.json`, `netlify.toml`.
4. Real `.env*`: parse in-process, keep names, discard values. Never logged, returned or written.

**`test.env` values:**
- DB names (`DATABASE_URL`, `POSTGRES_URL`, …) → test DB URL.
- Known service keys → fake key in the service's format; base-URL names (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, …) → mock URL.
- Secrets (`*_SECRET`, `JWT_*`, `NEXTAUTH_SECRET`, …) → random 32-byte hex.
- Everything else → `vibe-breakpoint-placeholder`.
- Fixed values and exact rules (`NODE_ENV`, `PORT`, `PG*`, `NEXTAUTH_URL`, `/v1` for OpenAI, always-set names): D-016.
- If an SDK has no base-URL setting, the skill patches the client in the **copy** to use the mock, and lists the patch in the report. **Deferred in v0.1 (D-052):** such calls fail on the offline network and are named under limits.

## 4. Compose

Services (all labelled, network `vb-net` with `internal: true`):

| Service | Image / build | Notes |
|---|---|---|
| `db` | `postgres:16` | `tmpfs` data dir; `shared_preload_libraries=pg_stat_statements`; `pg_stat_statements.track=all`; generated password |
| `mock` | node image + `templates/mock/` | §6 |
| `app` | built from the copy, image `vb-app:<runId>` (labelled) | `test.env`; production start; healthcheck |
| `k6` | `grafana/k6` | runs scenario; started per stage |

- Compose file is `compose.json` in the run folder; `k6` is under profile `load`; `up` uses `--pull never --no-build` (the app image is built first with `compose build app`, D-021); node services use `init: true`; mock listens on 4010 (D-017).
- No host port mappings except an optional loopback one for debugging.
- Images are built/pulled with network access **before** the run; at runtime only `vb-net` is attached.
- **Profiles:** `small` (default) = app 1 CPU / 1 GB, db 1 CPU / 1 GB (≈ a 2 vCPU / 2 GB VPS). `tiny` = app 0.5 CPU / 512 MB, db 0.5 CPU / 512 MB. Profile is printed on the chart and report.

## 5. App boot

- Dockerfile: the copy's own root `Dockerfile` if present, unchanged; else the one template `templates/dockerfiles/node.Dockerfile` (single stage, keeps devDependencies; D-022). No `nextjs.Dockerfile`.
- Build: `npm run build` if a build script exists, else `next build` for Next.js, else none. Start: `npm run start` unless dev-like, else `next start` / `node <main|entry>`. Never `dev` (D-023). Unsupported projects are reported with a reason, never guessed.
- Health: compose healthcheck (`node -e fetch`, status < 500) on the first `scenario.json` flow path (or `/`), `--wait-timeout 120` (D-025). It probes only during boot: `start_interval` 1s within `start_period` 120s, then `interval` 24h (D-041).
- Migrations (D-024), run after `db` is healthy and before `app` starts: Prisma (`migrate deploy`, or `db push --skip-generate` without a migrations folder), Drizzle (`drizzle-kit migrate` with a journal, else `push`), Knex (`migrate:latest`), raw SQL folder (`migrations/` or `db/migrations/`, filename order, piped into `db` via psql). ORM CLIs run in a one-off `app` container from the built image.
- Unsupported in v0.1 (reported, not guessed): apps whose DB access goes through Supabase/Firebase client APIs instead of a direct Postgres connection; non-Node backends.

## 6. Mock server

Minimal HTTP server (`templates/mock/`), JSON canned responses:
- OpenAI: `POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings`.
- Anthropic: `POST /v1/messages`.
- Stripe: common `POST /v1/*` creates → object with fake id.
- Resend: `POST /emails`.
- Anything else: `200 {}` and logged as `unknown`.
- Configurable fixed latency (default 0 ms) so outside-service time doesn't hide the app's own limits.
- Internal endpoints, never logged: `GET /__vb/health`, `GET /__vb/log` (`{schema:1, calls:[{service, method, path, count}]}`). Env: `MOCK_PORT` (4010), `MOCK_LATENCY_MS` (0).
- The CLI writes `<project>/.vibe-breakpoint/out/mock-log.json` (service, method, path without query, count; **no bodies**) before teardown, also on signal (D-026). No streaming responses in v0.1.

## 7. `seed.json`

```jsonc
{
  "schema": 1,
  "random_seed": 42,
  "main_table": "projects",
  "sizes": { "S": 1000, "M": 10000, "L": 100000 },
  "tables": [
    { "name": "users", "ratio": 0.1, "columns": {
        "email": { "gen": "email" },
        "password_hash": { "gen": "password_hash", "algo": "bcrypt", "plain": "vb-test-password" } } },
    { "name": "projects", "ratio": 1, "columns": {
        "owner_id": { "gen": "fk", "ref": "users.id" },
        "name": { "gen": "words", "count": 3 } } }
  ],
  "test_users": 50
}
```

`ratio` scales each table against the size of `main_table`: rows = max(1, round(size x ratio)). Tables are seeded in listed order; `fk.ref` must name a table listed earlier.

Generators (`gen`):

| gen | value |
|---|---|
| `email` | `user<i>@example.test` |
| `words` (`count` 1..10, default 3) | words from a built-in list |
| `fk` (`ref: "table.column"`) | deterministic pick from the ref table's sorted ids (any id type) |
| `password_hash` (`algo: "bcrypt"`, `plain` 1..72 bytes, `cost` 4..14 default 10) | one pgcrypto `crypt()` hash per size, deterministic salt from `random_seed`, shared by all rows |
| `auto` | type-based value (text `'<col> <i>'`, ints, numerics, booleans, timestamps/dates, uuid, json) |

Unlisted columns get their DB default or NULL (D-030; deviation from the earlier "type-based defaults"). Unlisted NOT NULL without default is a validation error naming the table and column; `auto` is the only way to get type-based values. Unsupported types (e.g. enums) are an error.

Test users (D-031): rows `1..test_users` of the table with the `password_hash` column, email `user<i>@example.test`, password `plain`. Optional.

Determinism (D-029): no `random()`; values come from an integer hash of the row index and `random_seed:table:column`. Checksum per table = `count(*)` plus `md5` of the sorted rows over the columns the seeder writes (defaulted columns like `created_at` excluded).

## 8. `scenario.json` and the breaking point

```jsonc
{
  "schema": 1,
  "flow": [
    { "name": "login", "method": "POST", "path": "/api/login", "body": { "email": "{{user.email}}", "password": "{{user.password}}" }, "save": { "cookie": true } },
    { "name": "dashboard", "method": "GET", "path": "/api/projects" },
    { "name": "search", "method": "GET", "path": "/api/users?email={{random.email}}" }
  ],
  "think_time_s": 1,
  "probe_endpoints": ["dashboard", "search"]
}
```

- **Placeholders** (in `path` and in string values of `body`): `{{user.email}}` (`user<i>@example.test`, `i` from the VU number, 1..`test_users`), `{{user.password}}` (the seed `plain`), `{{random.email}}` (random existing row of the email table at the ramp size). Anything else is an error. `path` must start with one `/` (no absolute URLs). Steps run in order, think time after each step; a step with `save.cookie` runs once per VU (cookies persist per VU); at least one step must not be a cookie step.
- **Ramp:** stages of 10, 25, 50, 100, 200, 400 virtual users, 60 s each (configurable), on size `M` data.
- **Breaking point:** first stage where **p95 > 2 s** or **error rate > 1 %**. Reported as "handles about <previous stage> users at the same time". If no stage breaks → "no breaking point up to 400".
- **Limiting resource:** app CPU, db CPU, memory, or "app code" (latency rises without a saturated resource), from container stats.
- Stop early after the breaking stage (no need to run higher stages).

## 9. Outputs

### 9.1 `result.json`
`schema` (1), `run_id`, `tool_version`, `profile`, `size` (`"S"|"M"|"L"|null`), `stage_duration_s`, `think_time_s`, `stages[] { users, p50_ms, p95_ms, error_rate, requests, app_cpu, db_cpu, app_mem_mb }` (ms rounded to 0.1; `error_rate` is a fraction; `app_cpu`/`db_cpu` are fractions of the profile CPU limit, 1.0 = saturated; `app_mem_mb` = max MiB; samples missing give `null`; zero requests give `p50_ms/p95_ms: null`, `error_rate: 1`), `breaking_point { users_ok, users_broke, reason: "p95"|"error_rate"|"p95_and_error_rate" }` or `null`, `limiting_resource` (`app_cpu|db_cpu|memory|app_code|null`), `probe { endpoint → size → { queries_per_req, db_ms_per_req, rows_per_req, top_queries[] } }` (endpoint key `"<METHOD> <path without query>"`, e.g. `GET /api/users`, with ` (<step name>)` appended on a collision; `top_queries[]` = up to 5 by total time, each `{ query, calls_per_req, mean_ms, rows_per_req }`, query text redacted and ≤ 500 chars), `flags[]`. `mocked_calls` is not stored in result.json: `render` derives it from `out/mock-log.json` (D-045). Query text is normalized (no literal values).

### 9.2 Flags
- `n_plus_one`: queries per request grow ≥ 3× from S to L for one endpoint.
- `missing_index`: a query's mean time grows ≥ 5× from S to L **and** `EXPLAIN` shows `Seq Scan` on a table with ≥ 10k rows filtered by a column.
- `unbounded_fetch`: rows returned per request grow roughly with table size.
Each flag: endpoint, evidence numbers per size, plain-language cause, suggested fix. Code location (file/line) added by the skill in the report only.

### 9.3 Chart (`chart.svg` / `chart.png`)
1080x1350 (4:5). Top to bottom: title `VIBE BREAKPOINT — <project>`; headline (`Handles ~<N> users` / `Broke at <N> users` / `Handles <N>+ users` / `Data-growth probe only`); line chart users vs p95 with the 2 s limit and the breaking stage marked; table of the worst probe endpoint at small/medium/large; profile line (`small server: 1 CPU / 1 GB app, 1 CPU / 1 GB db`); footer repo URL + `search "vibe-breakpoint" on GitHub`. Bundled Liberation Mono; deterministic. Only numbers, endpoint keys and flag kinds; never paths, line numbers, env names or values, run id or dates. Details: D-042..D-044.

### 9.4 `report.md`
Headings, in order: `# vibe-breakpoint report: <project>`, `## 1. Verdict`, `## 2. Breaking point`, `## 3. Data growth findings` (probe table, then per flag: cause, numbers, fix, fix prompt for Claude Code), `## 4. Code locations` (optional `.vibe-breakpoint/code-locations.md`, verbatim), `## 5. Test setup` (profile, data sizes from `seed.json`, scenario, what was mocked from `mock-log.json`, changes in the copy), `## 6. Limits`. Details: D-046.

## 10. Fixtures

- `fixtures/express-pg/`: Express + `pg` + raw SQL migrations. Endpoints: `/api/login`, `/api/projects` (N+1: one query per project for its owner), `/api/users?email=` (no index on email), `/api/feed` (`SELECT *` with no limit), `/api/summary` (calls OpenAI SDK). `.env.example` present; a `.env` with `FAKESECRET_` values.
- `fixtures/next-drizzle/`: Next.js API routes + Drizzle; same patterns in smaller form; **no** `.env.example` (names from code only).

## 11. `/vibe-breakpoint` skill (product)

1. Run `inspect`. If Docker is unavailable → static query report only (D-007), then stop. The static report is `.vibe-breakpoint/static-report.md` (D-049).
2. Read routes, auth and schema. Write `scenario.json` (main user flow + probe endpoints) and `seed.json`. Ask at most **one batch** of questions only for what code can't show (e.g. which flow matters most).
3. Tell the user what will happen (copy, containers, images to pull, rough duration) and get one consent.
4. Run `run` in the background (D-051). On failure, explain the cause in plain language; never retry against anything but the sandbox.
5. Read code for the flagged endpoints and add code locations and fixes in `.vibe-breakpoint/code-locations.md`, which `render` includes in the report.
6. Run `render`. Reply in under 8 lines: breaking point, top data-growth issue, where the files are.
7. `cleanup` is always safe to run and is mentioned if a run was interrupted.

Never open real `.env*` files. Never connect to a database or URL from the user's config.

## 12. README must contain

Chart image at the top · install (marketplace add + plugin install) · what it measures · **what it never touches** (project unchanged, throwaway DB, env names only, no outside calls, local only) · requirements (Docker) · how the breaking point is defined · server profiles · limits · cleanup · license · links to vibe-preflight and vibe-bill.
