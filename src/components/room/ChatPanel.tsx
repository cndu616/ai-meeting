import { useState, type RefObject } from 'react';
import type { MessageRow } from '@/db/schema';
import type { ParticipantView } from './types';

export default function ChatPanel({
  messages,
  participants,
  onSend,
  disabled,
  bottomRef,
}: {
  messages: MessageRow[];
  participants: ParticipantView[];
  onSend: (content: string) => void;
  disabled: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
}) {
  const [text, setText] = useState('');
  const byAgent = new Map(participants.map((p) => [p.agentId, p]));

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };

  return (
    <section className="flex flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => {
          if (m.kind === 'system') {
            return (
              <p key={m.id} className="whitespace-pre-wrap text-center text-xs text-gray-400">{m.content}</p>
            );
          }
          if (m.kind === 'user') {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[70%] whitespace-pre-wrap rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">
                  {m.content}
                </div>
              </div>
            );
          }
          const p = m.agentId ? byAgent.get(m.agentId) : undefined;
          return (
            <div key={m.id} className="flex gap-2">
              <span className="text-xl">{p?.agent.avatar ?? '🤖'}</span>
              <div>
                <p className="text-xs text-gray-500">
                  {p?.agent.name ?? '未知'} · {p?.agent.capability}
                  {m.round != null && ` · 第 ${m.round} 轮`}
                </p>
                <div className="mt-0.5 max-w-[85%] whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-sm">
                  {m.content}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 border-t p-3">
        <input
          className="flex-1 rounded border px-3 py-2 text-sm"
          placeholder={disabled ? '会议已结束' : '以参会者身份发言…'}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button
          onClick={send}
          disabled={disabled}
          className="rounded bg-blue-600 px-4 text-sm text-white disabled:opacity-50"
        >
          发送
        </button>
      </div>
    </section>
  );
}
