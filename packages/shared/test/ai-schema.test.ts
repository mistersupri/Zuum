import { describe, expect, it } from "vitest";
import { enforceEvidence, mergeExtractions, type ChunkExtraction } from "../src/ai-schema";

const ctx = {
  segmentIds: new Set(["s1", "s2", "s3"]),
  participantIds: new Set(["p1", "p2"]),
  segmentTimes: new Map([
    ["s1", { startMs: 1000, endMs: 4000 }],
    ["s2", { startMs: 5000, endMs: 9000 }],
    ["s3", { startMs: 20000, endMs: 26000 }],
  ]),
};

const base: ChunkExtraction = { topics: [], decisions: [], actionItems: [], conflicts: [] };

describe("enforceEvidence", () => {
  it("drops unknown segment ids and downgrades a decision left without evidence to needs_review", () => {
    const out = enforceEvidence(
      { ...base, decisions: [{ description: "Laporan dikumpulkan Jumat", context: null, status: "confirmed", evidenceSegmentIds: ["seg_hallucinated"], confidence: 0.9 }] },
      ctx,
    );
    expect(out.decisions[0]!.evidenceSegmentIds).toEqual([]);
    expect(out.decisions[0]!.status).toBe("needs_review");
    expect(out.issues.length).toBeGreaterThan(0);
  });

  it("keeps a confirmed decision that has real evidence", () => {
    const out = enforceEvidence(
      { ...base, decisions: [{ description: "Disepakati", context: null, status: "confirmed", evidenceSegmentIds: ["s2"], confidence: 0.8 }] },
      ctx,
    );
    expect(out.decisions[0]!.status).toBe("confirmed");
  });

  it("never keeps an assignee who is not a participant, nor a malformed due date", () => {
    const out = enforceEvidence(
      { ...base, actionItems: [{ description: "Kirim laporan", assigneeParticipantId: "p_unknown", dueDate: "Jumat depan", evidenceSegmentIds: ["s1"], confidence: null }] },
      ctx,
    );
    expect(out.actionItems[0]!.assigneeParticipantId).toBeNull();
    expect(out.actionItems[0]!.dueDate).toBeNull();
    expect(out.actionItems[0]!.needsReview).toBe(false);
  });

  it("derives topic time range from evidence instead of trusting the model", () => {
    const out = enforceEvidence(
      { ...base, topics: [{ title: "Anggaran", summary: "x", startMs: 0, endMs: 999999, evidenceSegmentIds: ["s2", "s3"], contributorParticipantIds: ["p1", "ghost"] }] },
      ctx,
    );
    expect(out.topics[0]!.startMs).toBe(5000);
    expect(out.topics[0]!.endMs).toBe(26000);
    expect(out.topics[0]!.contributorParticipantIds).toEqual(["p1"]);
  });
});

describe("mergeExtractions", () => {
  it("deduplicates items across chunks and unions their evidence", () => {
    const a = enforceEvidence({ ...base, actionItems: [{ description: "Kirim laporan.", assigneeParticipantId: null, dueDate: null, evidenceSegmentIds: ["s1"], confidence: null }] }, ctx);
    const b = enforceEvidence({ ...base, actionItems: [{ description: "kirim laporan", assigneeParticipantId: null, dueDate: null, evidenceSegmentIds: ["s3"], confidence: null }] }, ctx);
    const merged = mergeExtractions([a, b]);
    expect(merged.actionItems).toHaveLength(1);
    expect(merged.actionItems[0]!.evidenceSegmentIds.sort()).toEqual(["s1", "s3"]);
  });
});
