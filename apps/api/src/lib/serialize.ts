import type { TranscriptSegment } from "@zuum/db";
import type { TranscriptSegmentDTO } from "@zuum/shared";

/** Recursively converts BigInt fields so Prisma rows can be sent as JSON. */
export function toJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
}

export function segmentDTO(s: TranscriptSegment): TranscriptSegmentDTO {
  return {
    id: s.id,
    sequence: s.sequence,
    participantId: s.participantId,
    trackSid: s.trackSid,
    speakerName: s.speakerName,
    speakerVerified: s.speakerVerified,
    startMs: Number(s.startMs),
    endMs: Number(s.endMs),
    timingEstimated: s.timingEstimated,
    text: s.correctedText ?? s.originalText,
    originalText: s.originalText,
    correctedText: s.correctedText,
    status: s.status,
    confidence: s.confidence,
    language: s.language,
  };
}
