// src/components/room/AgentCard.tsx
import type { ParticipantView, AgentStatus } from './types';

const stateLabel: Record<string, string> = {
  idle: '',
  thinking: '思考中…',
  tool: '使用工具中',
  speaking: '发言中…',
  offline: '掉线',
};

export default function AgentCard({
  participant,
  state,
  meetingActive,
  onDm,
  onToggleMute,
}: {
  participant: ParticipantView;
  state: { status: AgentStatus; detail?: string };
  meetingActive: boolean;
  onDm: () => void;
  onToggleMute: () => void;
}) {
  const busy = state.status !== 'idle' && state.status !== 'offline';
  return (
    <div className={`rounded border p-2 ${participant.muted ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="text-lg">{participant.avatar}</span>
        <span className="text-sm font-medium">{participant.displayName}</span>
        <span className="rounded bg-gray-100 px-1.5 text-[10px]">{participant.capability}</span>
        <div className="ml-auto flex gap-1.5">
          <button onClick={onDm} className="text-[10px] text-blue-600 hover:underline">
            私聊
          </button>
          {meetingActive && (
            <button
              onClick={onToggleMute}
              className={`text-[10px] hover:underline ${participant.muted ? 'text-red-600' : 'text-gray-500'}`}
            >
              {participant.muted ? '解除禁言' : '禁言'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-gray-600">{participant.goal}</p>
      {participant.muted && (
        <p className="mt-1 text-[11px] text-red-500">已被主持人禁言</p>
      )}
      {(busy || state.status === 'offline') && (
        <p className={`mt-1 animate-pulse text-[11px] ${state.status === 'offline' ? 'text-red-500' : 'text-blue-600'}`}>
          {stateLabel[state.status]}
          {state.detail ? `（${state.detail}）` : ''}
        </p>
      )}
    </div>
  );
}
