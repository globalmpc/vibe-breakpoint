# Writing scenario.json, seed.json and run.json

Both files go in `PROJECT/.vibe-breakpoint/`. Write them from reading the code. They hold no secrets and no env values. Any rule broken here makes `run` fail before Docker starts, with a message naming the file.

## seed.json

- `schema: 1`, `random_seed` (integer), `main_table` (the table the app grows most), `sizes` `{S, M, L}` (rows of the main table; use 1000 / 10000 / 100000), `tables`, optional `test_users`.
- `tables` are seeded in listed order. `ratio` scales a table against `main_table`. A `fk` gen may only reference a table listed earlier.
- Gens: `email`, `words` (`count` 1..10), `fk` (`ref: "table.column"`), `password_hash` (`algo: "bcrypt"` only, `plain` 1..72 bytes), `auto` (type-based value).
- Every NOT NULL column without a default needs a gen (`auto` is fine). Unlisted columns get the DB default or NULL.
- Enum columns are unsupported: the table cannot be seeded; say so under limits.
- `test_users` needs a table that has both a `password_hash` gen and an `email` gen. The users get email `user<i>@example.test` and the `plain` password.
- If the app logs in only through OAuth or a third party (no email and password), or hashes with something other than bcrypt, skip `test_users` and `{{user.*}}`, use only public endpoints, and say so under limits.

## scenario.json

- `schema: 1`, `flow` (max 20 steps), `think_time_s`, optional `probe_endpoints` (step names).
- Step: `name`, `method`, `path` (starts with a single `/`, no absolute URLs), optional `body` (object), optional `save: {"cookie": true}` (a login step; runs once per user).
- Placeholders in `path` and string values of `body`: `{{user.email}}`, `{{user.password}}` (need `test_users`), `{{random.email}}` (needs an email gen). Nothing else is allowed.
- At least one step must not be a cookie step.
- `probe_endpoints`: read endpoints that touch the main data. Never list the login step.
- Pick the flow a typical user does: log in, open the main page, one search or list.

## Example scenario.json

```json
{
  "schema": 1,
  "flow": [
    { "name": "login", "method": "POST", "path": "/api/login", "body": { "email": "{{user.email}}", "password": "{{user.password}}" }, "save": { "cookie": true } },
    { "name": "projects", "method": "GET", "path": "/api/projects" },
    { "name": "search", "method": "GET", "path": "/api/users?email={{random.email}}" },
    { "name": "feed", "method": "GET", "path": "/api/feed" }
  ],
  "think_time_s": 1,
  "probe_endpoints": ["projects", "search", "feed"]
}
```

## Example seed.json

```json
{
  "schema": 1,
  "random_seed": 42,
  "main_table": "projects",
  "sizes": { "S": 1000, "M": 10000, "L": 100000 },
  "tables": [
    { "name": "users", "ratio": 0.1, "columns": {
        "email": { "gen": "email" },
        "password_hash": { "gen": "password_hash", "algo": "bcrypt", "plain": "vb-test-password" },
        "name": { "gen": "auto" } } },
    { "name": "projects", "ratio": 1, "columns": {
        "owner_id": { "gen": "fk", "ref": "users.id" },
        "name": { "gen": "words", "count": 3 } } }
  ],
  "test_users": 50
}
```

## run.json (optional)

`PROJECT/.vibe-breakpoint/run.json` sets the build and start command for the test copy, and extra env names. All fields are optional. It never changes the project.

- `build`: argv array (or `null` for no build step), max 12 tokens of max 120 characters. `start`: argv array, same limits.
- First token: `node`, `npm`, `pnpm`, `yarn` or a path starting `node_modules/.bin/`. Tokens use only letters, digits and `_ @ % + = : , . / -`; no `..`, no leading `/`, no spaces, quotes, `$`, `;`, `&`, `|`. No `&&`: one command only.
- `env_names`: up to 50 env var NAMES the build or app reads that the scan missed (for example `NEXT_PUBLIC_X`). Names only, never values: values are generated. Any other key is rejected.
- With a project Dockerfile, `build` and `start` are ignored; `env_names` still apply.

Example: no start script, the entry is `src/main.js`.

```json
{ "start": ["node", "src/main.js"] }
```

Example: a pnpm Next.js app whose build needs extra env names.

```json
{ "build": ["pnpm", "run", "build"], "start": ["pnpm", "run", "start"], "env_names": ["NEXT_PUBLIC_SITE_URL", "AUTH_SECRET"] }
```
