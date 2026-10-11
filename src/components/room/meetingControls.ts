// 会议控制类纯函数：按钮可用性语义在此锁定，UI 渲染在组件里。
// 禁言是成员级配置（muted 为独立 DB 字段，paused 下 engine.setMuted 完全有效），
// 与会议运行状态无关；ended 是终态闸门（不能发言/加人/私聊），禁言在终态下无意义。
export function canToggleMute(status: string): boolean {
  return status !== 'ended';
}
