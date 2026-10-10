import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { agents } from '@/db/schema';
import type { DB } from '@/db/client';

export const agentFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  capability: z.string().min(1),
  description: z.string().min(1),
  persona: z.string().min(1),
  avatar: z.string().default('🤖'),
});

export type AgentFile = z.infer<typeof agentFileSchema>;

export function loadAgentFiles(
  dir: string = path.join(process.cwd(), 'agents'),
): AgentFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) =>
      agentFileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))),
    );
}

export function importAgentsToDb(db: DB, files: AgentFile[]): void {
  for (const a of files) {
    db.insert(agents)
      .values(a)
      .onConflictDoUpdate({ target: agents.id, set: { ...a } })
      .run();
  }
}
