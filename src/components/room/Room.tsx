// src/components/room/Room.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import AgentCard from './AgentCard';
import ChatPanel from './ChatPanel';
import DmDrawer from './DmDrawer';
import AddMemberDialog from './AddMemberDialog';
import type { RoomData, AgentStatus } from './types';
import type { MeetingEvent } from '@/lib/events';

export type { ParticipantView, RoomData } from './types';

export default function Room({ initial }: { initial: RoomData }) {
  const [meeting, setMeeting] = useState(initial.meeting);
  const [participants, setParticipants] = useState(initial.participants);
  const [messages, setMessages] = useState(initial.messages);
  const [states, setStates] = useState<Record<string, { status: AgentStatus; detail?: string }>>({});
  const [dmTarget, setDmTarget] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const applyEvent = useCallback((e: MessageEvent) => {
    const data = JSON.parse(e.data) as MeetingEvent;
    switch (data.type) {
      case 'message':
        setMessages((ms) =>
          ms.some((m) => m.id === data.message.id) ? ms : [...ms, data.message],
        );
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
            <button onClick={() => act('end')} className="rounded bg-red-600 px-3 py-1 text-xs text-white">
              结束
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
              meetingActive={meeting.status === 'active'}
              onDm={() => setDmTarget(p.id)}
              onToggleMute={() => toggleMute(p.id, !p.muted)}
            />
          ))}
        </div>
      </aside>

      <ChatPanel
        messages={messages.filter((m) => m.channel === 'chatroom')}
        participants={participants}
        onSend={sendChat}
        disabled={meeting.status === 'ended'}
        bottomRef={bottomRef}
      />

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
