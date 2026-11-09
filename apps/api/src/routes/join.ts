import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Meeting, type MeetingParticipant } from "@zuum/db";
import { can, isHostRole, isModerator, type Role } from "@zuum/shared";
import { config } from "../config";
import { authorize, policyOf, resolveActor } from "../lib/access";
import { audit } from "../lib/audit";
import { identityFor, verifyPassword } from "../lib/crypto";
import { Errors } from "../lib/errors";
import { publish } from "../lib/events";
import { signGuestToken } from "../lib/jwt";
import { issueLivekitToken, roomService } from "../lib/livekit";
import { findUsableInvitation, startMeeting } from "./meetings";

const joinBody = z.object({
  displayName: z.string().trim().min(2, "Nama tampilan minimal 2 karakter.").max(60).optional(),
  invitationToken: z.string().min(20).max(100).optional(),
  passcode: z.string().max(64).optional(),
  consent: z
    .object({ recording: z.boolean(), transcription: z.boolean(), noticeVersion: z.string().max(40) })
    .optional(),
});

const participantView = (p: MeetingParticipant) => ({
  id: p.id,
  displayName: p.displayName,
  role: p.role,
  status: p.status,
  isGuest: p.isGuest,
  identity: p.identity,
  joinedAt: p.joinedAt,
});

async function recordConsent(meeting: Meeting, participant: MeetingParticipant, consent: z.infer<typeof joinBody>["consent"], source: string) {
  const needs = { recording: meeting.recordingEnabled, transcription: meeting.transcriptionEnabled };
  if (!needs.recording && !needs.transcription) return;
  // Already consented (e.g. reconnect or page reload): no need to ask again.
  if ((!needs.recording || participant.consentRecording) && (!needs.transcription || participant.consentTranscript)) return;
  // MVP policy (PRD 11.2): a meeting that may be recorded/transcribed requires consent to enter.
  // Declining means the participant does not join; organizations can relax this later.
  if (!consent) throw Errors.consentRequired();
  if ((needs.recording && !consent.recording) || (needs.transcription && !consent.transcription)) {
    await prisma.consentEvent.createMany({
      data: [
        ...(needs.recording ? [{ type: "RECORDING" as const, granted: consent.recording }] : []),
        ...(needs.transcription ? [{ type: "TRANSCRIPTION" as const, granted: consent.transcription }] : []),
      ].map((c) => ({ ...c, meetingId: meeting.id, participantId: participant.id, noticeVersion: consent.noticeVersion, source })),
    });
    throw Errors.consentRequired();
  }
  await prisma.$transaction([
    prisma.consentEvent.createMany({
      data: [
        ...(needs.recording ? [{ type: "RECORDING" as const }] : []),
        ...(needs.transcription ? [{ type: "TRANSCRIPTION" as const }] : []),
      ].map((c) => ({
        ...c,
        granted: true,
        meetingId: meeting.id,
        participantId: participant.id,
        noticeVersion: consent.noticeVersion,
        source,
      })),
    }),
    prisma.meetingParticipant.update({
      where: { id: participant.id },
      data: { consentRecording: needs.recording, consentTranscript: needs.transcription },
    }),
  ]);
}

