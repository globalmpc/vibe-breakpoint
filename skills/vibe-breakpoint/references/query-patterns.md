# Query patterns that slow down as data grows

## How to use this file

1. The tool measured a flag on an endpoint. The flag is the evidence; this file only helps you find the code and the fix.
2. Read the flagged endpoint's handler first (route file, controller, server action). Follow calls into the data layer.
3. Match the flag to a pattern below, grep for the signals, and quote the code location in the report.
4. Fixes are suggestions in the report. Never apply them to the user's project.

What the tool flags:
- `n_plus_one`: queries per request grow 3x or more from size S to L.
- `missing_index`: query time grows 5x or more and EXPLAIN shows a Seq Scan on a table with at least 10k rows.
- `unbounded_fetch`: rows returned grow roughly with table size.

Flag to pattern: `n_plus_one` -> 1; `unbounded_fetch` -> 2 or 3; `missing_index` -> 4 (also 3 when sorting or filtering happens in JS).

Scope: v0.1 covers Prisma, Drizzle, Knex and pg / raw SQL. Supabase and Firebase client APIs are unsupported in v0.1 (D-009).

---

## 1. Queries in loops (N+1)

**Looks like:** one query to get a list, then one more query per item (inside `for`, `map`, `forEach`, `Promise.all(items.map(...))`, or a per-item resolver).

**Why it grows:** query count = rows in the list + 1. More data means more round trips per request.

**Grep for:** `await` inside `for`/`while`; `.map(async`; `Promise.all(` near a query; `findUnique`, `findFirst`, `.where(eq(` or `.where({ id` inside a loop body.

**Prisma**
```ts
// bad
const posts = await prisma.post.findMany();
for (const p of posts) p.author = await prisma.user.findUnique({ where: { id: p.authorId } });
// good
const posts = await prisma.post.findMany({ include: { author: true } }); // or select
// or: prisma.user.findMany({ where: { id: { in: ids } } })
```

**Drizzle**
```ts
// bad
for (const p of posts) p.author = await db.select().from(users).where(eq(users.id, p.authorId));
// good
const authors = await db.select().from(users).where(inArray(users.id, ids));
// or relational: db.query.posts.findMany({ with: { author: true } })
```

**Knex**
```js
// bad
for (const p of posts) p.author = await knex('users').where({ id: p.author_id }).first();
// good
const authors = await knex('users').whereIn('id', posts.map(p => p.author_id));
```

**pg / raw SQL**
```js
// bad: await pool.query('SELECT * FROM users WHERE id = $1', [p.author_id]) per post
// good
await pool.query('SELECT * FROM users WHERE id = ANY($1)', [ids]);
// or one JOIN: SELECT p.*, u.name FROM posts p JOIN users u ON u.id = p.author_id
```
Then map results by id in JS (`new Map(rows.map(r => [r.id, r]))`).

**Fix prompt:** "In `<file>:<line>` the handler for `<route>` runs `<query>` once per item in a loop. Replace it with one batched query (`include` / `inArray` / `whereIn` / `= ANY` / JOIN) and join the results in memory. Keep the response shape the same."

---

## 2. No limit (unbounded fetch)

**Looks like:** a list endpoint that returns every row of a table, or every row matching a filter that matches more as data grows.

**Why it grows:** rows read, serialized and sent are proportional to table size. Memory, time and payload grow with it.

**Grep for:** `findMany()` with no `take`; `db.select().from(t)` with no `.limit(`; `knex('t')` or `.select(` with no `.limit(`; `SELECT ... FROM` without `LIMIT`; `SELECT *` in list routes.

**Prisma**
```ts
// bad
await prisma.post.findMany({ orderBy: { createdAt: 'desc' } });
// good
await prisma.post.findMany({ orderBy: { createdAt: 'desc' }, take: 20, skip: page * 20 });
// better for deep pages: take: 20, cursor: { id: lastId }, skip: 1
```

**Drizzle**
```ts
// bad
await db.select().from(posts).orderBy(desc(posts.createdAt));
// good
await db.select().from(posts).orderBy(desc(posts.createdAt)).limit(20).offset(page * 20);
```

**Knex**
```js
// bad
await knex('posts').orderBy('created_at', 'desc');
// good
await knex('posts').orderBy('created_at', 'desc').limit(20).offset(page * 20);
```

**pg / raw SQL**
```js
// bad: SELECT * FROM posts ORDER BY created_at DESC
// good
await pool.query('SELECT id, title FROM posts ORDER BY created_at DESC LIMIT $1 OFFSET $2', [20, page * 20]);
// keyset: WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 20
```
Cap user-supplied page sizes (for example `Math.min(limit, 100)`). Select only needed columns.

**Fix prompt:** "`<route>` at `<file>:<line>` returns all rows of `<table>`. Add pagination (`limit`/`take` with a capped page size, plus offset or cursor) and accept `page`/`cursor` query params. Keep the response shape; add a `nextCursor` or `total` only if the UI needs it."

