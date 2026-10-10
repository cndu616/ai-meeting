import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const { agentId, content } = await req.json();
    await getEngine().sendDm(id, String(agentId), String(content));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
