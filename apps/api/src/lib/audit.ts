import type { FastifyRequest } from "fastify";
import { prisma, type Prisma } from "@zuum/db";

interface AuditInput {
  action: string;
  resource: string;
  resourceId?: string | null;
  meetingId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Audit trail for host actions, recording access, exports, permission changes and deletions (PRD 11.4). */
export async function audit(req: FastifyRequest, input: AuditInput) {
  const actor = req.actor;
  await prisma.auditLog.create({
    data: {
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ?? null,
      meetingId: input.meetingId ?? null,
      userId: actor?.typ === "user" ? actor.sub : null,
      actorType: actor?.typ ?? "anonymous",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
      metadata: {
        ...(actor?.typ === "guest" ? { participantId: actor.sub } : {}),
        ...((input.metadata as object) ?? {}),
      },
    },
  });
}
