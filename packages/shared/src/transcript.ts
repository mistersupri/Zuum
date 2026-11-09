// Transcript helpers shared by the worker (live) and the API (finalization, export).

export interface FinalizableSegment {
  id: string;
  participantId: string | null;
  speakerName: string;
  startMs: number;
  endMs: number;
  text: string;
  status: string;
}

/** Orders by meeting timeline; ties broken by speaker then id so the result is deterministic. */
export function orderSegments<T extends FinalizableSegment>(segments: T[]): T[] {
  return [...segments].sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      (a.participantId ?? "").localeCompare(b.participantId ?? "") ||
      a.id.localeCompare(b.id),
  );
}

export interface Gap {
  afterSegmentId: string;
  startMs: number;
  endMs: number;
}

/** Silence longer than `minGapMs` across all speakers is reported as a gap (PRD 7.1 step 3). */
export function findGaps(segments: FinalizableSegment[], minGapMs = 120_000): Gap[] {
  const ordered = orderSegments(segments);
  const gaps: Gap[] = [];
  let maxEnd = -1;
  let lastId: string | null = null;
  for (const s of ordered) {
    if (lastId && s.startMs - maxEnd >= minGapMs) {
      gaps.push({ afterSegmentId: lastId, startMs: maxEnd, endMs: s.startMs });
    }
    if (s.endMs > maxEnd) {
      maxEnd = s.endMs;
      lastId = s.id;
    }
  }
  return gaps;
}

export interface TranscriptChunk<T> {
  index: number;
  segments: T[];
  startMs: number;
  endMs: number;
}

/**
 * Splits a transcript for LLM extraction. Chunks close at `maxChars` or `maxDurationMs`,
 * never inside a segment, so evidence ids always point at whole segments.
 */
export function chunkTranscript<T extends FinalizableSegment>(
  segments: T[],
  { maxChars = 24_000, maxDurationMs = 20 * 60_000 } = {},
): TranscriptChunk<T>[] {
  const chunks: TranscriptChunk<T>[] = [];
  let current: T[] = [];
  let chars = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push({
      index: chunks.length,
      segments: current,
      startMs: current[0]!.startMs,
      endMs: Math.max(...current.map((s) => s.endMs)),
    });
    current = [];
    chars = 0;
  };
  for (const seg of orderSegments(segments)) {
    const len = seg.text.length + seg.speakerName.length + 32;
    const tooLong = chars + len > maxChars;
    const tooWide = current.length > 0 && seg.startMs - current[0]!.startMs > maxDurationMs;
    if (current.length && (tooLong || tooWide)) flush();
    current.push(seg);
    chars += len;
  }
  flush();
  return chunks;
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Plain-text line used both for the TXT export and as LLM input. */
export function segmentLine(seg: FinalizableSegment & { speakerVerified?: boolean }): string {
  const who = seg.speakerVerified === false ? `${seg.speakerName} (pembicara belum terverifikasi)` : seg.speakerName;
  return `[${formatTimestamp(seg.startMs)}] ${who}: ${seg.text}`;
}
