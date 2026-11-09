import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@zuum/db";
import { TrackType } from "livekit-server-sdk";
import { config } from "../config";
import { authorize } from "../lib/access";
import { audit } from "../lib/audit";
import { AppError, Errors } from "../lib/errors";
import { publish } from "../lib/events";
import {
  egressClient,
  recordingStorageKey,
  roomService,
  startAudioTrackRecording,
  startCompositeRecording,
} from "../lib/livekit";
import { toJSON } from "../lib/serialize";

const params = z.object({ meetingId: z.string() });

export async function controlRoutes(app: FastifyInstance) {
  app.post("/meetings/:meetingId/participants/:participantId/mute", async (req) => {
    const { meetingId, participantId } = z.object({ meetingId: z.string(), participantId: z.string() }).parse(req.params);
    const a = await authorize(req, meetingId, "participant.mute");
    const p = await prisma.meetingParticipant.findFirst({ where: { id: participantId, meetingId } });
    if (!p) throw Errors.notFound("Peserta");
    const muted = await muteIdentity(a.meeting.livekitRoomName, p.identity);
    await audit(req, { action: "participant.mute", resource: "participant", resourceId: p.id, meetingId });
    return { muted };
  });

  app.post("/meetings/:meetingId/mute-all", async (req) => {
    const { meetingId } = params.parse(req.params);
    const a = await authorize(req, meetingId, "participant.mute");
    const lkParticipants = await roomService.listParticipants(a.meeting.livekitRoomName).catch(() => []);
    const self = a.participant?.identity;
    let muted = 0;
    for (const lp of lkParticipants) {
      if (lp.identity === self || lp.identity.startsWith("zuum-")) continue;
      muted += await muteIdentity(a.meeting.livekitRoomName, lp.identity);
    }
    await audit(req, { action: "participant.mute_all", resource: "meeting", resourceId: meetingId, meetingId });
    return { muted };
  });

  app.post("/meetings/:meetingId/lock", async (req) => {
    const { meetingId } = params.parse(req.params);
    await authorize(req, meetingId, "room.lock");
    await prisma.meeting.update({ where: { id: meetingId }, data: { locked: true } });
    await publish(meetingId, "meeting.locked", "participants", { locked: true });
    await audit(req, { action: "meeting.lock", resource: "meeting", resourceId: meetingId, meetingId });
    return { locked: true };
  });

  app.post("/meetings/:meetingId/unlock", async (req) => {
    const { meetingId } = params.parse(req.params);
    await authorize(req, meetingId, "room.lock");
    await prisma.meeting.update({ where: { id: meetingId }, data: { locked: false } });
    await publish(meetingId, "meeting.unlocked", "participants", { locked: false });
    await audit(req, { action: "meeting.unlock", resource: "meeting", resourceId: meetingId, meetingId });
    return { locked: false };
  });

  app.post("/meetings/:meetingId/recording/start", async (req) => {
    const { meetingId } = params.parse(req.params);
    const a = await authorize(req, meetingId, "recording.control");
    const m = a.meeting;
    if (!m.recordingEnabled) throw new AppError(409, "RECORDING_DISABLED", "Perekaman tidak diaktifkan untuk meeting ini.");
    if (m.status !== "LIVE") throw new AppError(409, "MEETING_NOT_LIVE", "Perekaman hanya dapat dimulai saat meeting berlangsung.");
    if (m.recordingActive) throw new AppError(409, "RECORDING_ACTIVE", "Perekaman sudah berjalan.");

    // Every participant sees the consent notice first (PRD 4.7, 11.2): the event goes out
    // before egress starts, and the indicator stays on until recording stops.
    await prisma.meeting.update({ where: { id: meetingId }, data: { recordingActive: true } });
    await publish(meetingId, "meeting.recording.started", "participants", {
      noticeVersion: config.CONSENT_NOTICE_VERSION,
      startedBy: a.participant?.displayName ?? null,
    });

    const storageKey = recordingStorageKey(meetingId, "composite", "mp4");
    const asset = await prisma.meetingAsset.create({
      data: { meetingId, type: "COMPOSITE_RECORDING", status: "QUEUED", storageKey, fileName: `${m.code}.mp4`, mimeType: "video/mp4" },
    });
    try {
      const info = await startCompositeRecording(m.livekitRoomName, storageKey);
      await prisma.meetingAsset.update({ where: { id: asset.id }, data: { externalId: info.egressId, status: "RECORDING" } });
    } catch (err) {
      req.log.error({ err }, "start composite egress gagal");
      await prisma.$transaction([
        prisma.meetingAsset.update({
          where: { id: asset.id },
          data: {
            status: "FAILED",
            errorCode: "EGRESS_UNAVAILABLE",
            errorMessage: "Layanan perekaman (LiveKit Egress) tidak dapat dihubungi.",
          },
        }),
        prisma.meeting.update({ where: { id: meetingId }, data: { recordingActive: false } }),
      ]);
      await publish(meetingId, "meeting.recording.stopped", "participants", { reason: "failed" });
      throw Errors.upstream(
        "RECORDING_START_FAILED",
        "Perekaman gagal dimulai karena layanan perekaman tidak tersedia. Periksa konfigurasi LiveKit Egress lalu coba lagi.",
      );
    }

    if (config.RECORD_INDIVIDUAL_AUDIO) await startIndividualAudio(meetingId, m.livekitRoomName, req.log);
    await audit(req, { action: "recording.start", resource: "meeting", resourceId: meetingId, meetingId });
    return { recording: true, assetId: asset.id };
  });

  app.post("/meetings/:meetingId/recording/stop", async (req) => {
    const { meetingId } = params.parse(req.params);
    const a = await authorize(req, meetingId, "recording.control");
    const active = await prisma.meetingAsset.findMany({
      where: { meetingId, status: { in: ["QUEUED", "RECORDING"] }, externalId: { not: null } },
    });
    for (const asset of active) {
      await egressClient.stopEgress(asset.externalId!).catch((err) => req.log.warn({ err }, "stop egress gagal"));
      await prisma.meetingAsset.update({ where: { id: asset.id }, data: { status: "PROCESSING" } });
    }
    await prisma.meeting.update({ where: { id: a.meeting.id }, data: { recordingActive: false } });
    await publish(meetingId, "meeting.recording.stopped", "participants", { reason: "host" });
    await audit(req, { action: "recording.stop", resource: "meeting", resourceId: meetingId, meetingId });
    return { recording: false };
  });
}

