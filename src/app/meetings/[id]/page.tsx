// src/app/meetings/[id]/page.tsx
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { getEngine } from '@/core/engine-instance';
import Room, { type RoomData } from '@/components/room/Room';

export const instant = false;

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const engine = getEngine();
  let data: RoomData;
  try {
    const meeting = engine.getMeeting(id);
    const participants = engine.getParticipants(id);
    const messages = engine.getMessages(id);
    const templates = getDb().select().from(agents).all();
    const tMap = new Map(templates.map((t) => [t.id, t]));
    data = {
      meeting,
      participants: participants.map((p) => {
        const t = tMap.get(p.templateId);
        return {
          id: p.id,
          templateId: p.templateId,
          displayName: p.displayName,
          goal: p.goal,
          muted: !!p.muted,
          speakOrder: p.speakOrder,
          capability: t?.capability ?? '',
          avatar: t?.avatar ?? '🤖',
        };
      }),
      messages,
    };
  } catch {
    return notFound();
  }
  return <Room initial={data} />;
}
