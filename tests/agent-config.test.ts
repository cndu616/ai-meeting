import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/db/client';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';
import { agents } from '@/db/schema';

describe('agent-config', () => {
  it('加载内置配置并导入数据库（可重复导入不报错）', () => {
    const db = createTestDb();
    const files = loadAgentFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    importAgentsToDb(db, files);
    importAgentsToDb(db, files); // upsert 幂等
    const rows = db.select().from(agents).all();
    expect(rows.map((r) => r.id)).toContain('dev');
  });
});
