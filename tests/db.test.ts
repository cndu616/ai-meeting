import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/db/client';
import { meetings } from '@/db/schema';

describe('db', () => {
  it('迁移已应用，可插入并读回', () => {
    const db = createTestDb();
    db.insert(meetings)
      .values({ id: 'm1', title: 't', topic: 'tp', workspacePath: '/tmp', createdAt: 1 })
      .run();
    const row = db.select().from(meetings).all()[0];
    expect(row.id).toBe('m1');
    expect(row.status).toBe('paused');
    expect(row.maxRounds).toBe(6);
  });
});
