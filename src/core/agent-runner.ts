import { query } from '@anthropic-ai/claude-agent-sdk';

export interface TurnInput {
  systemPrompt: string;
  workspacePath: string;
  prompt: string;
  resumeSessionId?: string;
}

export interface ToolActivity {
  tool: string;
  detail: string;
}

export interface TurnResult {
  speech: string;
  sessionId: string;
  toolActivities: ToolActivity[];
}

function describeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const v =
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v === undefined ? '' : String(v);
}

export async function runAgentTurn(input: TurnInput): Promise<TurnResult> {
  const q = query({
    prompt: input.prompt,
    options: {
      systemPrompt: input.systemPrompt,
      cwd: input.workspacePath,
      permissionMode: 'bypassPermissions',
      resume: input.resumeSessionId,
      maxTurns: 40,
    },
  });

  let speech = '';
  let sessionId = input.resumeSessionId ?? '';
  const toolActivities: ToolActivity[] = [];

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          toolActivities.push({
            tool: block.name,
            detail: describeToolInput(block.input as Record<string, unknown>),
          });
        }
      }
    } else if (msg.type === 'result' && msg.subtype === 'success') {
      speech = msg.result;
      sessionId = msg.session_id;
    }
  }
  return { speech, sessionId, toolActivities };
}
