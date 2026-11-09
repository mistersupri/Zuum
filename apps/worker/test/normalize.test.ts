import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({ config: { STT_REVIEW_CONFIDENCE: 0.55 } }));
vi.mock("../src/shared", () => ({ log: { error: vi.fn() }, publish: vi.fn() }));
vi.mock("@zuum/db", () => ({ prisma: {}, Prisma: { PrismaClientKnownRequestError: class {} } }));

const { normalize } = await import("../src/transcription/sink");

const ctx = {
  meetingId: "m",
  transcriptId: "t",
  participantId: "p",
  speakerName: "Rina",
  speakerVerified: true,
  trackSid: "TR_1",
  streamStartedAt: 1_000_000 + 60_000,
  meetingStartedAt: 1_000_000,
  epoch: "e1",
  provider: "mock",
  language: "id-ID",
};

describe("normalize (PRD 6.1 step 9, 6.2)", () => {
  it("maps provider timing onto the meeting timeline", () => {
    const n = normalize(ctx, { index: 3, isFinal: true, text: " Halo ", startSec: 2, endSec: 4.5, confidence: 0.9 });
    expect(n.startMs).toBe(62_000);
    expect(n.endMs).toBe(64_500);
    expect(n.text).toBe("Halo");
    expect(n.timingEstimated).toBe(false);
    expect(n.dedupeKey).toBe("TR_1:e1:3");
  });

  it("marks low-confidence results for review and estimates missing timing", () => {
    const n = normalize(ctx, { index: 0, isFinal: true, text: "x", startSec: null, endSec: null, confidence: 0.2 }, ctx.streamStartedAt + 10_000);
    expect(n.status).toBe("NEEDS_REVIEW");
    expect(n.timingEstimated).toBe(true);
    expect(n.endMs).toBe(70_000);
  });

  it("produces the same dedupe key for a replayed result, so a retry cannot store a duplicate final", () => {
    const r = { index: 7, isFinal: true, text: "a", startSec: 1, endSec: 2, confidence: 1 };
    expect(normalize(ctx, r).dedupeKey).toBe(normalize(ctx, r).dedupeKey);
  });
});
