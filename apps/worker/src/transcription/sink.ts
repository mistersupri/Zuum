import { prisma, Prisma } from "@zuum/db";
import type { FinalSegmentPayload, PartialSegmentPayload, TranscriptSegmentDTO } from "@zuum/shared";
import { config } from "../config";
import { log, publish } from "../shared";
import type { SttResult } from "./stt/types";

export interface StreamContext {
  meetingId: string;
  transcriptId: string;
  participantId: string | null;
  speakerName: string;
  speakerVerified: boolean;
  trackSid: string;
  // Wall-clock ms when this STT stream started, and the meeting start, to map onto the meeting timeline.
  streamStartedAt: number;
  meetingStartedAt: number;
  // Stream epoch distinguishes reconnects of the same track.
  epoch: string;
  provider: string;
  language: string;
}

/**
 * Normalizes a provider result into the segment shape of PRD 6.1 step 9 and
 * maps its timing onto the meeting timeline (PRD 6.2).
 */
export function normalize(ctx: StreamContext, r: SttResult, receivedAt = Date.now()) {
  const offset = ctx.streamStartedAt - ctx.meetingStartedAt;
  const estimated = r.startSec === null || r.endSec === null;
  const startMs = Math.max(0, Math.round(offset + (r.startSec ?? (receivedAt - ctx.streamStartedAt) / 1000 - 2) * 1000));
  const endMs = Math.max(startMs, Math.round(offset + (r.endSec ?? (receivedAt - ctx.streamStartedAt) / 1000) * 1000));
  const lowConfidence = r.confidence !== null && r.confidence < config.STT_REVIEW_CONFIDENCE;
  return {
    utteranceKey: `${ctx.trackSid}:${ctx.epoch}:${r.index}`,
    dedupeKey: `${ctx.trackSid}:${ctx.epoch}:${r.index}`,
    startMs,
    endMs,
    timingEstimated: estimated,
    text: r.text.trim(),
    isFinal: r.isFinal,
    status: lowConfidence ? ("NEEDS_REVIEW" as const) : ("FINAL" as const),
    confidence: r.confidence,
  };
}

export async function emitPartial(ctx: StreamContext, r: SttResult) {
  const n = normalize(ctx, r);
  if (!n.text) return;
  const payload: PartialSegmentPayload = {
    utteranceKey: n.utteranceKey,
    participantId: ctx.participantId,
    speakerName: ctx.speakerName,
    startMs: n.startMs,
    text: n.text,
  };
  // Partials are transient: broadcast only, never stored (PRD 4.8: partial may change).
  await publish(ctx.meetingId, "transcript.segment.partial", "transcript", payload);
}

/**
 * Stores a final segment exactly once. A retried write or a reconnecting worker that
 * replays the same result hits the unique dedupeKey and is ignored (PRD 6.3, 16.4).
 */
export async function persistFinal(ctx: StreamContext, r: SttResult) {
  const n = normalize(ctx, r);
  if (!n.text) return null;
  try {
    const segment = await prisma.$transaction(async (tx) => {
      const existing = await tx.transcriptSegment.findUnique({ where: { dedupeKey: n.dedupeKey } });
      if (existing) return null;
      const t = await tx.transcript.update({
        where: { id: ctx.transcriptId },
        data: { nextSequence: { increment: 1 } },
        select: { nextSequence: true },
      });
      return tx.transcriptSegment.create({
        data: {
          transcriptId: ctx.transcriptId,
          participantId: ctx.participantId,
          trackSid: ctx.trackSid,
          sequence: t.nextSequence - 1,
          dedupeKey: n.dedupeKey,
          startMs: BigInt(n.startMs),
          endMs: BigInt(n.endMs),
          timingEstimated: n.timingEstimated,
          originalText: n.text,
          speakerName: ctx.speakerName,
          speakerVerified: ctx.speakerVerified,
          status: n.status,
          confidence: n.confidence,
          provider: ctx.provider,
          providerSegmentId: r.providerSegmentId ?? null,
          language: ctx.language,
          metadata: { epoch: ctx.epoch },
        },
      });
    });
    if (!segment) return null;
    const dto: TranscriptSegmentDTO = {
      id: segment.id,
      sequence: segment.sequence,
      participantId: segment.participantId,
      trackSid: segment.trackSid,
      speakerName: segment.speakerName,
      speakerVerified: segment.speakerVerified,
      startMs: n.startMs,
      endMs: n.endMs,
      timingEstimated: segment.timingEstimated,
      text: segment.originalText,
      originalText: segment.originalText,
      correctedText: null,
      status: segment.status,
      confidence: segment.confidence,
      language: segment.language,
    };
    const payload: FinalSegmentPayload = { utteranceKey: n.utteranceKey, segment: dto };
    await publish(ctx.meetingId, "transcript.segment.final", "transcript", payload, segment.sequence);
    return segment;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    log.error({ err, meetingId: ctx.meetingId, trackSid: ctx.trackSid }, "gagal menyimpan segmen final");
    throw err;
  }
}
