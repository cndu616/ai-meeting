import { describe, it, expect, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { runAgentTurn } from '@/core/agent-runner';

function fakeStream(msgs: unknown[]) {
  return (async function* () {
    for (const m of msgs) yield m;
  })();
}

describe('runAgentTurn', () => {
  it('返回最终发言、会话 id 与工具活动；透传 resume 与 cwd', async () => {
    queryMock.mockReturnValue(fakeStream([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] },
      },
      { type: 'result', subtype: 'success', result: '我认为可行', session_id: 'sess-1' },
    ]));

    const out = await runAgentTurn({
      systemPrompt: 'sp', workspacePath: 'C:/ws', prompt: 'p', resumeSessionId: 'old',
    });

    expect(out.speech).toBe('我认为可行');
    expect(out.sessionId).toBe('sess-1');
    expect(out.toolActivities).toEqual([{ tool: 'Read', detail: 'src/a.ts' }]);

    const arg = queryMock.mock.calls[0][0];
    expect(arg.options.cwd).toBe('C:/ws');
    expect(arg.options.resume).toBe('old');
    expect(arg.options.permissionMode).toBe('bypassPermissions');
  });

  it('result 非 success 或无文本时 speech 为空', async () => {
    queryMock.mockReturnValue(fakeStream([
      { type: 'result', subtype: 'error_max_turns', result: '', session_id: 's' },
    ]));
    const out = await runAgentTurn({ systemPrompt: 's', workspacePath: '/w', prompt: 'p' });
    expect(out.speech).toBe('');
  });
});
