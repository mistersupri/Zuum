import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { can, isModerator, type RealtimeEvent, type Role } from "@zuum/shared";
import { prisma } from "@zuum/db";
import { policyOf, resolveActor } from "../lib/access";
import { redisSub } from "../lib/redis";

interface Connection {
  res: ServerResponse;
  participantId: string | null;
  role: Role;
  canSeeTranscript: boolean;
}

// meetingId -> open SSE connections on this API instance.
const connections = new Map<string, Set<Connection>>();

function deliverable(conn: Connection, ev: RealtimeEvent) {
  const aud = ev.audience;
  if (typeof aud === "object") return aud.participantId === conn.participantId;
  if (aud === "hosts") return isModerator(conn.role);
  if (aud === "transcript") return conn.canSeeTranscript;
  return true;
}

/** One Redis subscription per instance fans events out to local SSE clients. */
export async function startEventHub(log: FastifyBaseLogger) {
  await redisSub.psubscribe("zuum:meeting:*");
  redisSub.on("pmessage", (_pattern, _channel, message) => {
    let ev: RealtimeEvent;
    try {
      ev = JSON.parse(message);
    } catch {
      return;
    }
    const set = connections.get(ev.meetingId);
    if (!set) return;
    // Settings may change mid-meeting; refresh transcript visibility on status events.
    const line = `id: ${ev.eventId}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const conn of set) {
      if (deliverable(conn, ev)) conn.res.write(line);
    }
  });
  log.info("realtime event hub aktif");
}

export async function streamRoutes(app: FastifyInstance) {
  /**
   * Server-Sent Events stream for meeting + transcript updates (PRD 9.4, 10).
   * The client reads it with fetch() so the bearer token stays in a header, not the URL.
   */
  app.get("/meetings/:meetingId/events", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await resolveActor(req, meetingId);
    const conn: Connection = {
      res: reply.raw,
      participantId: a.participant?.id ?? null,
      role: a.role,
      canSeeTranscript: can(a.role, "transcript.viewLive", policyOf(a.meeting)),
    };

    reply.hijack();
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {}),
    });
    reply.raw.write(`retry: 3000\nevent: ready\ndata: {}\n\n`);

    let set = connections.get(meetingId);
    if (!set) connections.set(meetingId, (set = new Set()));
    set.add(conn);

    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
      if (conn.participantId) {
        prisma.meetingParticipant
          .update({ where: { id: conn.participantId }, data: { lastSeenAt: new Date() } })
          .catch(() => undefined);
      }
    }, 20_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      set!.delete(conn);
      if (set!.size === 0) connections.delete(meetingId);
    });
  });

  // Alias that matches the PRD endpoint name; same stream.
  app.get("/meetings/:meetingId/transcript/stream", async (req, reply) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    return reply.redirect(`/api/v1/meetings/${meetingId}/events`, 307);
  });
}
