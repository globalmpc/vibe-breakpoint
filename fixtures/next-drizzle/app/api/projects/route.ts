import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { projects, users } from "../../../src/db/schema";

export const dynamic = "force-dynamic";

// N+1: one query per project for its owner, no limit
export async function GET() {
  const all = await db.select().from(projects);
  const out = [];
  for (const p of all) {
    const [owner] = await db.select().from(users).where(eq(users.id, p.ownerId));
    out.push({ ...p, owner });
  }
  return Response.json(out, { headers: { "x-app": process.env.NEXT_PUBLIC_APP_NAME ?? "" } });
}
