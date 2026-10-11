// src/core/session-factory.ts
import { AgentSession, type AgentSessionCallbacks, type QueryFactory } from './agent-session';
import { query } from '@anthropic-ai/claude-agent-sdk';

/** engine 依赖的最小会话接口（测试用 FakeSession 替换） */
export interface AgentSessionLike {
  start(): void;
  push(text: string, kind?: 'chatroom' | 'dm'): void;
  close(): Promise<void>;
}

export interface SessionCreateOptions {
  systemPrompt: string;
  cwd: string;
  resumeSessionId?: string;
  callbacks: AgentSessionCallbacks;
}

export interface SessionFactory {
  create(opts: SessionCreateOptions): AgentSessionLike;
}

const sdkQueryFactory: QueryFactory = ({ prompt, options }) =>
  query({ prompt, options });

export const defaultSessionFactory: SessionFactory = {
  create: (opts) =>
    new AgentSession({ ...opts, queryFactory: sdkQueryFactory }),
};
