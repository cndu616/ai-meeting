import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const p = getEngine().addParticipant(id, {
      templateId: String(body.templateId),
      displayName: String(body.displayName ?? ''),
      goal: String(body.goal ?? ''),
    });
    return Response.json(p, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
