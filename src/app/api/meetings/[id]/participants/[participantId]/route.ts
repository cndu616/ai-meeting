import { getEngine } from '@/core/engine-instance';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; participantId: string }> },
) {
  const { id, participantId } = await ctx.params;
  try {
    const { muted } = await req.json();
    if (typeof muted !== 'boolean') return Response.json({ error: 'muted 须为 boolean' }, { status: 400 });
    const p = getEngine().setMuted(id, participantId, muted);
    return Response.json(getEngine().participantInfo(p));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
