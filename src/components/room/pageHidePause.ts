// 离开页面兜底暂停的纯函数层：UI 行为在 Room.tsx，可测语义在这里锁定。
// 约束：只在会议 active 时发 beacon——paused 重复暂停会白打一趟 400，ended 是终态无暂停语义。
export function shouldPauseOnPageHide(status: string): boolean {
  return status === 'active';
}

// action 路由是纯 POST 且不读 body，sendBeacon 可直打该 URL，服务端无需改动。
export function pauseBeaconUrl(meetingId: string): string {
  return `/api/meetings/${meetingId}/pause`;
}

// 仅 bfcache 还原（pagehide 时 beacon 已把服务端置 paused，本地 state 冻结在 active）才重拉对齐；
// 普通 pageshow 是正常加载路径，初始数据已带最新状态，重拉是浪费请求。
export function shouldResyncOnPageShow(persisted: boolean): boolean {
  return persisted;
}
