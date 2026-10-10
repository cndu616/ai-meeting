import { getEngine } from '@/core/engine-instance';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; participantId: string }> },
) {
  const { id, participantId } = await ctx.params;
  try {
    const { muted } = await req.json();
    const p = getEngine().setMuted(id, participantId, !!muted);
    return Response.json(p);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