export async function joinRoutes(app: FastifyInstance) {
  /**
   * Validates the join and returns a LiveKit token (PRD 4.4, 6.1).
   * Checks: meeting status, invitation, passcode, lock, capacity, removed/rejected, consent, waiting room.
   */
  app.post("/meetings/:meetingId/join", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const body = joinBody.parse(req.body ?? {});
    const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
    if (!meeting) throw Errors.notFound("Meeting");
    if (meeting.status === "ENDED" || meeting.status === "CANCELLED") throw Errors.meetingEnded();

    let participant: MeetingParticipant | null = null;
    let role: Role;
    let viaInvitation: Awaited<ReturnType<typeof findUsableInvitation>> | null = null;
    const actor = req.actor;

    if (body.invitationToken) {
      viaInvitation = await findUsableInvitation(body.invitationToken);
      if (viaInvitation.meetingId !== meetingId) throw Errors.invitationInvalid();
    }

    if (actor?.typ === "user") {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.sub } });
      participant = await prisma.meetingParticipant.findUnique({
        where: { meetingId_identity: { meetingId, identity: identityFor.user(user.id) } },
      });
      if (meeting.ownerId === user.id) role = "OWNER";
      else role = participant?.role ?? "PARTICIPANT";
      if (!participant) {
        if (meeting.locked) throw Errors.meetingLocked();
        participant = await prisma.meetingParticipant.create({
          data: {
            meetingId,
            userId: user.id,
            role,
            status: "INVITED",
            // Identity is derived from the account, so reconnects reuse it and never duplicate.
            identity: identityFor.user(user.id),
            displayName: user.displayName,
          },
        });
      }
    } else if (actor?.typ === "guest" && actor.mid === meetingId) {
      participant = await prisma.meetingParticipant.findUnique({ where: { id: actor.sub } });
      if (!participant) throw Errors.unauthorized();
      role = participant.role;
    } else {
      if (!viaInvitation) throw Errors.unauthorized("Gunakan tautan undangan atau masuk ke akun Anda.");
      if (!meeting.guestLinkEnabled) throw Errors.forbidden("Host menonaktifkan akses tamu melalui tautan.");
      if (!body.displayName) throw Errors.validation([{ path: "displayName", message: "Nama tampilan wajib diisi." }]);
      if (meeting.locked) throw Errors.meetingLocked();
      role = "GUEST";
      participant = await prisma.meetingParticipant.create({
        data: {
          meetingId,
          role,
          status: "INVITED",
          isGuest: true,
          identity: identityFor.guest(),
          displayName: body.displayName,
        },
      });
      await prisma.meetingInvitation.update({ where: { id: viaInvitation.id }, data: { useCount: { increment: 1 } } });
    }

    if (participant.status === "REMOVED") throw Errors.removed();
    if (participant.status === "REJECTED") throw Errors.rejected();

    const moderator = isModerator(role);
    const previouslyAdmitted = participant.admittedAt !== null;

    if (meeting.passcodeHash && !moderator && !previouslyAdmitted) {
      if (!body.passcode) throw Errors.passcodeRequired();
      if (!(await verifyPassword(meeting.passcodeHash, body.passcode))) throw Errors.passcodeInvalid();
    }
    if (meeting.locked && !moderator && !previouslyAdmitted) throw Errors.meetingLocked();

    await recordConsent(meeting, participant, body.consent, "join");

    const guestToken = participant.isGuest ? await signGuestToken(participant.id, meetingId) : null;

    // Waiting room: guests and registered users who were not invited wait for a host (PRD 3.1, 4.4).
    if (meeting.waitingRoom && !moderator && !previouslyAdmitted) {
      if (participant.status !== "WAITING") {
        participant = await prisma.meetingParticipant.update({
          where: { id: participant.id },
          data: { status: "WAITING", lastSeenAt: new Date() },
        });
        await publish(meetingId, "meeting.participant.waiting", "hosts", participantView(participant));
      }
      return { status: "WAITING", meetingId, participantId: participant.id, guestToken };
    }

    const joinedCount = await prisma.meetingParticipant.count({
      where: { meetingId, status: "JOINED", id: { not: participant.id } },
    });
    if (joinedCount >= meeting.maxParticipants) throw Errors.meetingFull();

    let live = meeting;
    if (meeting.status === "SCHEDULED") {
      if (!isHostRole(role)) {
        // Participants can arrive before the host; they wait until the host starts.
        if (participant.status !== "WAITING") {
          participant = await prisma.meetingParticipant.update({
            where: { id: participant.id },
            data: { status: "WAITING", admittedAt: participant.admittedAt ?? new Date() },
          });
        }
        return { status: "NOT_STARTED", meetingId, participantId: participant.id, guestToken };
      }
      live = await startMeeting(meeting);
    }

    const wasJoined = participant.status === "JOINED";
    participant = await prisma.meetingParticipant.update({
      where: { id: participant.id },
      data: {
        status: "JOINED",
        admittedAt: participant.admittedAt ?? new Date(),
        joinedAt: participant.joinedAt ?? new Date(),
        lastSeenAt: new Date(),
        leftAt: null,
      },
    });
    if (!wasJoined) await publish(meetingId, "meeting.participant.joined", "participants", participantView(participant));

    const policy = policyOf(live);
    const grants = { canPublish: true, canSubscribe: true, canShareScreen: true };
    const token = await issueLivekitToken({
      roomName: live.livekitRoomName,
      identity: participant.identity,
      name: participant.displayName,
      metadata: { participantId: participant.id, role },
      grants,
    });

    return {
      status: "JOINED",
      meetingId,
      participantId: participant.id,
      role,
      guestToken,
      livekit: { url: config.LIVEKIT_URL, token },
      permissions: {
        ...grants,
        canRecord: can(role, "recording.control", policy),
        canViewTranscript: can(role, "transcript.viewLive", policy),
      },
    };
  });

  /** Pre-join card for signed-in users who reach a meeting by id or code (no membership yet). */
  app.get("/meetings/:meetingId/preview", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    if (!req.actor) throw Errors.unauthorized();
    if (req.actor.typ === "guest" && req.actor.mid !== meetingId) throw Errors.notFound("Meeting");
    const m = await prisma.meeting.findUnique({ where: { id: meetingId }, include: { owner: { select: { displayName: true } } } });
    if (!m) throw Errors.notFound("Meeting");
    return {
      meeting: {
        id: m.id,
        title: m.title,
        status: m.status,
        scheduledAt: m.scheduledAt,
        hasPasscode: !!m.passcodeHash,
        waitingRoom: m.waitingRoom,
        recordingEnabled: m.recordingEnabled,
        transcriptionEnabled: m.transcriptionEnabled,
        hostName: m.owner.displayName,
        guestLinkEnabled: m.guestLinkEnabled,
        isOwner: req.actor.typ === "user" && m.ownerId === req.actor.sub,
      },
      consentNoticeVersion: config.CONSENT_NOTICE_VERSION,
    };
  });

  /** Lets a waiting participant poll its own status (SSE also pushes admitted/rejected). */
  app.get("/meetings/:meetingId/me", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await resolveActor(req, meetingId);
    return {
      participantId: a.participant?.id ?? null,
      status: a.participant?.status ?? null,
      admitted: a.participant?.admittedAt != null || a.role === "OWNER",
      meetingStatus: a.meeting.status,
    };
  });

  app.post("/meetings/:meetingId/leave", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await resolveActor(req, meetingId);
    if (!a.participant) return { ok: true };
    if (a.participant.status === "JOINED" || a.participant.status === "WAITING") {
      const p = await prisma.meetingParticipant.update({
        where: { id: a.participant.id },
        data: { status: "LEFT", leftAt: new Date() },
      });
      await publish(meetingId, "meeting.participant.left", "participants", participantView(p));
    }
    return { ok: true };
  });

  app.get("/meetings/:meetingId/waiting", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "participant.admit");
    const items = await prisma.meetingParticipant.findMany({
      where: { meetingId, status: "WAITING", admittedAt: null },
      orderBy: { lastSeenAt: "asc" },
    });
    return { items: items.map(participantView) };
  });

  app.post("/meetings/:meetingId/participants/:participantId/admit", async (req) => {
    const { meetingId, participantId } = z.object({ meetingId: z.string(), participantId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "participant.admit");
    const p = await prisma.meetingParticipant.findFirst({ where: { id: participantId, meetingId } });
    if (!p) throw Errors.notFound("Peserta");
    if (p.status === "REMOVED") throw Errors.conflict("PARTICIPANT_REMOVED", "Peserta ini sudah dikeluarkan.");
    const updated = await prisma.meetingParticipant.update({ where: { id: p.id }, data: { admittedAt: new Date() } });
    await publish(meetingId, "meeting.participant.admitted", { participantId: p.id }, participantView(updated));
    await publish(meetingId, "meeting.participant.admitted", "hosts", participantView(updated));
    await audit(req, { action: "participant.admit", resource: "participant", resourceId: p.id, meetingId });
    return { participant: participantView(updated) };
  });

  app.post("/meetings/:meetingId/participants/:participantId/reject", async (req) => {
    const { meetingId, participantId } = z.object({ meetingId: z.string(), participantId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "participant.admit");
    const p = await prisma.meetingParticipant.findFirst({ where: { id: participantId, meetingId } });
    if (!p) throw Errors.notFound("Peserta");
    const updated = await prisma.meetingParticipant.update({ where: { id: p.id }, data: { status: "REJECTED" } });
    await publish(meetingId, "meeting.participant.rejected", { participantId: p.id }, participantView(updated));
    await publish(meetingId, "meeting.participant.rejected", "hosts", participantView(updated));
    await audit(req, { action: "participant.reject", resource: "participant", resourceId: p.id, meetingId });
    return { participant: participantView(updated) };
  });

  app.post("/meetings/:meetingId/participants/:participantId/remove", async (req) => {
    const { meetingId, participantId } = z.object({ meetingId: z.string(), participantId: z.string() }).parse(req.params);
    const a = await authorize(req, meetingId, "participant.remove");
    const p = await prisma.meetingParticipant.findFirst({ where: { id: participantId, meetingId } });
    if (!p) throw Errors.notFound("Peserta");
    if (p.role === "OWNER" || (p.role === "HOST" && a.role !== "OWNER"))
      throw Errors.forbidden("Host tidak dapat dikeluarkan.");
    // REMOVED blocks every future join; the old LiveKit token expires on its own short TTL.
    const updated = await prisma.meetingParticipant.update({
      where: { id: p.id },
      data: { status: "REMOVED", leftAt: new Date() },
    });
    await roomService.removeParticipant(a.meeting.livekitRoomName, p.identity).catch(() => undefined);
    await publish(meetingId, "meeting.participant.removed", "participants", participantView(updated));
    await publish(meetingId, "meeting.participant.removed", { participantId: p.id }, participantView(updated));
    await audit(req, { action: "participant.remove", resource: "participant", resourceId: p.id, meetingId });
    return { participant: participantView(updated) };
  });

  app.post("/meetings/:meetingId/participants/:participantId/role", async (req) => {
    const { meetingId, participantId } = z.object({ meetingId: z.string(), participantId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "meeting.manage");
    const { role } = z.object({ role: z.enum(["CO_HOST", "PARTICIPANT"]) }).parse(req.body);
    const p = await prisma.meetingParticipant.findFirst({ where: { id: participantId, meetingId } });
    if (!p) throw Errors.notFound("Peserta");
    if (p.isGuest || p.role === "OWNER") throw Errors.forbidden("Peran peserta ini tidak dapat diubah.");
    const updated = await prisma.meetingParticipant.update({ where: { id: p.id }, data: { role } });
    await publish(meetingId, "meeting.participant.updated", "participants", participantView(updated));
    await audit(req, { action: "participant.role", resource: "participant", resourceId: p.id, meetingId, metadata: { role } });
    return { participant: participantView(updated) };
  });

  /** Consent for recording that starts mid-meeting is acknowledged here. */
  app.post("/meetings/:meetingId/consent", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await resolveActor(req, meetingId);
    if (!a.participant) throw Errors.forbidden();
    const body = z
      .object({ type: z.enum(["RECORDING", "TRANSCRIPTION"]), granted: z.boolean(), noticeVersion: z.string().max(40) })
      .parse(req.body);
    await prisma.consentEvent.create({
      data: { ...body, meetingId, participantId: a.participant.id, source: "in-meeting" },
    });
    await prisma.meetingParticipant.update({
      where: { id: a.participant.id },
      data: body.type === "RECORDING" ? { consentRecording: body.granted } : { consentTranscript: body.granted },
    });
    return { ok: true };
  });
}
