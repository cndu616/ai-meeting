// src/components/room/Room.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import AgentCard from './AgentCard';
import ChatPanel from './ChatPanel';
import DmDrawer from './DmDrawer';
import AddMemberDialog from './AddMemberDialog';
import type { RoomData, AgentStatus } from './types';
import { parseMeetingEvent } from '@/lib/eventParsing';
import { shouldPauseOnPageHide, pauseBeaconUrl, shouldResyncOnPageShow } from './pageHidePause';
import { mergeMessage } from './chatMessages';
import { canToggleMute } from './meetingControls';

export type { ParticipantView, RoomData } from './types';

export default function Room({ initial }: { initial: RoomData }) {
  const [meeting, setMeeting] = useState(initial.meeting);
  const [participants, setParticipants] = useState(initial.participants);
  const [messages, setMessages] = useState(initial.messages);
  const [states, setStates] = useState<Record<string, { status: AgentStatus; detail?: string }>>({});
  const [dmTarget, setDmTarget] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [sseWarn, setSseWarn] = useState<{ count: number; lastReason: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const applyEvent = useCallback((e: MessageEvent) => {
    const parsed = parseMeetingEvent(e.data);
    if (!parsed.ok) {
      // 畸形事件隔离：一条坏事件只污染自己，不中断后续事件处理。
      // 降级提示为纯客户端本地状态（不落库不广播，刷新即清）——正常态永不出现，
      // 出现即契约漂移信号（服务端/客户端版本错配），黄条文案带动作指引。
      setSseWarn((w) => ({ count: (w?.count ?? 0) + 1, lastReason: parsed.reason }));
      return;
    }
    const data = parsed.event;
    switch (data.type) {
      case 'message':
        // 去重 + 有序合并：为 SSE 断线补发（旧区间后到）做准备，见 chatMessages.ts
        setMessages((ms) => mergeMessage(ms, data.message));
        break;
      case 'agent_status':
        setStates((s) => ({
          ...s,
          [data.participantId]: { status: data.status, detail: data.detail },
        }));
        break;
      case 'participant': {
        const info = data.participant;
        setParticipants((ps) => {
          const exists = ps.some((p) => p.id === info.id);
          return exists
            ? ps.map((p) => (p.id === info.id ? { ...p, ...info } : p))
            : [...ps, info];
        });
        break;
      }
      case 'meeting_status':
        setMeeting((m) => ({ ...m, status: data.status }));
        break;
    }
  }, []);

  useEffect(() => {
    const es = new EventSource(`/api/meetings/${initial.meeting.id}/events`);
    es.onmessage = applyEvent;
    return () => es.close();
  }, [initial.meeting.id, applyEvent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // 离开页面兜底暂停：active 状态下关页/刷新时用 sendBeacon 打 pause，
  // 防止无人观看的会议在服务端重启后被 recoverActiveMeetings 复活空烧 token。
  // 注意：pagehide 在 bfcache（往返缓存）场景同样触发——用户"后退"回来时页面不重载，
  // 但会议已暂停，需要手动点"开始/继续"。这是刻意取舍：宁停勿烧，不是 bug。
  useEffect(() => {
    const onPageHide = () => {
      if (!shouldPauseOnPageHide(meeting.status)) return;
      navigator.sendBeacon(pauseBeaconUrl(meeting.id), '');
    };
    // bfcache 还原对齐：pagehide 时 beacon 已把服务端置 paused，但本地 state 冻结在 active，
    // 断线期间的 meeting_status 事件也收不回——persisted 还原时重拉一次会议状态收口。
    const onPageShow = (e: PageTransitionEvent) => {
      if (!shouldResyncOnPageShow(e.persisted)) return;
      fetch(`/api/meetings/${meeting.id}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { meeting?: typeof meeting } | null) => {
          if (data?.meeting) setMeeting((m) => ({ ...m, ...data.meeting }));
        })
        .catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [meeting.id, meeting.status]);

  const act = async (action: string) => {
    const res = await fetch(`/api/meetings/${meeting.id}/${action}`, { method: 'POST' });
    if (res.ok && action === 'pause') setMeeting((m) => ({ ...m, status: 'paused' }));
    if (res.ok && (action === 'start' || action === 'resume')) {
      setMeeting((m) => ({ ...m, status: 'active' }));
    }
    if (res.ok && action === 'end') setMeeting((m) => ({ ...m, status: 'ended' }));
  };

  const toggleMute = async (participantId: string, muted: boolean) => {
    const res = await fetch(`/api/meetings/${meeting.id}/participants/${participantId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted }),
    });
    if (!res.ok) return;
    setParticipants((ps) =>
      ps.map((p) => (p.id === participantId ? { ...p, muted } : p)),
    );
  };

  const sendChat = async (content: string) => {
    await fetch(`/api/meetings/${meeting.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  };

  const sendDm = async (participantId: string, content: string) => {
    await fetch(`/api/meetings/${meeting.id}/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId, content }),
    });
  };

  const dmParty = participants.find((p) => p.id === dmTarget);

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 overflow-y-auto border-r p-4">
        <h1 className="font-bold">{meeting.title}</h1>
        <p className="mt-1 text-xs text-gray-500">{meeting.topic}</p>
        <p className="mt-2 text-xs">状态：{meeting.status}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {meeting.status === 'paused' && (
            <button onClick={() => act('start')}
              className="rounded bg-green-600 px-3 py-1 text-xs text-white">
              开始/继续
            </button>
          )}
          {meeting.status === 'active' && (
            <button onClick={() => act('pause')} className="rounded bg-yellow-600 px-3 py-1 text-xs text-white">
              暂停
            </button>
          )}
          {meeting.status !== 'ended' && (
            <button onClick={() => setShowAdd(true)} className="rounded bg-gray-600 px-3 py-1 text-xs text-white">
              + 添加成员
            </button>
          )}
        </div>
        <div className="mt-4 space-y-2">
          {participants.map((p) => (
            <AgentCard
              key={p.id}
              participant={p}
              state={states[p.id] ?? { status: 'idle' }}
              canToggleMute={canToggleMute(meeting.status)}
              onDm={() => setDmTarget(p.id)}
              onToggleMute={() => toggleMute(p.id, !p.muted)}
            />
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {sseWarn && (
          <div className="shrink-0 border-b border-yellow-300 bg-yellow-50 px-4 py-1.5 text-xs text-yellow-800">
            ⚠ 收到 {sseWarn.count} 条无法解析的事件（最近：{sseWarn.lastReason}）。
            请刷新页面；若刷新后仍出现请反馈。其余消息不受影响。
          </div>
        )}
        <ChatPanel
          messages={messages.filter((m) => m.channel === 'chatroom')}
          participants={participants}
          onSend={sendChat}
          disabled={meeting.status === 'ended'}
          bottomRef={bottomRef}
        />
      </div>

      {dmParty && (
        <DmDrawer
          participant={dmParty}
          messages={messages.filter((m) => m.channel === 'dm' && m.participantId === dmParty.id)}
          onSend={(c) => sendDm(dmParty.id, c)}
          onClose={() => setDmTarget(null)}
          disabled={meeting.status === 'ended'}
        />
      )}

      {showAdd && (
        <AddMemberDialog meetingId={meeting.id} onClose={() => setShowAdd(false)} />
      )}
    </div>
  );
}
