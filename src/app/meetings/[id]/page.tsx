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
    const agentRows = getDb().select().from(agents).all();
    const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));
    data = {
      meeting,
      participants: participants.map((p) => ({
        id: p.id,
        agentId: p.agentId,
        meetingRole: p.meetingRole,
        agent: agentMap[p.agentId],
      })),
      messages,
    };
  } catch {
    notFound();
  }
  return <Room initial={data} />;
}