async function muteIdentity(roomName: string, identity: string) {
  const lp = await roomService.getParticipant(roomName, identity).catch(() => null);
  if (!lp) return 0;
  let count = 0;
  for (const t of lp.tracks) {
    if (t.type === TrackType.AUDIO && !t.muted) {
      await roomService.mutePublishedTrack(roomName, identity, t.sid, true);
      count++;
    }
  }
  return count;
}

export async function startIndividualAudio(meetingId: string, roomName: string, log: { warn: (o: object, m: string) => void }) {
  const lkParticipants = await roomService.listParticipants(roomName).catch(() => []);
  for (const lp of lkParticipants) {
    for (const t of lp.tracks) {
      if (t.type !== TrackType.AUDIO) continue;
      await startTrackAsset(meetingId, roomName, t.sid, lp.identity, log);
    }
  }
}

export async function startTrackAsset(
  meetingId: string,
  roomName: string,
  trackSid: string,
  identity: string,
  log: { warn: (o: object, m: string) => void },
) {
  const exists = await prisma.meetingAsset.findFirst({
    where: { meetingId, type: "AUDIO_TRACK", status: { in: ["QUEUED", "RECORDING"] }, metadata: { path: ["trackSid"], equals: trackSid } },
  });
  if (exists) return;
  const storageKey = recordingStorageKey(meetingId, `audio-${identity}`, "ogg");
  const asset = await prisma.meetingAsset.create({
    data: { meetingId, type: "AUDIO_TRACK", storageKey, mimeType: "audio/ogg", metadata: { trackSid, identity } },
  });
  try {
    const info = await startAudioTrackRecording(roomName, trackSid, storageKey);
    await prisma.meetingAsset.update({ where: { id: asset.id }, data: { externalId: info.egressId, status: "RECORDING" } });
  } catch (err) {
    log.warn({ err, trackSid }, "track egress gagal");
    await prisma.meetingAsset.update({
      where: { id: asset.id },
      data: { status: "FAILED", errorCode: "EGRESS_UNAVAILABLE", errorMessage: "Rekaman audio per peserta gagal dimulai." },
    });
  }
}

export const assetJSON = toJSON;
