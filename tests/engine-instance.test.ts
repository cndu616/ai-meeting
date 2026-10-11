// tests/engine-instance.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  const db = actual.createTestDb();
  return { ...actual, getDb: () => db };
});

import { getEngine } from '@/core/engine-instance';
import { MeetingEngine } from '@/core/engine';

const g = globalThis as unknown as { __meetingEngine?: MeetingEngine };

describe('engine-instance', () => {
  beforeEach(() => {
    delete g.__meetingEngine; // 每用例重置单例
  });

  it('getEngine 首次调用触发 recoverActiveMeetings，后续调用幂等不重复触发', () => {
    const spy = vi.spyOn(MeetingEngine.prototype, 'recoverActiveMeetings')
      .mockImplementation(() => {});
    const e1 = getEngine();
    expect(spy).toHaveBeenCalledTimes(1);
    const e2 = getEngine();
    expect(e2).toBe(e1);
    expect(spy).toHaveBeenCalledTimes(1); // 单例缓存命中，不再触发
    spy.mockRestore();
  });
});
