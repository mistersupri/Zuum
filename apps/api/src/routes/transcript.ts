import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@zuum/db";
import { authorize, resolveActor, isAdmitted, policyOf } from "../lib/access";
import { can } from "@zuum/shared";
import { audit } from "../lib/audit";
import { AppError, Errors } from "../lib/errors";
import { publish } from "../lib/events";
import { segmentDTO } from "../lib/serialize";
import { exportTranscript } from "../export/transcript";

/** Live view needs transcript.viewLive; after the meeting the archive needs results.view. */
async function authorizeTranscriptRead(req: Parameters<typeof resolveActor>[0], meetingId: string) {
  const a = await resolveActor(req, meetingId);
  if (!isAdmitted(a)) throw Errors.forbidden();
  const policy = policyOf(a.meeting);
  const action = a.meeting.status === "LIVE" ? "transcript.viewLive" : "results.view";
  if (!can(a.role, action, policy)) throw Errors.forbidden("Transkrip meeting ini tidak dibagikan kepada Anda.");
  return a;
}

export async function transcriptRoutes(app: FastifyInstance) {
  app.get("/meetings/:meetingId/transcript", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const q = z
      .object({
        afterSequence: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
        participantId: z.string().optional(),
      })
      .parse(req.query);
    await authorizeTranscriptRead(req, meetingId);
    const transcript = await prisma.transcript.findUnique({ where: { meetingId } });
    if (!transcript) return { transcript: null, segments: [], nextAfterSequence: null };
    const segments = await prisma.transcriptSegment.findMany({
      where: {
        transcriptId: transcript.id,
        sequence: { gt: q.afterSequence },
        ...(q.participantId ? { participantId: q.participantId } : {}),
      },
      orderBy: { sequence: "asc" },
      take: q.limit + 1,
    });
    const hasMore = segments.length > q.limit;
    const page = segments.slice(0, q.limit);
    return {
      transcript: {
        id: transcript.id,
        status: transcript.status,
        language: transcript.language,
        version: transcript.version,
        finalizedAt: transcript.finalizedAt,
        errorCode: transcript.errorCode,
        metadata: transcript.metadata,
      },
      segments: page.map(segmentDTO),
      nextAfterSequence: hasMore ? page[page.length - 1]!.sequence : null,
    };
  });

  app.get("/meetings/:meetingId/transcript/search", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const { q } = z.object({ q: z.string().trim().min(1).max(200) }).parse(req.query);
    await authorizeTranscriptRead(req, meetingId);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM "TranscriptSegment" s JOIN "Transcript" t ON t.id = s."transcriptId"
      WHERE t."meetingId" = ${meetingId}
        AND (to_tsvector('simple', coalesce(s."correctedText", s."originalText")) @@ plainto_tsquery('simple', ${q})
             OR coalesce(s."correctedText", s."originalText") ILIKE ${"%" + q.replace(/[%_]/g, "") + "%"})
      ORDER BY s."startMs" ASC LIMIT 200`;
    const segments = await prisma.transcriptSegment.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      orderBy: { startMs: "asc" },
    });
    return { segments: segments.map(segmentDTO) };
  });

  /** Correction keeps originalText untouched and records who changed it (PRD 4.8). */
  app.patch("/transcript-segments/:segmentId", async (req) => {
    const { segmentId } = z.object({ segmentId: z.string() }).parse(req.params);
    const body = z
      .object({
        text: z.string().trim().min(1).max(5000).optional(),
        needsReview: z.boolean().optional(),
        participantId: z.string().nullable().optional(),
      })
      .refine((b) => Object.keys(b).length > 0, "Tidak ada perubahan.")
      .parse(req.body);
    const seg = await prisma.transcriptSegment.findUnique({ where: { id: segmentId }, include: { transcript: true } });
    if (!seg) throw Errors.notFound("Segmen");
    const a = await authorize(req, seg.transcript.meetingId, "transcript.edit");

    const data: Parameters<typeof prisma.transcriptSegment.update>[0]["data"] = {};
    if (body.text !== undefined) {
      data.correctedText = body.text === seg.originalText ? null : body.text;
      data.status = body.text === seg.originalText ? "FINAL" : "CORRECTED";
      data.correctedAt = new Date();
      data.correctedById = a.userId ?? a.participant?.id ?? null;
    }
    if (body.needsReview !== undefined && body.text === undefined) {
      data.status = body.needsReview ? "NEEDS_REVIEW" : seg.correctedText ? "CORRECTED" : "FINAL";
    }
    if (body.participantId !== undefined) {
      // Manual speaker reassignment, e.g. two people sharing one microphone (PRD 4.8 item 8).
      if (body.participantId) {
        const p = await prisma.meetingParticipant.findFirst({
          where: { id: body.participantId, meetingId: seg.transcript.meetingId },
        });
        if (!p) throw new AppError(400, "PARTICIPANT_INVALID", "Peserta tidak ditemukan di meeting ini.");
        data.participant = { connect: { id: p.id } };
        data.speakerName = p.displayName;
        data.speakerVerified = false;
      } else {
        data.participant = { disconnect: true };
        data.speakerName = "Pembicara tidak diketahui";
        data.speakerVerified = false;
      }
      data.metadata = {
        ...((seg.metadata as object) ?? {}),
        speakerReassignedFrom: seg.participantId,
        speakerReassignedBy: a.userId ?? a.participant?.id ?? null,
      };
    }
    const updated = await prisma.transcriptSegment.update({ where: { id: seg.id }, data });
    const dto = segmentDTO(updated);
    await publish(seg.transcript.meetingId, "transcript.segment.corrected", "transcript", dto, updated.updatedAt.getTime());
    await audit(req, {
      action: "transcript.correct",
      resource: "transcript_segment",
      resourceId: seg.id,
      meetingId: seg.transcript.meetingId,
      metadata: { fields: Object.keys(body) },
    });
    return { segment: dto };
  });

  app.get("/meetings/:meetingId/transcript/export", async (req, reply) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    const { format } = z.object({ format: z.enum(["txt", "json", "docx", "pdf"]).default("txt") }).parse(req.query);
    const a = await authorize(req, meetingId, "results.download");
    const file = await exportTranscript(a.meeting, format);
    await audit(req, { action: "transcript.export", resource: "meeting", resourceId: meetingId, meetingId, metadata: { format } });
    return reply
      .header("Content-Type", file.mime)
      .header("Content-Disposition", `attachment; filename="${file.fileName}"`)
      .header("Cache-Control", "no-store")
      .send(file.body);
  });
}
