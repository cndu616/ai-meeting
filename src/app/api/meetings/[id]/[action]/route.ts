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
        engine.start(id); // 异步循环，不等待
        return Response.json({ ok: true });
      case 'pause':
        engine.pause(id);
        return Response.json({ ok: true });
      case 'resume':
        engine.resume(id);
        return Response.json({ ok: true });
      case 'end':
        engine.end(id);
        return Response.json({ ok: true });
      case 'extend': {
        const { rounds } = await req.json();
        engine.extendRounds(id, Number(rounds) || 1);
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: `未知操作 ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
