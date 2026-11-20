# vibe-breakpoint — Development Plan

Phases run in order with `/phase`. No dates: a phase ends when its acceptance checks pass. Contracts: `docs/spec.md`. Decisions: `docs/decisions.md`.

---

## Phase 0 — Scaffold & plugin layout

**Goal:** a working TypeScript project inside the marketplace/plugin layout, installable as a plugin.

- [x] `git init`, `package.json` (dev only), `tsconfig.json` (strict, ESM), vitest, esbuild build into `plugins/vibe-breakpoint/scripts/`.
- [x] Keep the layout from `CLAUDE.md`. Check the current Claude Code docs for marketplace/plugin manifests; fix the two manifests if anything changed; record the local install commands as a decision.
- [x] Test: `plugin.json` version equals the marketplace entry version; both manifests parse; no component folders inside `.claude-plugin/`.
- [x] CLI skeleton (spec §1) with `--version` and `cleanup`.
- [x] Two fixture apps (spec §10) with `expected/` folders for later phases; fake secrets use the `FAKESECRET_` marker.

**Acceptance**
- `npm test`, `npm run typecheck`, `npm run build` pass.
- `node plugins/vibe-breakpoint/scripts/vibe-breakpoint.mjs --version` prints the version.
- The plugin installs locally from this repo's marketplace and `/vibe-breakpoint` appears (placeholder skill).

---

## Phase 1 — Sandbox

**Goal:** an isolated copy of the project and an empty, labelled test environment that always cleans up.

- [x] Copy the project to a temp folder (prefix `vibe-breakpoint-`), excluding spec §3 paths.
- [x] `env-names.ts`: env names from `.env.example`, code references and config files; real `.env*` parsed in-process for names only.
- [x] Generate `test.env` with fake values for every name (spec §3), plus DB URL to the test database and mock base URLs.
- [x] Generate the compose file (spec §4): `app`, `db` (Postgres on tmpfs, `pg_stat_statements`), `mock`, `k6`; `internal` network; resource limits from the profile; run labels.
- [x] Up/down with signal traps; `cleanup` command removes labelled resources and temp folders.
- [x] `npm run test:e2e` harness with the three global checks (project untouched, secrets, cleanup).

**Acceptance**
- E2E: environment comes up and down for both fixtures (app container can be a placeholder here).
- From inside the `app` container, the internet is unreachable; `db` and `mock` are reachable.
- Kill the run mid-way (SIGINT) → nothing left after; and `cleanup` removes leftovers from a `kill -9` run.
- Project-untouched and secret checks pass.

---

## Phase 2 — App boot

**Goal:** the fixture apps run as production builds inside the sandbox, with migrations applied and outside services mocked.

- [x] Reuse the project's Dockerfile from the copy if present; else templates for Next.js and Node/Express (spec §5).
- [x] Production build + start; health check with timeout.
- [x] Migrations: detect and run (Prisma, Drizzle, Knex, raw SQL folder) against the test DB.
- [x] Mock server (spec §6): OpenAI, Anthropic, Stripe, Resend endpoints with canned responses; request log for the report.
- [x] Clear failure messages when the app can't boot ("unsupported because …"), never a guess.

**Acceptance**
- Both fixtures boot healthy in the sandbox.
- A fixture endpoint that calls OpenAI gets the mock response; the mock logs the call.
- Boot failure path tested with a deliberately broken fixture copy.

---

## Phase 3 — Seeding

**Goal:** fast, deterministic fake data at several sizes.

- [x] `seed.json` schema + validator (spec §7).
- [x] Generator using SQL `generate_series` with a fixed random seed; respects foreign keys and per-table ratios.
- [x] Sizes `S`, `M`, `L` (default 1k / 10k / 100k rows for the main table, others scaled).
- [x] Test users with known passwords for the login flow (hash format from the app's auth library, chosen in `seed.json`).

**Acceptance**
- Same `seed.json` → same row counts and same checksums of key columns.
- `L` size seeds within a reasonable time on the fixture (record the time in status).

---

## Phase 4 — Load test & breaking point

**Goal:** ramp users until the app breaks, and compute the breaking point.

- [x] `scenario.json` schema (spec §8) → k6 script from template.
- [x] Ramp stages, thresholds and breaking-point rule (spec §8).
- [x] Collect k6 summary + container CPU/memory per stage.
- [x] `result.json` (spec §9): per stage p50/p95/error rate, breaking point, limiting resource.

**Acceptance**
- Fixture with a deliberately slow endpoint breaks at a lower stage than the healthy endpoint.
- Breaking-point computation unit-tested on recorded k6 summaries (no Docker needed for those tests).

---

## Phase 5 — Query probe

**Goal:** show which queries grow with data size, and why.

- [x] For each size (S/M/L): seed, reset `pg_stat_statements`, run a fixed number of single-user requests per probed endpoint, read stats.
- [x] Per endpoint: queries per request, total DB time per request, rows per request, at each size.
- [x] Flags (spec §9.2): `n_plus_one`, `missing_index` (confirmed with `EXPLAIN`), `unbounded_fetch`.
- [x] Static pattern list for the skill (`skills/vibe-breakpoint/references/query-patterns.md`): queries in loops, no limit, filter-after-fetch, filter on unindexed column, per ORM.

**Acceptance**
- Fixture N+1 endpoint: queries per request grow with size → flagged `n_plus_one`.
- Fixture email search without index: flagged `missing_index` with the `Seq Scan` evidence; adding the index in a copy clears the flag.
- Fixture unbounded list: flagged `unbounded_fetch`.

---

## Phase 6 — Chart & report

**Goal:** a shareable chart and a plain-language report.

- [ ] Chart SVG (spec §9.3): users vs response time with the breaking point marked, plus a small data-size table; repo URL + "search vibe-breakpoint on GitHub".
- [ ] PNG from the SVG (decision D-011; verify it bundles, record the outcome).
- [ ] `report.md` (spec §9.4).

**Acceptance**
- Same `result.json` → byte-identical SVG.
- Chart contains no file paths, line numbers, env names or values (test).
- Report states the server profile, what was mocked, and the limits.
- **Needs owner check:** chart PNG readable on a phone.

---

## Phase 7 — The `/vibe-breakpoint` skill

**Goal:** one command for the user, end to end.

- [ ] Write `skills/vibe-breakpoint/SKILL.md` (spec §11) with references (query patterns, framework notes).
- [ ] Claude's parts: find the main flow and routes, write `scenario.json` and `seed.json`, ask at most one batch of questions, read code for query patterns, explain results.
- [ ] No-Docker path: static query report only, clearly labelled (decision D-007).
- [ ] End-to-end run on both fixtures through the installed plugin.

**Acceptance**
- Each fixture: one `/vibe-breakpoint` run produces chart + report; the three global checks pass.
- With Docker unavailable: the static report is produced and says why no load test ran.

---

## Phase 8 — README & release prep

**Goal:** a repo that converts visitors and installs cleanly.

- [x] README (spec §12) with the chart at the top and the install commands.
- [ ] Run on 2–3 public repos chosen by the owner (open item O-3); fix small detection or boot misses.
- [x] Version `0.1.0` in both manifests; local tag `v0.1.0`. Owner pushes.

**Acceptance**
- README sections from spec §12 present.
- Fresh install from the marketplace works on a clean machine/user.
- **Needs owner check:** README and chart.