---

## 3. Filter after fetch (filter, sort or paginate in JS)

**Looks like:** rows are loaded, then `.filter(`, `.sort(`, `.slice(`, `.find(`, `.reduce(` or `.length` do work the database should do.

**Why it grows:** the database returns the whole table, so rows transferred grow with data even if the response is small. Often shows as `unbounded_fetch` with a small response.

**Grep for:** `.findMany(` / `.select()` / `SELECT *` followed within a few lines by `.filter(`, `.sort(`, `.slice(`, `.length` (used as a count).

**Prisma**
```ts
// bad
const all = await prisma.order.findMany();
const mine = all.filter(o => o.userId === uid).slice(0, 20);
// good
await prisma.order.findMany({ where: { userId: uid }, take: 20 });
// counts: prisma.order.count({ where: { userId: uid } })
```

**Drizzle**
```ts
// bad
const mine = (await db.select().from(orders)).filter(o => o.userId === uid);
// good
await db.select().from(orders).where(eq(orders.userId, uid)).limit(20);
// counts: db.select({ n: count() }).from(orders).where(...)
```

**Knex**
```js
// bad: (await knex('orders')).filter(o => o.user_id === uid)
// good
await knex('orders').where({ user_id: uid }).limit(20);
// counts: knex('orders').where(...).count()
```

**pg / raw SQL**
```js
// bad: rows.filter(r => r.status === 'open').sort(byDate).slice(0, 20)
// good
await pool.query("SELECT id, title FROM orders WHERE status = 'open' ORDER BY created_at DESC LIMIT 20");
// counts: SELECT count(*) ... (not rows.length)
```
After moving the filter into SQL, check pattern 4: the new WHERE column may need an index.

**Fix prompt:** "In `<file>:<line>` the code loads all `<table>` rows and filters/sorts/paginates in JavaScript. Move the condition, ordering and limit into the query (and use a count query for totals). Keep behavior identical."

---

## 4. Filter, join or order on an unindexed column

**Looks like:** `WHERE`, `JOIN ... ON` or `ORDER BY` on a column that is not a primary key, not unique, and has no index. Typical: foreign keys (`user_id`, `post_id`), `status`, `created_at`, `slug`, `email` without a unique constraint.

**Why it grows:** Postgres has to scan the whole table (Seq Scan), so time grows with row count. Postgres does not auto-index foreign keys.

**Grep for:** the column names used in `where` / `eq(` / `whereIn` / `ON` / `orderBy` in the flagged handler, then check the schema or migrations for an index on them.
- Prisma: `schema.prisma` for `@@index`, `@unique`, `@id`.
- Drizzle: schema files for `index(`, `uniqueIndex(`, `.unique()`, `.primaryKey()`.
- Knex / pg: `migrations/` and `*.sql` for `CREATE INDEX`, `table.index(`, `.unique(`.

**Prisma**
```prisma
model Order {
  userId Int
  createdAt DateTime
  @@index([userId, createdAt])  // add; run a new migration
}
```

**Drizzle**
```ts
export const orders = pgTable('orders', { /* ... */ }, (t) => [
  index('orders_user_created_idx').on(t.userId, t.createdAt), // add; generate a migration
]);
```

**Knex** (new migration file)
```js
exports.up = knex => knex.schema.alterTable('orders', t => t.index(['user_id', 'created_at']));
exports.down = knex => knex.schema.alterTable('orders', t => t.dropIndex(['user_id', 'created_at']));
```

**pg / raw SQL** (new migration file, never edit an applied one)
```sql
CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at);
-- big live tables: CREATE INDEX CONCURRENTLY (cannot run inside a transaction block)
```

Column order: equality columns first, then the range or sort column. A primary key or unique constraint already has an index; do not add another.

**Fix prompt:** "Queries on `<table>` filtering by `<cols>` (see `<file>:<line>`) do a sequential scan. Add an index on `(<cols>)` through a new migration in the project's existing migration tool. Do not edit existing migrations."

---

## False positives to avoid

- Small constant-size tables (roles, settings, countries) that never grow with users.
- N+1 where N is a fixed per-page constant (for example 20 items per page) and does not grow with data. The tool measures growth; if the count is flat, say so.
- Admin-only or internal endpoints that are rarely called, unless the flag is on a hot path.
- Lookups by primary key or unique column: already indexed, no `missing_index`.
- Lists already limited (`take`, `.limit`, `LIMIT`) with a capped page size.
- A Seq Scan on a table under the size where Postgres prefers it anyway.

If the code does not match the flag, report the flag with the endpoint and say the cause was not found in code. Do not guess.

## Never do

- Do not modify the user's project. Fixes are suggestions in the report. The sandbox copy is the only thing the tool changes.
- Read env files only as `.env.example`/`.sample`/`.template`. Env var names are in `env_names` in `inspect.json`.
- Do not invent measurements. Every number in the report comes from the scripts.
