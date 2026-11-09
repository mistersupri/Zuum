import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, Prisma, type Meeting } from "@zuum/db";
import { can, isModerator } from "@zuum/shared";
import { config } from "../config";
import { authorize, policyOf, requireUser, resolveActor, isAdmitted } from "../lib/access";
import { audit } from "../lib/audit";
import { hashPassword, meetingCode, randomToken, sha256 } from "../lib/crypto";
import { Errors } from "../lib/errors";
import { publish } from "../lib/events";
import { egressClient, roomService } from "../lib/livekit";
import { outboxEvent } from "../lib/queue";
import { toJSON } from "../lib/serialize";

const settingsSchema = z.object({
  title: z.string().trim().min(1, "Judul meeting wajib diisi.").max(140),
  description: z.string().trim().max(2000).nullable().optional(),
  agenda: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  durationMinutes: z.number().int().min(5).max(24 * 60).nullable().optional(),
  timezone: z.string().optional(),
  maxParticipants: z.number().int().min(2).max(500).optional(),
  guestLinkEnabled: z.boolean().optional(),
  waitingRoom: z.boolean().optional(),
  passcode: z.string().min(4).max(32).nullable().optional(),
  recordingEnabled: z.boolean().optional(),
  transcriptionEnabled: z.boolean().optional(),
  transcriptVisibility: z.enum(["HOST_ONLY", "HOST_AND_PARTICIPANTS", "EVERYONE"]).optional(),
  participantsCanDownload: z.boolean().optional(),
  coHostCanMute: z.boolean().optional(),
  coHostCanRemove: z.boolean().optional(),
  coHostCanRecord: z.boolean().optional(),
  chatAsAiContext: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  language: z.literal("id-ID").optional(),
});

/** Public shape of a meeting. Never includes passcodeHash. */
export function meetingView(m: Meeting & { _count?: { participants: number } }, extra: Record<string, unknown> = {}) {
  const { passcodeHash, ...rest } = m;
  return toJSON({ ...rest, hasPasscode: !!passcodeHash, ...extra });
}

async function createInvitation(meetingId: string, createdById: string, opts: { expiresAt?: Date | null; maxUses?: number | null } = {}) {
  const raw = randomToken();
  const inv = await prisma.meetingInvitation.create({
    data: {
      meetingId,
      createdById,
      tokenHash: sha256(raw),
      expiresAt: opts.expiresAt ?? null,
      maxUses: opts.maxUses ?? null,
    },
  });
  return { invitation: inv, token: raw, url: `${config.PUBLIC_APP_URL}/j/${raw}` };
}

