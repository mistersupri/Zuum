import type { FastifyRequest } from "fastify";
import { prisma, type Meeting, type MeetingParticipant } from "@zuum/db";
import { can, type Action, type MeetingPolicy, type Role } from "@zuum/shared";
import { Errors } from "./errors";

export interface MeetingActor {
  meeting: Meeting;
  participant: MeetingParticipant | null;
  role: Role;
  userId: string | null;
}

export const policyOf = (m: Meeting): MeetingPolicy => ({
  transcriptVisibility: m.transcriptVisibility,
  participantsCanDownload: m.participantsCanDownload,
  coHostCanMute: m.coHostCanMute,
  coHostCanRemove: m.coHostCanRemove,
  coHostCanRecord: m.coHostCanRecord,
});

export function requireUser(req: FastifyRequest): string {
  if (req.actor?.typ !== "user") throw Errors.unauthorized();
  return req.actor.sub;
}

/**
 * Resolves who is calling for a given meeting. Every meeting-scoped route goes
 * through here, which is the IDOR guard (PRD 11.1): no membership, no access.
 */
export async function resolveActor(req: FastifyRequest, meetingId: string): Promise<MeetingActor> {
  const actor = req.actor;
  if (!actor) throw Errors.unauthorized();
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting) throw Errors.notFound("Meeting");

  if (actor.typ === "guest") {
    if (actor.mid !== meetingId) throw Errors.notFound("Meeting");
    const participant = await prisma.meetingParticipant.findUnique({ where: { id: actor.sub } });
    if (!participant || participant.meetingId !== meetingId) throw Errors.unauthorized();
    if (participant.status === "REMOVED") throw Errors.removed();
    return { meeting, participant, role: participant.role, userId: null };
  }

  const participant = await prisma.meetingParticipant.findFirst({
    where: { meetingId, userId: actor.sub },
  });
  if (meeting.ownerId === actor.sub) {
    return { meeting, participant, role: "OWNER", userId: actor.sub };
  }
  if (!participant) throw Errors.notFound("Meeting");
  if (participant.status === "REMOVED") throw Errors.removed();
  return { meeting, participant, role: participant.role, userId: actor.sub };
}

/** Admitted means past the waiting room; waiting or rejected participants only see their own status. */
export const isAdmitted = (a: MeetingActor) =>
  a.role === "OWNER" ||
  (!!a.participant && ["JOINED", "LEFT"].includes(a.participant.status)) ||
  (!!a.participant && a.participant.admittedAt !== null && a.participant.status !== "REJECTED");

export async function authorize(req: FastifyRequest, meetingId: string, action: Action) {
  const a = await resolveActor(req, meetingId);
  if (action !== "meeting.join" && !isAdmitted(a)) throw Errors.forbidden();
  if (!can(a.role, action, policyOf(a.meeting))) throw Errors.forbidden();
  return a;
}
