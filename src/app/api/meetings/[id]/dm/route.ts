import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const { participantId, content } = await req.json();
    if (!content?.trim()) return Response.json({ error: '私信内容不能为空' }, { status: 400 });
    await getEngine().sendDm(id, String(participantId), String(content));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
