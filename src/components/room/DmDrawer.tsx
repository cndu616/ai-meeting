import { useEffect, useRef, useState } from 'react';
import type { MessageRow } from '@/db/schema';
import type { ParticipantView } from './types';

export default function DmDrawer({
  participant,
  messages,
  onSend,
  onClose,
  disabled,
}: {
  participant: ParticipantView;
  messages: MessageRow[];
  onSend: (content: string) => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l">
      <div className="flex items-center justify-between border-b p-3">
        <span className="text-sm font-medium">
          {participant.avatar} 与 {participant.displayName} 私聊
        </span>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800">关闭</button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.map((m) => {
          const mine = m.kind === 'dm_user';
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : ''}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  mine ? 'bg-blue-600 text-white' : 'bg-gray-100'
                }`}
              >
                {m.content}
              </div>
            </div>
          );
        })}
        <div ref={ref} />
      </div>
      <div className="flex gap-2 border-t p-2">
        <input
          className="flex-1 rounded border px-2 py-1.5 text-sm"
          placeholder={disabled ? '会议已结束' : '私信…'}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button
          onClick={send}
          disabled={disabled}
          className="rounded bg-blue-600 px-3 text-sm text-white disabled:opacity-50"
        >
          发送
        </button>
      </div>
    </aside>
  );
}
