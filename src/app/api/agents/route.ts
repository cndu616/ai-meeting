import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';

export async function GET() {
  const db = getDb();
  importAgentsToDb(db, loadAgentFiles());
  return Response.json(db.select().from(agents).all());
}