export async function meetingRoutes(app: FastifyInstance) {
  app.post("/meetings", async (req, reply) => {
    const userId = requireUser(req);
    const body = settingsSchema.parse(req.body);
    const { passcode, ...settings } = body;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const meeting = await prisma.meeting.create({
      data: {
        ...settings,
        agenda: settings.agenda ?? [],
        timezone: settings.timezone ?? user.timezone,
        code: meetingCode(),
        livekitRoomName: `zuum_${randomToken(12)}`,
        ownerId: userId,
        passcodeHash: passcode ? await hashPassword(passcode) : null,
        participants: {
          create: {
            userId,
            role: "OWNER",
            status: "INVITED",
            identity: `u_${userId}`,
            displayName: user.displayName,
            admittedAt: new Date(),
          },
        },
        transcript: { create: { language: "id-ID" } },
      },
    });
    const invite = await createInvitation(meeting.id, userId);
    await audit(req, { action: "meeting.create", resource: "meeting", resourceId: meeting.id, meetingId: meeting.id });
    return reply.status(201).send({ meeting: meetingView(meeting), invitation: { url: invite.url, id: invite.invitation.id } });
  });

  app.get("/meetings", async (req) => {
    const userId = requireUser(req);
    const q = z
      .object({
        q: z.string().trim().max(200).optional(),
        status: z.enum(["SCHEDULED", "LIVE", "ENDED", "CANCELLED"]).optional(),
        scope: z.enum(["all", "owned", "joined"]).default("all"),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);

    const memberFilter: Prisma.MeetingWhereInput =
      q.scope === "owned"
        ? { ownerId: userId }
        : q.scope === "joined"
          ? { participants: { some: { userId, role: { not: "OWNER" } } } }
          : { OR: [{ ownerId: userId }, { participants: { some: { userId } } }] };

    let idsFromTranscript: string[] = [];
    if (q.q) {
      // Full-text match on transcript text, restricted to meetings the user can see.
      const rows = await prisma.$queryRaw<{ meetingId: string }[]>`
        SELECT DISTINCT t."meetingId" FROM "TranscriptSegment" s
        JOIN "Transcript" t ON t.id = s."transcriptId"
        JOIN "Meeting" m ON m.id = t."meetingId"
        WHERE to_tsvector('simple', coalesce(s."correctedText", s."originalText")) @@ plainto_tsquery('simple', ${q.q})
          AND (m."ownerId" = ${userId} OR EXISTS (
            SELECT 1 FROM "MeetingParticipant" p WHERE p."meetingId" = m.id AND p."userId" = ${userId}))
        LIMIT 200`;
      idsFromTranscript = rows.map((r) => r.meetingId);
    }

    const where: Prisma.MeetingWhereInput = {
      AND: [
        memberFilter,
        q.status ? { status: q.status } : {},
        q.from || q.to ? { createdAt: { gte: q.from, lte: q.to } } : {},
        q.q ? { OR: [{ title: { contains: q.q, mode: "insensitive" } }, { id: { in: idsFromTranscript } }] } : {},
      ],
    };
    const meetings = await prisma.meeting.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        _count: { select: { participants: { where: { status: { in: ["JOINED", "LEFT"] } } } } },
        transcript: { select: { status: true } },
        aiJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, type: true, errorCode: true } },
        owner: { select: { displayName: true } },
      },
    });
    const hasMore = meetings.length > q.limit;
    const page = meetings.slice(0, q.limit);
    return {
      items: page.map((m) => {
        const { transcript, aiJobs, owner, ...rest } = m;
        return meetingView(rest, {
          isOwner: m.ownerId === userId,
          ownerName: owner.displayName,
          transcriptStatus: transcript?.status ?? null,
          aiStatus: aiJobs[0]?.status ?? null,
          aiErrorCode: aiJobs[0]?.errorCode ?? null,
          attendeeCount: m._count.participants,
          matchedTranscript: idsFromTranscript.includes(m.id),
        });
      }),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  });

  /** Meeting ID lookup for the "join by code" form. Only returns the id; joining is validated separately. */
  app.get("/meetings/by-code/:code", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { code } = z.object({ code: z.string().trim().toLowerCase().max(20) }).parse(req.params);
    const meeting = await prisma.meeting.findUnique({ where: { code }, select: { id: true, status: true } });
    if (!meeting) throw Errors.notFound("Meeting dengan kode tersebut");
    return { meetingId: meeting.id };
  });

  app.get("/meetings/:meetingId", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await resolveActor(req, meetingId);
    const policy = policyOf(a.meeting);
    const participants = isAdmitted(a)
      ? await prisma.meetingParticipant.findMany({
          where: { meetingId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            displayName: true,
            role: true,
            status: true,
            isGuest: true,
            joinedAt: true,
            leftAt: true,
            identity: true,
            admittedAt: true,
          },
        })
      : [];
    return {
      meeting: meetingView(a.meeting),
      me: {
        participantId: a.participant?.id ?? null,
        role: a.role,
        status: a.participant?.status ?? null,
        admitted: isAdmitted(a),
        permissions: {
          manage: can(a.role, "meeting.manage", policy),
          end: can(a.role, "meeting.end", policy),
          mute: can(a.role, "participant.mute", policy),
          remove: can(a.role, "participant.remove", policy),
          admit: can(a.role, "participant.admit", policy),
          lock: can(a.role, "room.lock", policy),
          record: can(a.role, "recording.control", policy),
          viewTranscript: can(a.role, "transcript.viewLive", policy),
          editTranscript: can(a.role, "transcript.edit", policy),
          viewResults: can(a.role, "results.view", policy),
          download: can(a.role, "results.download", policy),
          generateAi: can(a.role, "ai.generate", policy),
          review: can(a.role, "results.review", policy),
        },
      },
      participants,
    };
  });

  app.patch("/meetings/:meetingId", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "meeting.manage");
    const body = settingsSchema.partial().parse(req.body);
    const { passcode, ...rest } = body;
    const data: Prisma.MeetingUpdateInput = { ...rest };
    if (passcode !== undefined) data.passcodeHash = passcode ? await hashPassword(passcode) : null;
    const meeting = await prisma.meeting.update({ where: { id: meetingId }, data });
    await audit(req, {
      action: "meeting.update",
      resource: "meeting",
      resourceId: meetingId,
      meetingId,
      metadata: { fields: Object.keys(body) },
    });
    return { meeting: meetingView(meeting) };
  });

  app.post("/meetings/:meetingId/start", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await authorize(req, meetingId, "meeting.manage");
    if (a.meeting.status === "ENDED" || a.meeting.status === "CANCELLED") throw Errors.meetingEnded();
    const meeting = await startMeeting(a.meeting);
    return { meeting: meetingView(meeting) };
  });

  app.post("/meetings/:meetingId/end", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await authorize(req, meetingId, "meeting.end");
    if (a.meeting.status === "ENDED") return { meeting: meetingView(a.meeting) };
    const meeting = await endMeeting(a.meeting, app.log);
    await audit(req, { action: "meeting.end", resource: "meeting", resourceId: meetingId, meetingId });
    return { meeting: meetingView(meeting) };
  });

  app.post("/meetings/:meetingId/cancel", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await authorize(req, meetingId, "meeting.manage");
    if (a.meeting.status !== "SCHEDULED") throw Errors.conflict("NOT_SCHEDULED", "Hanya meeting terjadwal yang dapat dibatalkan.");
    const meeting = await prisma.meeting.update({ where: { id: meetingId }, data: { status: "CANCELLED" } });
    await audit(req, { action: "meeting.cancel", resource: "meeting", resourceId: meetingId, meetingId });
    return { meeting: meetingView(meeting) };
  });

  // ---- Invitations ----

  app.get("/meetings/:meetingId/invitations", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "meeting.manage");
    const items = await prisma.meetingInvitation.findMany({
      where: { meetingId },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, expiresAt: true, maxUses: true, useCount: true, createdAt: true, revokedAt: true },
    });
    return { items };
  });

  app.post("/meetings/:meetingId/invitations", async (req, reply) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const a = await authorize(req, meetingId, "meeting.manage");
    const body = z
      .object({
        expiresInHours: z.number().int().min(1).max(24 * 90).nullable().optional(),
        maxUses: z.number().int().min(1).max(1000).nullable().optional(),
        // Rotate: revoke every active link and issue a fresh one.
        rotate: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    if (body.rotate) {
      await prisma.meetingInvitation.updateMany({
        where: { meetingId, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    }
    const invite = await createInvitation(meetingId, a.userId!, {
      expiresAt: body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3600_000) : null,
      maxUses: body.maxUses ?? null,
    });
    await audit(req, {
      action: body.rotate ? "invitation.rotate" : "invitation.create",
      resource: "invitation",
      resourceId: invite.invitation.id,
      meetingId,
    });
    return reply.status(201).send({ invitation: { id: invite.invitation.id, url: invite.url, expiresAt: invite.invitation.expiresAt } });
  });

  app.post("/meetings/:meetingId/invitations/:invitationId/revoke", async (req) => {
    const { meetingId, invitationId } = z.object({ meetingId: z.string(), invitationId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "meeting.manage");
    const res = await prisma.meetingInvitation.updateMany({
      where: { id: invitationId, meetingId },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    if (!res.count) throw Errors.notFound("Undangan");
    await audit(req, { action: "invitation.revoke", resource: "invitation", resourceId: invitationId, meetingId });
    return { ok: true };
  });

  app.get("/invitations/:token/preview", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
    const inv = await findUsableInvitation(token);
    const m = inv.meeting;
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
      },
      consentNoticeVersion: config.CONSENT_NOTICE_VERSION,
    };
  });
}

export async function findUsableInvitation(token: string) {
  const inv = await prisma.meetingInvitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { meeting: { include: { owner: { select: { displayName: true } } } } },
  });
  if (!inv || inv.status === "REVOKED") throw Errors.invitationInvalid();
  if (inv.status === "EXPIRED" || (inv.expiresAt && inv.expiresAt < new Date())) throw Errors.invitationExpired();
  if (inv.status === "CONSUMED" || (inv.maxUses !== null && inv.useCount >= inv.maxUses)) throw Errors.invitationExpired();
  if (inv.meeting.status === "ENDED" || inv.meeting.status === "CANCELLED") throw Errors.meetingEnded();
  return inv;
}

