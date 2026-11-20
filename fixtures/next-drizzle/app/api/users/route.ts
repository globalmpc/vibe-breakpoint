import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { users } from "../../../src/db/schema";

export const dynamic = "force-dynamic";

// email is not indexed
export async function GET(req: Request) {
  if (!process.env["NEXTAUTH_SECRET"]) return new Response("unauthorized", { status: 401 });
  const email = new URL(req.url).searchParams.get("email") ?? "";
  return Response.json(await db.select().from(users).where(eq(users.email, email)));
}
