import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { connection } from 'next/server';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';

// 列表页实时读取数据库：await connection() 标记动态渲染（build 不做静态预生成，
// 运行时每次请求现读）。曾用 cacheComponents + instant=false 表达，因 Next 16.4.0
// 的 /_global-error 预渲染 bug 退出该模式（见 next.config.ts 注释）。

const statusLabel: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  ended: '已结束',
};

export default async function Home() {
  await connection();
  const db = getDb();
  importAgentsToDb(db, loadAgentFiles());
  const rows = db.select().from(meetings).orderBy(desc(meetings.createdAt)).all();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">AI 会议</h1>
        <Link
          href="/meetings/new"
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          新建会议
        </Link>
      </div>
      {rows.length === 0 && (
        <p className="text-gray-500">还没有会议，点右上角新建一场吧。</p>
      )}
      <ul className="space-y-3">
        {rows.map((m) => (
          <li key={m.id} className="rounded border p-4 hover:border-blue-400">
            <Link href={`/meetings/${m.id}`} className="block">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{m.title}</span>
                <span className="text-xs text-gray-500">{statusLabel[m.status]}</span>
              </div>
              <p className="mt-1 text-sm text-gray-600">{m.topic}</p>
              <p className="mt-1 text-xs text-gray-400">
                {new Date(m.createdAt).toLocaleString()}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