export async function startMeeting(meeting: Meeting) {
  if (meeting.status === "LIVE") return meeting;
  return prisma.meeting.update({
    where: { id: meeting.id },
    data: { status: "LIVE", startedAt: meeting.startedAt ?? new Date() },
  });
}

export async function endMeeting(meeting: Meeting, log: { warn: (o: object, m: string) => void }) {
  const updated = await prisma.$transaction(async (tx) => {
    const m = await tx.meeting.update({
      where: { id: meeting.id },
      data: { status: "ENDED", endedAt: new Date(), recordingActive: false },
    });
    await tx.meetingParticipant.updateMany({
      where: { meetingId: meeting.id, status: { in: ["JOINED", "WAITING"] } },
      data: { status: "LEFT", leftAt: new Date() },
    });
    await tx.transcript.updateMany({
      where: { meetingId: meeting.id, status: { in: ["PENDING", "STREAMING"] } },
      data: { status: "FINALIZING" },
    });
    // AI documentation runs once per meeting end; the outbox guarantees it is enqueued.
    await outboxEvent(tx, "ai.pipeline", { meetingId: meeting.id, trigger: "auto", runKey: "auto" });
    return m;
  });

  // Media-side cleanup. Failures here must not undo the end: the room expires on its own.
  const active = await prisma.meetingAsset.findMany({
    where: { meetingId: meeting.id, status: { in: ["QUEUED", "RECORDING"] }, externalId: { not: null } },
  });
  for (const asset of active) {
    await egressClient.stopEgress(asset.externalId!).catch((err) => log.warn({ err, assetId: asset.id }, "stop egress gagal"));
  }
  await publish(meeting.id, "meeting.ended", "participants", { endedAt: updated.endedAt });
  await roomService.deleteRoom(meeting.livekitRoomName).catch((err) => log.warn({ err }, "delete room gagal"));
  return updated;
}

export const moderatorOnly = isModerator;
