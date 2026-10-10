// tests/fake-session.ts —— dispatch/dm/control/api/crash 五个测试文件共用
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine } from '@/core/engine';
import type { SessionCreateOptions } from '@/core/session-factory';

/** 假会话：记录 push，测试手动触发回调 */
export class FakeSession {
  started = false;
  closed = false;
  pushes: { text: string; kind: 'chatroom' | 'dm' }[] = [];
  constructor(public opts: SessionCreateOptions) {}
  start() { this.started = true; }
  push(text: string, kind: 'chatroom' | 'dm' = 'chatroom') { this.pushes.push({ text, kind }); }
  async close() { this.closed = true; }
}

/** 构造带 FakeSession 工厂的 engine 与一个 2 人测试会议 */
export function setupEngine() {
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  // 按 create 调用顺序累积：start 按 speakOrder 创建；
  // 崩溃重建/离线私信的一次性会话会追加到尾部
  const sessions: FakeSession[] = [];
  const engine = new MeetingEngine(db, {
    create: (opts: SessionCreateOptions) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s;
    },
  });
  const m = engine.createMeeting({
    title: 't',
    topic: 'tp',
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
    participants: [
      { templateId: 'dev', displayName: '张工', goal: '激进派' },
      { templateId: 'test', displayName: '李测试', goal: '保守派' },
    ],
  });
  return { db, engine, m, sessions };
}
