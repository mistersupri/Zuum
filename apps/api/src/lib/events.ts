import { randomUUID } from "node:crypto";
import { redisChannelForMeeting, type EventAudience, type RealtimeEvent, type RealtimeEventType } from "@zuum/shared";
import { redis } from "./redis";

/**
 * Publishes a realtime event through Redis so every API instance can forward it
 * to its own SSE connections. `version` defaults to the publish time in ms,
 * which is monotonic enough for clients to drop stale state updates.
 */
export async function publish<P>(
  meetingId: string,
  type: RealtimeEventType,
  audience: EventAudience,
  payload: P,
  version = Date.now(),
) {
  const event: RealtimeEvent<P> = {
    eventId: randomUUID(),
    type,
    meetingId,
    occurredAt: new Date().toISOString(),
    version,
    audience,
    payload,
  };
  await redis.publish(redisChannelForMeeting(meetingId), JSON.stringify(event));
  return event;
}
