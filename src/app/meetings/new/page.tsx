'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface AgentInfo {
  id: string;
  name: string;
  capability: string;
  description: string;
  avatar: string;
}

export default function NewMeetingPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [maxRounds, setMaxRounds] = useState(3);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then(setAgents)
      .catch(() => setError('加载 agent 列表失败'));
  }, []);

  const toggle = (id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const submit = async () => {
    setError('');
    if (!title.trim()) return setError('请填写标题');
    if (!topic.trim()) return setError('请填写讨论话题');
    if (!workspacePath.trim()) return setError('请填写工作区路径');
    if (selected.length < 2) return setError('至少选择 2 个 agent');
    if (selected.some((id) => !roles[id]?.trim())) return setError('请为每个 agent 填写会议角色');
    setBusy(true);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, topic, workspacePath, maxRounds,
          participants: selected.map((id) => ({ agentId: id, meetingRole: roles[id] })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '创建失败');
      router.push(`/meetings/${data.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const input = 'w-full rounded border px-3 py-2 text-sm';

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-bold">新建会议</h1>

      <label className="mb-1 block text-sm font-medium">标题</label>
      <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} />

      <label className="mb-1 mt-4 block text-sm font-medium">讨论话题</label>
      <textarea className={input} rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} />

      <label className="mb-1 mt-4 block text-sm font-medium">工作区路径（agent 可读写此目录）</label>
      <input
        className={input}
        placeholder="C:/Users/you/project/example"
        value={workspacePath}
        onChange={(e) => setWorkspacePath(e.target.value)}
      />

      <label className="mb-1 mt-4 block text-sm font-medium">最大轮数</label>
      <input
        type="number" min={1} max={50} className={input}
        value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))}
      />

      <h2 className="mb-2 mt-6 font-semibold">选择参会 agent 并分配会议角色</h2>
      <div className="space-y-3">
        {agents.map((a) => {
          const on = selected.includes(a.id);
          return (
            <div key={a.id} className={`rounded border p-3 ${on ? 'border-blue-500' : ''}`}>
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={on} onChange={() => toggle(a.id)} />
                <span className="text-xl">{a.avatar}</span>
                <span className="font-medium">{a.name}</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{a.capability}</span>
                <span className="text-xs text-gray-500">{a.description}</span>
              </label>
              {on && (
                <input
                  className={`${input} mt-2`}
                  placeholder={`会议角色，如：激进派——主张……`}
                  value={roles[a.id] ?? ''}
                  onChange={(e) => setRoles({ ...roles, [a.id]: e.target.value })}
                />
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <button
        onClick={submit}
        disabled={busy}
        className="mt-6 rounded bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? '创建中…' : '创建会议'}
      </button>
    </main>
  );
}
