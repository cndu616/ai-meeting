'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import AgentCard from './AgentCard';
import ChatPanel from './ChatPanel';
import DmDrawer from './DmDrawer';
import type { ParticipantView, RoomData, AgentState } from './types';

export type { ParticipantView, RoomData } from './types';

export default function Room({ initial }: { initial: RoomData }) {
  const [meeting, setMeeting] = useState(initial.meeting);
  const [messages, setMessages] = useState(initial.messages);
  const [states, setStates] = useState<Record<string, { status: AgentState; detail?: string }>>({});
  const [dmTarget, setDmTarget] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const applyEvent = useCallback((e: MessageEvent) => {
    const data = JSON.parse(e.data);
    if (data.type === 'message') {
      setMessages((ms) =>
        ms.some((m) => m.id === data.message.id) ? ms : [...ms, data.message],
      );
    } else if (data.type === 'agent_status') {
      setStates((s) => ({
        ...s,
        [data.agentId]: { status: data.status, detail: data.detail },
      }));
    } else if (data.type === 'meeting_status') {
      setMeeting((m) => ({ ...m, status: data.status }));
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

  const refreshMeeting = async () => {
    const res = await fetch(`/api/meetings/${meeting.id}`);
    const d = await res.json();
    if (d.meeting) setMeeting(d.meeting);
  };

  const act = async (action: string, body?: object) => {
    await fetch(`/api/meetings/${meeting.id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (action === 'start' || action === 'resume') {
      setMeeting((m) => ({ ...m, status: 'active' }));
    } else {
      await refreshMeeting();
    }
  };

  const sendChat = async (content: string) => {
    await fetch(`/api/meetings/${meeting.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  };

  const sendDm = async (agentId: string, content: string) => {
    await fetch(`/api/meetings/${meeting.id}/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, content }),
    });
  };

  const dmAgent = initial.participants.find((p) => p.agentId === dmTarget);

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 overflow-y-auto border-r p-4">
        <h1 className="font-bold">{meeting.title}</h1>
        <p className="mt-1 text-xs text-gray-500">{meeting.topic}</p>
        <p className="mt-2 text-xs">
          状态：{meeting.status} · 轮次 {meeting.currentRound}/{meeting.maxRounds}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {meeting.status === 'paused' && (
            <button onClick={() => act('start')} className="rounded bg-green-600 px-3 py-1 text-xs text-white">
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
          {meeting.status === 'paused' && (
            <button onClick={() => act('extend', { rounds: 3 })} className="rounded bg-gray-600 px-3 py-1 text-xs text-white">
              +3 轮
            </button>
          )}
        </div>
        <div className="mt-4 space-y-2">
          {initial.participants.map((p) => (
            <AgentCard
              key={p.agentId}
              participant={p}
              state={states[p.agentId] ?? { status: 'idle' }}
              onDm={() => setDmTarget(p.agentId)}
            />
          ))}
        </div>
      </aside>

      <ChatPanel
        messages={messages.filter((m) => m.channel === 'chatroom')}
        participants={initial.participants}
        onSend={sendChat}
        disabled={meeting.status === 'ended'}
        bottomRef={bottomRef}
      />

      {dmAgent && (
        <DmDrawer
          participant={dmAgent}
          messages={messages.filter((m) => m.channel === 'dm' && m.agentId === dmAgent.agentId)}
          onSend={(c) => sendDm(dmAgent.agentId, c)}
          onClose={() => setDmTarget(null)}
          disabled={meeting.status === 'ended'}
        />
      )}
    </div>
  );
}
