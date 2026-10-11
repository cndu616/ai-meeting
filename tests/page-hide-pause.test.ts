import { describe, it, expect } from 'vitest';
import {
  shouldPauseOnPageHide,
  pauseBeaconUrl,
  shouldResyncOnPageShow,
} from '@/components/room/pageHidePause';

describe('pageHidePause', () => {
  it('仅 active 状态需要离开页面兜底暂停', () => {
    expect(shouldPauseOnPageHide('active')).toBe(true);
  });

  it('paused 状态不重复发送暂停请求', () => {
    expect(shouldPauseOnPageHide('paused')).toBe(false);
  });

  it('ended 状态不发送暂停请求（终态无暂停语义）', () => {
    expect(shouldPauseOnPageHide('ended')).toBe(false);
  });

  it('beacon 直打 action 路由的 pause 端点', () => {
    expect(pauseBeaconUrl('m-1')).toBe('/api/meetings/m-1/pause');
  });

  it('bfcache 还原（persisted）时需要重拉会议状态', () => {
    expect(shouldResyncOnPageShow(true)).toBe(true);
  });

  it('普通 pageshow（非 bfcache，页面正常加载）不重拉', () => {
    expect(shouldResyncOnPageShow(false)).toBe(false);
  });
});
