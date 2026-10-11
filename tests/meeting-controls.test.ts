import { describe, it, expect } from 'vitest';
import { canToggleMute } from '@/components/room/meetingControls';

describe('canToggleMute', () => {
  it('active 时可禁言', () => {
    expect(canToggleMute('active')).toBe(true);
  });

  it('paused 时仍可禁言——禁言是成员级配置，与会议运行状态无关', () => {
    expect(canToggleMute('paused')).toBe(true);
  });

  it('ended 时不可禁言——终态无禁言意义（闸门语义：已结束不能发言/加人/私聊）', () => {
    expect(canToggleMute('ended')).toBe(false);
  });
});
