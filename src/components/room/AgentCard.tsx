import type { ParticipantView } from './types';

const stateLabel: Record<string, string> = {
  idle: '',
  thinking: '思考中…',
  tool: '使用工具中',
  speaking: '发言中…',
};

export default function AgentCard({
  participant,
  state,
  onDm,
}: {
  participant: ParticipantView;
  state: { status: string; detail?: string };
  onDm: () => void;
}) {
  const busy = state.status !== 'idle';
  return (
    <div className="rounded border p-2">
      <div className="flex items-center gap-2">
        <span className="text-lg">{participant.agent.avatar}</span>
        <span className="text-sm font-medium">{participant.agent.name}</span>
        <span className="rounded bg-gray-100 px-1.5 text-[10px]">{participant.agent.capability}</span>
        <button onClick={onDm} className="ml-auto text-[10px] text-blue-600 hover:underline">
          私聊
        </button>
      </div>
      <p className="mt-1 text-[11px] text-gray-600">{participant.meetingRole}</p>
      {busy && (
        <p className="mt-1 animate-pulse text-[11px] text-blue-600">
          {stateLabel[state.status]}
          {state.detail ? `（${state.detail}）` : ''}
        </p>
      )}
    </div>
  );
}
