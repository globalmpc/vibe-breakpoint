---
name: vibe-breakpoint
description: Find how many users a web app can handle at the same time before it slows down or fails, and which database queries get slower as data grows (N+1 queries, missing indexes, unbounded fetches). Runs on an isolated copy of the app with a throwaway database; never changes the project. Use when the user asks whether their app will scale, how many users it can handle, or why it is slow.
---

# /vibe-breakpoint

Define once: `VB` = `node "${CLAUDE_SKILL_DIR}/scripts/vibe-breakpoint.mjs"`. If the path above still contains the literal `${`, stop and tell the user the skill path was not resolved.
`PROJECT` = absolute path of the git root (`git rev-parse --show-toplevel`), or the current directory if there is none.
Run every command non-interactively.

## Never
- Read env files yourself. Env var names come only from `env_names` in `inspect.json`: the CLI collects them from code, config and env files in-process and keeps names only (values are discarded, never stored or printed). Only `.env.example`, `.env.sample` and `.env.template` may be read directly.
- Connect to any database, URL or host from the user's config (no psql, curl, fetch against them).
- Modify anything outside `PROJECT/.vibe-breakpoint/`.
- Invent numbers. Every number comes from `result.json` or the CLI output.
- Put env values or secrets in any file or reply.

## Step 1: Inspect
Run `VB inspect PROJECT` and read the JSON it prints.
- `supported` is false and `run_json_can_fix` is not true: tell the user the `unsupported_reason` in plain words, then stop.
- `docker.available` is false: follow **No-Docker path**, then stop.
- `supported` is true: tell the user in 2-4 plain lines what you found: the app has no Dockerfile so it is built from `package.json` (or the project Dockerfile is used); the `build` and `start` commands it will use and where they come from (`start_source`); that a throwaway Postgres is used (from `db_deps` / `migrations`). If there is no Postgres support, say so and stop as for unsupported.
- `run_json_can_fix` is true, or `start` is dev-like or null: read the code (`package.json`, `${CLAUDE_SKILL_DIR}/references/framework-notes.md`) and write `PROJECT/.vibe-breakpoint/run.json` yourself (format in `${CLAUDE_SKILL_DIR}/references/inputs.md`) without asking, then run `VB inspect PROJECT` again and say what you chose. Settings live only in the test copy; never edit `package.json` or any project file.

## Step 2: Read the code, write the inputs
Use `${CLAUDE_SKILL_DIR}/references/framework-notes.md` to find routes, auth and schema. Write `PROJECT/.vibe-breakpoint/scenario.json` and `seed.json` following `${CLAUDE_SKILL_DIR}/references/inputs.md`.
If `has_scenario` / `has_seed` is true, reuse the existing file, say so, and do not overwrite it.

## Step 3: One message (questions and consent)
Ask only what the code cannot show (for example which flow matters most); skip the questions if there are none. In the same message give this consent text:

> vibe-breakpoint will: copy this project to a temporary folder (your files are not changed; results go to `.vibe-breakpoint/`); build the app image (build command `<build>`, start command `<start>`; up to 3 builds if the first build needs fixing, with settings adjusted only in the test copy) and start containers on an offline Docker network: your app, a throwaway Postgres in memory, a mock for outside services, and k6 for load (image `grafana/k6`); download images: `<missing_images from inspect.json, or "none, all are local">`; take roughly 10-15 minutes (build 2-5 min, data seeding and query probe 2-5 min, load test up to 6 stages x 60 s, stops early when the app breaks); remove all containers and temp files at the end. OK to go ahead?

Without a clear yes, stop.

## Step 4: Run
After the yes, run `VB run PROJECT --pull` with the Bash tool's `run_in_background`, and wait for it to exit. `--pull` only after consent.
- Exit 0: continue.
- Exit 2: unsupported; explain the reason in plain words.
- Exit 1 with `scenario.json:` or `seed.json:` in the output: that file is invalid (this fails before Docker). Fix it and run once more without asking again.
- Exit 1 with `run.json:` in the output: fix `run.json` and run once more without asking again.
- Exit 1 and the output contains `app build failed:` or `app did not start:`: read the last lines and make ONE targeted fix in `PROJECT/.vibe-breakpoint/run.json` (add missing env names to `env_names`; set or adjust `build` or `start`; pnpm, yarn and other fixes only through `run.json`). Say in one plain line what you changed and why, then run again (no `--pull` needed, no new consent: the consent covered it). At most 2 retries (3 builds in total).
- Stop early, without retrying, when the cause cannot be fixed offline: the build needs the database or an outside service while building, a native or private dependency, a private registry. Only then (or when the retries are used up) offer the code-reading report from the **No-Docker path** (no measured numbers), in at most 4 plain lines with ONE recommended step, and ask "Want me to do that?". Nothing in the project was changed.
- Any other exit 1: say what failed in one plain sentence and that nothing in the project was changed.
- Exit 129, 130 or 143, or the user stopped it: run `VB cleanup` and say the run was interrupted.
Never run `render` after a failed run.

## Step 5: Code locations
Read `PROJECT/.vibe-breakpoint/out/result.json`, key `flags`. For each flag find the handler using `${CLAUDE_SKILL_DIR}/references/query-patterns.md`. Write `PROJECT/.vibe-breakpoint/code-locations.md` (overwrite every run):

```
### <flag> - <endpoint>
- <file>:<line> - <what the code does>
- Fix: <one line>
```
No secrets or env values. If the cause is not found, say so.

## Step 6: Render and reply
Run `VB render PROJECT`. Reply in under 8 lines:
- the breaking point ("handles about N users", "broke at N users, the first stage tested", or "no breaking point up to N") and the limiting resource,
- the top data-growth issue with `file:line`,
- limits that matter (for example OAuth-only login so only public endpoints were tested, SDKs that cannot reach the mock),
- paths: `.vibe-breakpoint/out/report.md` and `.vibe-breakpoint/out/chart.png`.

## No-Docker path
Read the code with `${CLAUDE_SKILL_DIR}/references/query-patterns.md` and write `PROJECT/.vibe-breakpoint/static-report.md`, starting exactly with:

```
# vibe-breakpoint static report (no load test): <project name>

**No load test ran** because <docker.reason from inspect.json>. Nothing was measured; the findings below come from reading the code for known slow-query patterns. Start Docker and run /vibe-breakpoint again for real numbers.
```
Then, per finding: pattern name, `file:line`, why it grows, suggested fix. No measured-looking numbers (no users, ms or row counts). Reply in under 8 lines with the reason and the file path.

## Cleanup
`VB cleanup` is always safe to run. Mention it whenever a run was interrupted.
