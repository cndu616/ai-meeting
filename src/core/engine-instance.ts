import { getDb } from '@/db/client';
import { MeetingEngine } from './engine';

const g = globalThis as unknown as { __meetingEngine?: MeetingEngine };

/** 决议 5：SIGTERM 排水窗口（陈终局注记落地）——「优雅停止」不等成「挂起」。
 *  关闭序列：SIGTERM → pause 全部 active（close 痕迹随 pause 落）→ 有界排水窗口
 *  （等在途回合跑完、迟到 result 经 onLateResult 落库）→ 窗口超时降级强杀语义
 *  （onDiscard 痕迹 + 下次 resume 对账补推兜底）→ 退出。 */
const SHUTDOWN_DRAIN_MS = 30_000;

export function getEngine(): MeetingEngine {
  if (!g.__meetingEngine) {
    const engine = new MeetingEngine(getDb());
    g.__meetingEngine = engine;
    // 决议 5（quarantine）：服务重启后 active 孤儿会议不自动复活——
    // 降级 paused + 落痕迹消息，恢复走用户显式「继续」（resume 全套）
    engine.recoverActiveMeetings();
    registerSigtermHandler(engine);
  }
  return g.__meetingEngine;
}

/** 防重入：第二个 SIGTERM 到来时窗口已在跑，直接等既有序列收尾 */
let sigtermHandled = false;

function registerSigtermHandler(engine: MeetingEngine): void {
  process.on('SIGTERM', () => {
    if (sigtermHandled) return;
    sigtermHandled = true;
    console.log('[engine-instance] 收到 SIGTERM，开始有界排水（pause 全部会议后等待在途回合）');
    void engine.gracefulShutdown()
      .then((hadActive) => hadActive
        ? new Promise<void>((r) => setTimeout(r, SHUTDOWN_DRAIN_MS))
        : undefined)
      .finally(() => process.exit(0));
  });
}
