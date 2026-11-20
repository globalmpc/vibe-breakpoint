# vibe-breakpoint

Claude Code plugin (skill `/vibe-breakpoint`) that finds how many users a vibe-coded app can handle at the same time, and which database queries slow it down as data grows. It tests an **isolated copy** of the app and never changes the user's project.

## Repo layout

A Claude Code **skill** installed with `npx skills add globalmpc/vibe-breakpoint --skill vibe-breakpoint -g -a claude-code` (no plugin, no marketplace, D-058). `skills/vibe-breakpoint/` is the only folder users receive; everything else is for development.

```
skills/vibe-breakpoint/             # THE PRODUCT — self-contained skill folder
  SKILL.md (+ references/)          # the skill
  scripts/                          # built bundle (committed), called via ${CLAUDE_SKILL_DIR}/scripts/
  templates/                        # compose, Dockerfiles, mock server, k6 script templates
  assets/                           # bundled font + wasm for PNG
src/                                # TypeScript source → bundled into skills/vibe-breakpoint/scripts/
tests/                              # vitest
fixtures/                           # small runnable fake apps (fake secrets only)
docs/                               # plan, spec, decisions, status
.claude/                            # development only: /phase skill, settings
```

Rules for the layout:
- The skill folder must stay self-contained: the installer copies only it. Every path to its own files uses `${CLAUDE_SKILL_DIR}`.
- Runtime code must not need `node_modules`: scripts are self-contained esbuild bundles using Node built-ins.
- `version` lives only in the root `package.json` (the CLI imports it; esbuild inlines it).

## How work happens here

- Development runs phase by phase with **`/phase`** (`.claude/skills/phase/SKILL.md`): `/phase` runs the next unfinished phase, `/phase 3` runs phase 3, `/phase status` reports progress.
- Plan: `docs/plan.md` · Contracts: `docs/spec.md` · Decisions: `docs/decisions.md` · Progress: `docs/status.md`.
- Use the existing agents: **analis → implementer → reviewer** (reviewer may delegate to **tester**). Don't create new agents that overlap them. Handoff notes in `.claude/work/<task-slug>.md`.
- Routine commands (npm, node, docker, git add/commit) run without asking. **Never push.**
- If the spec or a decision turns out wrong, record a new decision in `docs/decisions.md` and say so in the phase summary. Don't work around it silently.

## Product rules (non-negotiable)

1. **The user's project is never modified.** All test changes happen in a temporary copy. The only thing written into the project is the output folder `.vibe-breakpoint/`. A test checks the project tree is identical before and after (except that folder).
2. **No junk data in any real database.** The test database is a fresh Postgres container on tmpfs, created and destroyed per run. Never connect to a database URL from the user's config.
3. **Env vars: names only.** No agent opens, reads or prints a real `.env*` file. `.env.example` may be read. The test environment gets **generated fake values** for every env name. Only `src/sandbox/env-names.ts` may parse real env files, in-process, keeping names and discarding values.
4. **No real outside calls.** The app runs on an `internal` Docker network with no internet. Payment, AI, email and other services are pointed at the bundled mock server.
5. **Local only.** Load is sent only to the app inside the isolated environment. No public or production URLs in v0.1.
6. **Always clean up.** Every container, network and volume carries the run label; temp folders use a known prefix. Cleanup runs on success, failure and interrupt (signal traps), and `cleanup` removes leftovers from killed runs.
7. **Consent before heavy actions.** Pulling images and building/running containers is announced and approved by the user once per run.
8. **Numbers come from measurements.** Claude writes structured inputs (`scenario.json`, `seed.json`) and explains results; scripts measure and compute every number.
9. **Outputs never contain secrets or env values.** The chart image never shows file paths or line numbers either.

## Stack

- TypeScript (strict), ESM, Node ≥ 20 is the runtime floor for the skill (bundle `--target=node20`); the dev floor is Node 22.12 (vitest 5). Tests: vitest. Bundler: esbuild → `skills/vibe-breakpoint/scripts/vibe-breakpoint.mjs`.
- Docker Compose for the isolated environment. k6 runs as a container (`grafana/k6`) inside the test network, so users don't install k6.
- Postgres with `pg_stat_statements` for query measurement.

## Commands

```bash
npm install
npm run build       # esbuild → skills/vibe-breakpoint/scripts/
npm test            # vitest (unit)
npm run test:e2e    # runs fixtures in Docker (from Phase 1)
npm run typecheck
```

Local install test: `HOME=$(mktemp -d) npx skills add . --skill vibe-breakpoint -g -a claude-code -y`, or copy `skills/vibe-breakpoint` into `~/.claude/skills/`.

## Definition of done (every phase)

- Acceptance checks for the phase in `docs/plan.md` pass.
- `npm test` and `npm run typecheck` pass; `npm run build` leaves the bundle up to date.
- From Phase 1: the **project-untouched**, **secret**, and **cleanup** checks pass.
- `docs/status.md` updated, new decisions appended, committed as `phase N: <title>`.
