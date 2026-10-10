import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const { content } = await req.json();
    const msg = getEngine().sendUserMessage(id, String(content));
    return Response.json(msg);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
