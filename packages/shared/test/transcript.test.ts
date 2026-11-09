import { describe, expect, it } from "vitest";
import { chunkTranscript, findGaps, formatTimestamp, orderSegments, segmentLine } from "../src/transcript";

const seg = (id: string, startMs: number, endMs: number, text = "teks", participantId: string | null = "p1") => ({
  id,
  participantId,
  speakerName: participantId ?? "?",
  startMs,
  endMs,
  text,
  status: "FINAL",
});

describe("transcript helpers", () => {
  it("orders by timeline and keeps overlapping speakers separate", () => {
    const out = orderSegments([seg("b", 5000, 7000, "x", "p2"), seg("a", 5000, 6000, "y", "p1"), seg("c", 1000, 2000)]);
    expect(out.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("reports long silences as gaps", () => {
    const gaps = findGaps([seg("a", 0, 1000), seg("b", 200_000, 201_000)], 120_000);
    expect(gaps).toEqual([{ afterSegmentId: "a", startMs: 1000, endMs: 200_000 }]);
  });

  it("chunks without splitting a segment and respects the size limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => seg(`s${i}`, i * 1000, i * 1000 + 900, "x".repeat(100)));
    const chunks = chunkTranscript(many, { maxChars: 1500, maxDurationMs: 10 * 60_000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.segments.map((s) => s.id))).toEqual(many.map((s) => s.id));
  });

  it("formats timestamps and marks unverified speakers", () => {
    expect(formatTimestamp(65_000)).toBe("01:05");
    expect(formatTimestamp(3_725_000)).toBe("1:02:05");
    expect(segmentLine({ ...seg("a", 0, 1), speakerVerified: false })).toContain("pembicara belum terverifikasi");
  });
});
