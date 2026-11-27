# Where to look (routes, auth, schema)

Read code only. Env var names are in `env_names` in `inspect.json`; do not read env files other than `.env.example`/`.sample`/`.template`.

## Next.js
- Routes: `app/**/route.ts` (exports GET/POST), `pages/api/**`, server actions (`"use server"`), page files that fetch data on the server.
- Auth: `middleware.ts`, NextAuth/Auth.js config (`auth.ts`, `app/api/auth/[...nextauth]/route.ts`). Credentials provider means email+password login is possible; only OAuth providers means public endpoints only.
- Server Action login (`"use server"` form) cannot be scripted by the load step: use public endpoints and say so.
- Base path of a route is its folder path: `app/api/projects/route.ts` is `/api/projects`.

## Express and other Node servers
- Routes: `app.get/post/put/delete(...)`, `express.Router()` plus `app.use("/prefix", router)`. Look in `server.js`, `index.js`, `app.js`, `src/routes`, `src/server.js`.
- Auth: session or JWT middleware (`express-session`, `jsonwebtoken`, `passport`), a login route that sets a cookie. Check which header or cookie carries the credential. Bearer-token-only auth cannot be saved by the load step (cookie only): use public endpoints and say so.

## Schema and data layer
- Prisma: `prisma/schema.prisma` (models, `@@index`, `@unique`). Calls: `prisma.<model>.findMany/findUnique`.
- Drizzle: `schema` path in `drizzle.config.*`, tables defined with `pgTable`. Calls: `db.select().from(...)`, `db.query.<table>`.
- Knex: `knexfile.*`, `migrations/`. Calls: `knex("table")`.
- pg and raw SQL: `migrations/*.sql` (or `db/migrations`), `pool.query(...)`, `client.query(...)`.
- Password column: look for `bcrypt`/`bcryptjs` in the login route. Anything else (argon2, scrypt) means no test users.

## What to take from the code
- Main table: the one the list/feed endpoints read.
- Required columns: NOT NULL without DEFAULT in the schema or migrations.
- Which endpoints are public, which need the cookie.
