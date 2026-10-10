import { getDb } from '@/db/client';
import { MeetingEngine } from './engine';

const g = globalThis as unknown as { __meetingEngine?: MeetingEngine };

export function getEngine(): MeetingEngine {
  if (!g.__meetingEngine) {
    const engine = new MeetingEngine(getDb());
    g.__meetingEngine = engine;
    // 服务器重启/热重载后：恢复所有进行中的会议（异步，不阻塞）
    engine.recoverActiveMeetings();
  }
  return g.__meetingEngine;
}
