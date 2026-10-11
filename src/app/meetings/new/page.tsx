// src/app/meetings/new/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface TemplateInfo {
  id: string;
  capability: string;
  description: string;
  avatar: string;
}

interface MemberDraft {
  key: number;
  templateId: string;
  displayName: string;
  goal: string;
}

export default function NewMeetingPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((list: TemplateInfo[]) => {
        setTemplates(list);
        if (list[0]) {
          setMembers([
            { key: 1, templateId: list[0].id, displayName: '', goal: '' },
            { key: 2, templateId: list[1]?.id ?? list[0].id, displayName: '', goal: '' },
          ]);
        }
      })
      .catch(() => setError('加载模板列表失败'));
  }, []);

  const update = (key: number, patch: Partial<MemberDraft>) => {
    setMembers((ms) => ms.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  };
  const add = () => {
    setMembers((ms) => [
      ...ms,
      { key: Date.now(), templateId: templates[0]?.id ?? '', displayName: '', goal: '' },
    ]);
  };
  const remove = (key: number) => {
    setMembers((ms) => ms.filter((m) => m.key !== key));
  };

  const submit = async () => {
    setError('');
    if (!title.trim()) return setError('请填写标题');
    if (!topic.trim()) return setError('请填写讨论话题');
    if (!workspacePath.trim()) return setError('请填写工作区路径');
    if (members.length < 2) return setError('至少 2 个成员');
    if (members.some((m) => !m.displayName.trim() || !m.goal.trim())) {
      return setError('请为每个成员填写名字与会议目标');
    }
    setBusy(true);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, topic, workspacePath,
          participants: members.map((m) => ({
            templateId: m.templateId, displayName: m.displayName, goal: m.goal,
          })),
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

      <label className="mb-1 mt-4 block text-sm font-medium">工作区路径（成员可读写此目录）</label>
      <input className={input} placeholder="C:/Users/you/project/example"
        value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} />

      <h2 className="mb-2 mt-6 font-semibold">参会成员（选模板、起名字、定目标）</h2>
      <div className="space-y-3">
        {members.map((m) => (
          <div key={m.key} className="rounded border p-3">
            <div className="flex gap-2">
              <select className={input} value={m.templateId}
                onChange={(e) => update(m.key, { templateId: e.target.value })}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.avatar} {t.capability}
                  </option>
                ))}
              </select>
              <input className={input} placeholder="名字，如：张工"
                value={m.displayName} onChange={(e) => update(m.key, { displayName: e.target.value })} />
              {members.length > 2 && (
                <button onClick={() => remove(m.key)}
                  className="shrink-0 rounded border px-3 text-xs text-red-600">
                  移除
                </button>
              )}
            </div>
            <input className={`${input} mt-2`} placeholder="会议目标，如：激进派——主张全面重写"
              value={m.goal} onChange={(e) => update(m.key, { goal: e.target.value })} />
          </div>
        ))}
      </div>
      {members.length < 8 && (
        <button onClick={add} className="mt-2 rounded border px-4 py-1.5 text-sm">
          + 添加成员
        </button>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <button onClick={submit} disabled={busy}
        className="mt-6 rounded bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? '创建中…' : '创建会议'}
      </button>
    </main>
  );
}
