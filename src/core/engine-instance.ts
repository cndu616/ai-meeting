import { getDb } from '@/db/client';
import { MeetingEngine } from './engine';

const g = globalThis as unknown as { __meetingEngine?: MeetingEngine };

export function getEngine(): MeetingEngine {
  if (!g.__meetingEngine) g.__meetingEngine = new MeetingEngine(getDb());
  return g.__meetingEngine;
}
