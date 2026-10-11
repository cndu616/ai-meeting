import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  const engine = getEngine();
  try {
    switch (action) {
      case 'start':
        engine.start(id);
        return Response.json({ ok: true });
      case 'pause':
        await engine.pause(id);
        return Response.json({ ok: true });
      case 'resume':
        await engine.resume(id);
        return Response.json({ ok: true });
      case 'end':
        await engine.end(id);
        return Response.json({ ok: true });
      default:
        return Response.json({ error: `未知操作 ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
