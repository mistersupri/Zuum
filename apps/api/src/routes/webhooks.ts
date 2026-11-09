import type { FastifyInstance } from "fastify";
import { prisma } from "@zuum/db";
import { EgressStatus, TrackType, type WebhookEvent } from "livekit-server-sdk";
import { config } from "../config";
import { AppError } from "../lib/errors";
import { publish } from "../lib/events";
import { webhookReceiver } from "../lib/livekit";
import { outboxEvent } from "../lib/queue";
import { startTrackAsset } from "./controls";

const meetingByRoom = (roomName: string | undefined) =>
  roomName ? prisma.meeting.findUnique({ where: { livekitRoomName: roomName } }) : null;

export async function webhookRoutes(app: FastifyInstance) {
  // LiveKit signs the raw body; keep it as a string for verification.
  app.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/livekit", { config: { rateLimit: false } }, async (req, reply) => {
    let event: WebhookEvent;
    try {
      event = await webhookReceiver.receive(req.body as string, req.headers.authorization);
    } catch {
      throw new AppError(401, "WEBHOOK_SIGNATURE_INVALID", "Signature webhook tidak valid.");
    }

    // Idempotency: LiveKit retries deliveries; a seen event id is acknowledged and skipped.
    try {
      await prisma.webhookEvent.create({ data: { id: event.id, source: "livekit", event: event.event } });
    } catch {
      return reply.status(200).send({ duplicate: true });
    }

    await handle(event, app);
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    return { ok: true };
  });
}

async function handle(event: WebhookEvent, app: FastifyInstance) {
  const log = app.log;
  const meeting = await meetingByRoom(event.room?.name ?? event.egressInfo?.roomName);
  if (!meeting) return;

  switch (event.event) {
    case "participant_joined": {
      const identity = event.participant?.identity;
      if (!identity) return;
      await prisma.meetingParticipant.updateMany({
        where: { meetingId: meeting.id, identity, status: { notIn: ["REMOVED", "REJECTED"] } },
        data: { status: "JOINED", lastSeenAt: new Date(), leftAt: null },
      });
      return;
    }
    case "participant_left": {
      const identity = event.participant?.identity;
      if (!identity) return;
      const p = await prisma.meetingParticipant.findUnique({
        where: { meetingId_identity: { meetingId: meeting.id, identity } },
      });
      if (p && p.status === "JOINED") {
        await prisma.meetingParticipant.update({ where: { id: p.id }, data: { status: "LEFT", leftAt: new Date() } });
        await publish(meeting.id, "meeting.participant.left", "participants", {
          id: p.id,
          displayName: p.displayName,
          role: p.role,
          status: "LEFT",
          identity: p.identity,
        });
      }
      await prisma.participantTrack.updateMany({
        where: { participant: { meetingId: meeting.id, identity }, endedAt: null },
        data: { endedAt: new Date() },
      });
      return;
    }
    case "track_published": {
      const identity = event.participant?.identity;
      const track = event.track;
      if (!identity || !track) return;
      const p = await prisma.meetingParticipant.findUnique({
        where: { meetingId_identity: { meetingId: meeting.id, identity } },
      });
      if (!p) return;
      // room + participant identity + track SID mapping (PRD 4.8 step 2).
      await prisma.participantTrack.upsert({
        where: { participantId_trackSid: { participantId: p.id, trackSid: track.sid } },
        create: {
          participantId: p.id,
          trackSid: track.sid,
          trackType: track.type === TrackType.AUDIO ? "audio" : "video",
          source: String(track.source),
        },
        update: { endedAt: null },
      });
      if (track.type === TrackType.AUDIO && meeting.transcriptionEnabled && meeting.status === "LIVE") {
        await prisma.$transaction(async (tx) => {
          await outboxEvent(tx, "transcription.ensure-room", { meetingId: meeting.id, roomName: meeting.livekitRoomName });
        });
      }
      if (track.type === TrackType.AUDIO && meeting.recordingActive && config.RECORD_INDIVIDUAL_AUDIO) {
        await startTrackAsset(meeting.id, meeting.livekitRoomName, track.sid, identity, log);
      }
      return;
    }
    case "track_unpublished": {
      if (!event.track) return;
      await prisma.participantTrack.updateMany({
        where: { trackSid: event.track.sid, endedAt: null },
        data: { endedAt: new Date() },
      });
      return;
    }
    case "egress_started":
    case "egress_updated":
    case "egress_ended": {
      const info = event.egressInfo;
      if (!info) return;
      const asset = await prisma.meetingAsset.findUnique({ where: { externalId: info.egressId } });
      if (!asset) return;
      if (info.status === EgressStatus.EGRESS_COMPLETE) {
        const file = info.fileResults[0];
        await prisma.meetingAsset.update({
          where: { id: asset.id },
          data: {
            status: "READY",
            readyAt: new Date(),
            sizeBytes: file ? BigInt(file.size) : null,
            // LiveKit reports duration in nanoseconds.
            durationMs: file ? BigInt(file.duration) / 1_000_000n : null,
          },
        });
      } else if (
        info.status === EgressStatus.EGRESS_FAILED ||
        info.status === EgressStatus.EGRESS_ABORTED ||
        info.status === EgressStatus.EGRESS_LIMIT_REACHED
      ) {
        await prisma.meetingAsset.update({
          where: { id: asset.id },
          data: { status: "FAILED", errorCode: `EGRESS_${EgressStatus[info.status]}`, errorMessage: info.error || null },
        });
      } else if (info.status === EgressStatus.EGRESS_ACTIVE) {
        await prisma.meetingAsset.update({ where: { id: asset.id }, data: { status: "RECORDING" } });
      } else if (info.status === EgressStatus.EGRESS_ENDING) {
        await prisma.meetingAsset.update({ where: { id: asset.id }, data: { status: "PROCESSING" } });
      }
      await publish(meeting.id, "meeting.recording.updated", "hosts", { assetId: asset.id, status: EgressStatus[info.status] });
      return;
    }
    case "room_finished": {
      // Room closed without an explicit end (everyone left and the empty timeout passed).
      if (meeting.status === "LIVE") {
        log.info({ meetingId: meeting.id }, "room selesai, meeting tetap LIVE sampai host mengakhiri");
      }
      return;
    }
  }
}
