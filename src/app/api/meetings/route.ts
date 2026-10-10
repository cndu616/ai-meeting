import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { getEngine } from '@/core/engine-instance';

export async function GET() {
  return Response.json(
    getDb().select().from(meetings).orderBy(desc(meetings.createdAt)).all(),
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const m = getEngine().createMeeting(body);
    return Response.json(m);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
