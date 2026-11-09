import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@zuum/db";
import { authorize } from "../lib/access";
import { audit } from "../lib/audit";
import { randomToken } from "../lib/crypto";
import { AppError, Errors } from "../lib/errors";
import { outboxEvent } from "../lib/queue";
import { toJSON } from "../lib/serialize";
import { exportMinutes } from "../export/minutes";

const params = z.object({ meetingId: z.string() });

export async function aiRoutes(app: FastifyInstance) {
  /** Regenerate never touches the transcript; it only replaces AI results and adds a minutes version (PRD 7.2). */
  app.post("/meetings/:meetingId/ai/generate", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const { meetingId } = params.parse(req.params);
    const a = await authorize(req, meetingId, "ai.generate");
    if (a.meeting.status !== "ENDED") throw new AppError(409, "MEETING_NOT_ENDED", "Hasil AI dibuat setelah meeting selesai.");
    const running = await prisma.aIJob.findFirst({ where: { meetingId, status: { in: ["QUEUED", "RUNNING"] } } });
    if (running) throw new AppError(409, "AI_JOB_RUNNING", "Pemrosesan AI sedang berjalan.");
    const runKey = `manual-${randomToken(8)}`;
    await prisma.$transaction(async (tx) => {
      await outboxEvent(tx, "ai.pipeline", { meetingId, trigger: "manual", runKey });
    });
    await audit(req, { action: "ai.generate", resource: "meeting", resourceId: meetingId, meetingId });
    return reply.status(202).send({ queued: true, runKey });
  });

  app.get("/meetings/:meetingId/ai/status", async (req) => {
    const { meetingId } = params.parse(req.params);
    await authorize(req, meetingId, "results.view");
    const jobs = await prisma.aIJob.findMany({
      where: { meetingId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        type: true,
        status: true,
        model: true,
        promptVersion: true,
        attempts: true,
        startedAt: true,
        completedAt: true,
        errorCode: true,
        errorMessage: true,
        createdAt: true,
      },
    });
    const pendingOutbox = await prisma.outboxEvent.count({
      where: { topic: "ai.pipeline", dispatchedAt: null, payload: { path: ["meetingId"], equals: meetingId } },
    });
    const transcript = await prisma.transcript.findUnique({ where: { meetingId }, select: { status: true, version: true } });
    return { jobs, queued: pendingOutbox > 0, transcript };
  });

  app.get("/meetings/:meetingId/summary", async (req) => {
    const { meetingId } = params.parse(req.params);
    await authorize(req, meetingId, "results.view");
    const summary = await prisma.meetingSummary.findUnique({ where: { meetingId } });
    return { summary: summary ? toJSON({ ...summary, rawOutput: undefined }) : null };
  });

  app.get("/meetings/:meetingId/topics", async (req) => {
    const { meetingId } = params.parse(req.params);
    await authorize(req, meetingId, "results.view");
    const items = await prisma.meetingTopic.findMany({ where: { meetingId }, orderBy: { sortOrder: "asc" } });
    return { items: toJSON(items) };
  });

  app.get("/meetings/:meetingId/decisions", async (req) => {
    const { meetingId } = params.parse(req.params);
    await authorize(req, meetingId, "results.view");
    const items = await prisma.meetingDecision.findMany({ where: { meetingId }, orderBy: { createdAt: "asc" } });
    return { items };
  });

  app.patch("/decisions/:decisionId", async (req) => {
    const { decisionId } = z.object({ decisionId: z.string() }).parse(req.params);
    const d = await prisma.meetingDecision.findUnique({ where: { id: decisionId } });
    if (!d) throw Errors.notFound("Keputusan");
    const a = await authorize(req, d.meetingId, "results.review");
    const body = z
      .object({
        description: z.string().trim().min(1).max(2000).optional(),
        context: z.string().trim().max(2000).nullable().optional(),
        status: z.enum(["PROPOSED", "CONFIRMED", "REJECTED", "NEEDS_REVIEW"]).optional(),
      })
      .parse(req.body);
    const updated = await prisma.meetingDecision.update({
      where: { id: d.id },
      data: { ...body, reviewedById: a.userId, reviewedAt: new Date() },
    });
    await audit(req, { action: "decision.review", resource: "decision", resourceId: d.id, meetingId: d.meetingId, metadata: body });
    return { decision: updated };
  });

  app.get("/meetings/:meetingId/action-items", async (req) => {
    const { meetingId } = params.parse(req.params);
    await authorize(req, meetingId, "results.view");
    const items = await prisma.actionItem.findMany({
      where: { meetingId },
      orderBy: { createdAt: "asc" },
      include: { assignee: { select: { id: true, displayName: true } } },
    });
    return { items };
  });

  app.patch("/action-items/:actionItemId", async (req) => {
    const { actionItemId } = z.object({ actionItemId: z.string() }).parse(req.params);
    const item = await prisma.actionItem.findUnique({ where: { id: actionItemId } });
    if (!item) throw Errors.notFound("Tindak lanjut");
    await authorize(req, item.meetingId, "results.review");
    const body = z
      .object({
        description: z.string().trim().min(1).max(2000).optional(),
        assigneeParticipantId: z.string().nullable().optional(),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Format tanggal YYYY-MM-DD.")
          .nullable()
          .optional(),
        status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]).optional(),
      })
      .parse(req.body);
    if (body.assigneeParticipantId) {
      const p = await prisma.meetingParticipant.findFirst({ where: { id: body.assigneeParticipantId, meetingId: item.meetingId } });
      if (!p) throw new AppError(400, "PARTICIPANT_INVALID", "Penanggung jawab harus peserta meeting ini.");
    }
    const updated = await prisma.actionItem.update({
      where: { id: item.id },
      data: {
        ...body,
        dueDate: body.dueDate === undefined ? undefined : body.dueDate ? new Date(`${body.dueDate}T00:00:00Z`) : null,
        // A human confirming the item clears the review flag.
        needsReview: false,
      },
      include: { assignee: { select: { id: true, displayName: true } } },
    });
    await audit(req, { action: "action_item.update", resource: "action_item", resourceId: item.id, meetingId: item.meetingId, metadata: body });
    return { actionItem: updated };
  });

  app.get("/meetings/:meetingId/minutes", async (req) => {
    const { meetingId } = params.parse(req.params);
    const { version } = z.object({ version: z.coerce.number().int().optional() }).parse(req.query);
    await authorize(req, meetingId, "results.view");
    const minutes = await prisma.meetingMinutes.findFirst({
      where: { meetingId, ...(version ? { version } : {}) },
      orderBy: { version: "desc" },
    });
    const versions = await prisma.meetingMinutes.findMany({
      where: { meetingId },
      orderBy: { version: "desc" },
      select: { version: true, generatedAt: true, model: true },
    });
    return { minutes, versions };
  });

  app.get("/meetings/:meetingId/minutes/export", async (req, reply) => {
    const { meetingId } = params.parse(req.params);
    const { format } = z.object({ format: z.enum(["docx", "pdf", "txt"]).default("docx") }).parse(req.query);
    const a = await authorize(req, meetingId, "results.download");
    const file = await exportMinutes(a.meeting, format);
    if (!file) throw new AppError(404, "MINUTES_NOT_READY", "Notulen belum tersedia.");
    await audit(req, { action: "minutes.export", resource: "meeting", resourceId: meetingId, meetingId, metadata: { format } });
    return reply
      .header("Content-Type", file.mime)
      .header("Content-Disposition", `attachment; filename="${file.fileName}"`)
      .header("Cache-Control", "no-store")
      .send(file.body);
  });
}
