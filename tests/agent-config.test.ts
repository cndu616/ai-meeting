import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('同一能力多个 agent（不同 id）可共存', () => {
    const db = createTestDb();
    importAgentsToDb(db, loadAgentFiles());
    const caps = db.select().from(agents).all().filter((r) => r.capability === '研发');
    expect(caps.length).toBeGreaterThanOrEqual(2);
  });

  it('目录内 id 重复时抛出明确错误', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
      id: 'dup', name: 'a', capability: 'c', description: 'd', persona: 'p',
    }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({
      id: 'dup', name: 'b', capability: 'c', description: 'd', persona: 'p',
    }));
    expect(() => loadAgentFiles(dir)).toThrow(/重复/);
  });
});
