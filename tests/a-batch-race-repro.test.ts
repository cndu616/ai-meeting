import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine, type CreateMeetingInput } from '@/core/engine';
import { meetings, messages } from '@/db/schema';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setup(maxRounds = 4) {
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  const input: CreateMeetingInput = {
    title: 't', topic: 'tp',
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
    maxRounds,
    participants: [
      { agentId: 'dev', meetingRole: '激进派' },
      { agentId: 'test', meetingRole: '保守派' },
    ],
  };
  let n = 0;
  const runner = vi.fn(async () => ({
    speech: `第${++n}条发言`, sessionId: `s-${n}`, toolActivities: [] as { tool: string; detail: string }[],
  }));
  const engine = new MeetingEngine(db, runner as never);
  const m = engine.createMeeting(input);
  return { db, engine, runner, meetingId: m.id };
}

/** 在第 n 次调用（1 基）时阻塞，返回释放函数 */
function gateAt(runner: ReturnType<typeof vi.fn>, n: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const impl = runner.getMockImplementation()!;
  runner.mockImplementation(async (...args: unknown[]) => {
    if (runner.mock.calls.length === n) await gate;
    return (impl as (...a: unknown[]) => Promise<unknown>)(...args);
  });
  return release;
}

describe('A 批验收：pause/resume 窗口期竞态', () => {
  // 多时序采样（评审决议）：挂起点分别取首位/末位参会者回合，防止单一时序绿。
  // 「暂停中即时 DM 回合」场景待 A 批修法落地后同批补（时序构造依赖修法语义）。
  it.each([1, 2])('挂起点=第 %i 个回合：pause 后立即 resume，不得产生 active 无循环的僵尸', async (n) => {
    const { db, engine, runner, meetingId } = setup(4);
    const release = gateAt(runner, n); // 挂起第 n 个回合，制造暂停窗口
    const p = engine.start(meetingId);
    await vi.waitFor(() => expect(runner.mock.calls.length).toBeGreaterThanOrEqual(n));

    engine.pause(meetingId);   // 当前回合仍在进行（ctl.pause=true，循环未退）
    engine.resume(meetingId);  // 窗口期内继续：start() 看到 loops 仍有条目

    release();                 // 放行被挂起的回合，旧循环随后退出
    await p;
    await new Promise((r) => setTimeout(r, 20)); // 让 finally 跑完

    const m = db.select().from(meetings).where(eq(meetings.id, meetingId)).all()[0];
    // 不变式：循环不在跑，DB 就绝不许是 active（具体修法不限：新循环在跑，或明确 paused）
    expect(engine.isRunning(meetingId) || m.status !== 'active').toBe(true);
  });

  it('窗口期内 resume 应取消暂停标志：循环继续跑满，而非静默退出', async () => {
    const { db, engine, runner, meetingId } = setup(2);
    const release = gateAt(runner, 1); // 挂起第 1 个回合，制造暂停窗口
    const p = engine.start(meetingId);
    await vi.waitFor(() => expect(runner.mock.calls.length).toBeGreaterThanOrEqual(1));

    engine.pause(meetingId);
    engine.resume(meetingId); // 语义：取消暂停。循环还在，就该继续跑

    release();
    await p;
    // 循环继续：2 轮 × 2 人 = 4 条发言，跑满自然 paused（而非停在 active/半途而废）
    await vi.waitFor(() => {
      const m = db.select().from(meetings).where(eq(meetings.id, meetingId)).all()[0];
      if (m.status !== 'paused') throw new Error(`会议未跑满，status=${m.status}`);
    });
    const speeches = db.select().from(messages).where(eq(messages.kind, 'speech')).all().length;
    expect(speeches).toBe(4);
  });
});
