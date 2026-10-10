import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@/db/client';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';
import { agents } from '@/db/schema';

describe('agent-config', () => {
  it('加载内置岗位模板（无 name 字段）并幂等导入', () => {
    const db = createTestDb();
    const files = loadAgentFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) expect('name' in f).toBe(false);
    importAgentsToDb(db, files);
    importAgentsToDb(db, files);
    const rows = db.select().from(agents).all();
    expect(rows.map((r) => r.id)).toContain('dev');
    expect(rows.map((r) => r.id)).toContain('architect');
  });

  it('目录内 id 重复时抛出明确错误', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
      id: 'dup', capability: 'c', description: 'd', persona: 'p',
    }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({
      id: 'dup', capability: 'c', description: 'd', persona: 'p',
    }));
    expect(() => loadAgentFiles(dir)).toThrow(/重复/);
  });
});
