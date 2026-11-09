import { z } from "zod";

// Structured output contract for the AI pipeline (PRD 4.9, 7.3).
// The model fills these; the validator below then checks every evidence id,
// timestamp and participant id against the real transcript before anything is saved.

export const TopicSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  startMs: z.number().int().nonnegative().nullable(),
  endMs: z.number().int().nonnegative().nullable(),
  evidenceSegmentIds: z.array(z.string()),
  contributorParticipantIds: z.array(z.string()),
});

export const DecisionSchema = z.object({
  description: z.string().min(1),
  context: z.string().nullable(),
  status: z.enum(["proposed", "confirmed", "rejected", "needs_review"]),
  evidenceSegmentIds: z.array(z.string()),
  confidence: z.number().min(0).max(1).nullable(),
});

export const ActionItemSchema = z.object({
  description: z.string().min(1),
  // Only when explicitly named in the transcript. Never inferred.
  assigneeParticipantId: z.string().nullable(),
  // ISO date (YYYY-MM-DD), only when explicitly stated.
  dueDate: z.string().nullable(),
  evidenceSegmentIds: z.array(z.string()),
  confidence: z.number().min(0).max(1).nullable(),
});

export const ConflictSchema = z.object({
  description: z.string().min(1),
  evidenceSegmentIds: z.array(z.string()),
});

export const ChunkExtractionSchema = z.object({
  topics: z.array(TopicSchema),
  decisions: z.array(DecisionSchema),
  actionItems: z.array(ActionItemSchema),
  conflicts: z.array(ConflictSchema),
});
export type ChunkExtraction = z.infer<typeof ChunkExtractionSchema>;

export const SummarySchema = z.object({
  overview: z.string().min(1),
  purpose: z.string().nullable(),
  keyPoints: z.array(z.string()),
});
export type SummaryOutput = z.infer<typeof SummarySchema>;

export const MinutesSchema = z.object({
  agenda: z.array(z.string()),
  sections: z.array(
    z.object({
      topic: z.string(),
      discussion: z.string(),
    }),
  ),
  closingNotes: z.string().nullable(),
});
export type MinutesOutput = z.infer<typeof MinutesSchema>;

export const NOT_MENTIONED = "Tidak disebutkan";
export const UNASSIGNED = "Belum ditentukan";

export interface EvidenceContext {
  segmentIds: Set<string>;
  participantIds: Set<string>;
  segmentTimes: Map<string, { startMs: number; endMs: number }>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Drops references that do not exist in the transcript and downgrades any
 * decision or action item left without evidence to needs_review. Returns the
 * cleaned output plus a list of issues for the job log.
 */
export function enforceEvidence(output: ChunkExtraction, ctx: EvidenceContext) {
  const issues: ValidationIssue[] = [];
  const keepKnown = (ids: string[], path: string) => {
    const known = ids.filter((id) => ctx.segmentIds.has(id));
    if (known.length !== ids.length) {
      issues.push({ path, message: `${ids.length - known.length} referensi segmen tidak dikenal dibuang` });
    }
    return [...new Set(known)];
  };

  const topics = output.topics.map((t, i) => {
    const evidenceSegmentIds = keepKnown(t.evidenceSegmentIds, `topics[${i}]`);
    const times = evidenceSegmentIds.map((id) => ctx.segmentTimes.get(id)!).filter(Boolean);
    // Timestamps come from the evidence, not from the model, whenever evidence exists.
    const startMs = times.length ? Math.min(...times.map((x) => x.startMs)) : t.startMs;
    const endMs = times.length ? Math.max(...times.map((x) => x.endMs)) : t.endMs;
    return {
      ...t,
      evidenceSegmentIds,
      startMs,
      endMs,
      contributorParticipantIds: t.contributorParticipantIds.filter((id) => ctx.participantIds.has(id)),
    };
  });

  const decisions = output.decisions.map((d, i) => {
    const evidenceSegmentIds = keepKnown(d.evidenceSegmentIds, `decisions[${i}]`);
    let status = d.status;
    if (evidenceSegmentIds.length === 0 && status !== "needs_review") {
      issues.push({ path: `decisions[${i}]`, message: "tanpa bukti, status diubah ke needs_review" });
      status = "needs_review";
    }
    return { ...d, evidenceSegmentIds, status };
  });

  const actionItems = output.actionItems.map((a, i) => {
    const evidenceSegmentIds = keepKnown(a.evidenceSegmentIds, `actionItems[${i}]`);
    let assigneeParticipantId = a.assigneeParticipantId;
    if (assigneeParticipantId && !ctx.participantIds.has(assigneeParticipantId)) {
      issues.push({ path: `actionItems[${i}].assignee`, message: "penanggung jawab tidak dikenal, dikosongkan" });
      assigneeParticipantId = null;
    }
    let dueDate = a.dueDate;
    if (dueDate && !ISO_DATE.test(dueDate)) {
      issues.push({ path: `actionItems[${i}].dueDate`, message: "format tenggat tidak valid, dikosongkan" });
      dueDate = null;
    }
    return { ...a, evidenceSegmentIds, assigneeParticipantId, dueDate, needsReview: evidenceSegmentIds.length === 0 };
  });

  const conflicts = output.conflicts.map((c, i) => ({
    ...c,
    evidenceSegmentIds: keepKnown(c.evidenceSegmentIds, `conflicts[${i}]`),
  }));

  return { topics, decisions, actionItems, conflicts, issues };
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/** Merges per-chunk results. Items with the same normalized description are deduplicated and their evidence unioned. */
export function mergeExtractions(chunks: ReturnType<typeof enforceEvidence>[]) {
  const mergeBy = <T extends { evidenceSegmentIds: string[] }>(items: T[], key: (t: T) => string) => {
    const map = new Map<string, T>();
    for (const item of items) {
      const k = normalize(key(item));
      const existing = map.get(k);
      if (existing) {
        existing.evidenceSegmentIds = [...new Set([...existing.evidenceSegmentIds, ...item.evidenceSegmentIds])];
      } else {
        map.set(k, { ...item, evidenceSegmentIds: [...item.evidenceSegmentIds] });
      }
    }
    return [...map.values()];
  };
  return {
    topics: mergeBy(chunks.flatMap((c) => c.topics), (t) => t.title),
    decisions: mergeBy(chunks.flatMap((c) => c.decisions), (d) => d.description),
    actionItems: mergeBy(chunks.flatMap((c) => c.actionItems), (a) => a.description),
    conflicts: mergeBy(chunks.flatMap((c) => c.conflicts), (c) => c.description),
    issues: chunks.flatMap((c) => c.issues),
  };
}
