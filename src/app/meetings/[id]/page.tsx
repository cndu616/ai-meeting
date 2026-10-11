// src/app/meetings/[id]/page.tsx
import { notFound } from 'next/navigation';
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
    data = {
      meeting: engine.getMeeting(id),
      participants: engine.getParticipants(id).map((p) => engine.participantInfo(p)),
      messages: engine.getMessages(id),
    };
  } catch {
    return notFound();
  }
  return <Room initial={data} />;
}
