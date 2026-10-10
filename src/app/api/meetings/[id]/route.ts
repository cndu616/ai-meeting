import { getEngine } from '@/core/engine-instance';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const engine = getEngine();
    const meeting = engine.getMeeting(id);
    return Response.json({
      meeting,
      participants: engine.getParticipants(id),
      messages: engine.getMessages(id),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
