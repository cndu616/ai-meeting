// src/components/room/AddMemberDialog.tsx
'use client';

import { useEffect, useState } from 'react';

interface TemplateInfo {
  id: string;
  capability: string;
  description: string;
  avatar: string;
}

export default function AddMemberDialog({
  meetingId,
  onClose,
}: {
  meetingId: string;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((list: TemplateInfo[]) => {
        setTemplates(list);
        if (list[0]) setTemplateId(list[0].id);
      })
      .catch(() => setError('加载模板失败'));
  }, []);

  const submit = async () => {
    setError('');
    if (!displayName.trim()) return setError('请填写名字');
    if (!goal.trim()) return setError('请填写会议目标');
    setBusy(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, displayName, goal }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '添加失败');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const input = 'w-full rounded border px-3 py-2 text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={busy ? undefined : onClose}>
      <div className="w-96 rounded-lg bg-white p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 font-semibold">添加成员</h3>

        <label className="mb-1 block text-sm">角色模板</label>
        <select className={input} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.avatar} {t.capability}——{t.description}
            </option>
          ))}
        </select>

        <label className="mb-1 mt-3 block text-sm">名字</label>
        <input className={input} placeholder="如：张工" value={displayName}
          onChange={(e) => setDisplayName(e.target.value)} />

        <label className="mb-1 mt-3 block text-sm">会议目标（立场/任务）</label>
        <input className={input} placeholder="如：激进派——主张全面重写" value={goal}
          onChange={(e) => setGoal(e.target.value)} />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="rounded border px-4 py-1.5 text-sm disabled:opacity-50">取消</button>
          <button onClick={submit} disabled={busy}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">
            {busy ? '添加中…' : '加入会议'}
          </button>
        </div>
      </div>
    </div>
  );
}
