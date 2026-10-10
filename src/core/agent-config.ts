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
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      file: f,
      agent: agentFileSchema.parse(
        JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')),
      ),
    }));
  const seen = new Map<string, string>();
  for (const { file, agent } of files) {
    const prev = seen.get(agent.id);
    if (prev) {
      throw new Error(`agent id "${agent.id}" 重复：${prev} 与 ${file}，请修改其中一个的 id 字段`);
    }
    seen.set(agent.id, file);
  }
  return files.map((f) => f.agent);
}

export function importAgentsToDb(db: DB, files: AgentFile[]): void {
  for (const a of files) {
    db.insert(agents)
      .values(a)
      .onConflictDoUpdate({ target: agents.id, set: { ...a } })
      .run();
  }
}
