import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@zuum/db";
import { authorize } from "../lib/access";
import { AppError } from "../lib/errors";
import { publish } from "../lib/events";

const view = (m: { id: string; body: string; createdAt: Date; participantId: string; participant: { displayName: string } }) => ({
  id: m.id,
  body: m.body,
  createdAt: m.createdAt,
  participantId: m.participantId,
  senderName: m.participant.displayName,
});

export async function chatRoutes(app: FastifyInstance) {
  app.get("/meetings/:meetingId/chat", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    // Any admitted participant may read the chat of a meeting they attended.
    await authorize(req, meetingId, "media.muteSelf");
    const items = await prisma.chatMessage.findMany({
      where: { meetingId },
      orderBy: { createdAt: "asc" },
      take: 500,
      include: { participant: { select: { displayName: true } } },
    });
    return { items: items.map(view) };
  });

  // Messages are stored as plain text and rendered as text by the client (no HTML), which is the XSS guard.
  app.post("/meetings/:meetingId/chat", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await authorize(req, meetingId, "media.muteSelf");
    if (a.meeting.status !== "LIVE") throw new AppError(409, "MEETING_NOT_LIVE", "Chat hanya tersedia saat meeting berlangsung.");
    if (!a.participant) throw new AppError(403, "NOT_PARTICIPANT", "Bergabung ke meeting terlebih dahulu.");
    const { body } = z.object({ body: z.string().trim().min(1, "Pesan kosong.").max(2000) }).parse(req.body);
    const msg = await prisma.chatMessage.create({
      data: { meetingId, participantId: a.participant.id, body },
      include: { participant: { select: { displayName: true } } },
    });
    await publish(meetingId, "meeting.chat.message", "participants", view(msg));
    return reply.status(201).send({ message: view(msg) });
  });
}
