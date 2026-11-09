import { prisma, type Meeting } from "@zuum/db";
import { formatTimestamp, orderSegments, segmentLine } from "@zuum/shared";
import { renderDocx, renderPdf, type DocBlock } from "./render";
import { fileSlug, formatMeetingDate } from "./format";

export interface ExportFile {
  body: Buffer | string;
  mime: string;
  fileName: string;
}

export async function loadFinalSegments(meetingId: string) {
  const transcript = await prisma.transcript.findUnique({ where: { meetingId } });
  if (!transcript) return { transcript: null, segments: [] };
  const rows = await prisma.transcriptSegment.findMany({ where: { transcriptId: transcript.id, status: { not: "PARTIAL" } } });
  const duplicates = new Set<string>(((transcript.metadata as { duplicateSegmentIds?: string[] } | null)?.duplicateSegmentIds) ?? []);
  const segments = orderSegments(
    rows
      .filter((r) => !duplicates.has(r.id))
      .map((r) => ({
        id: r.id,
        participantId: r.participantId,
        speakerName: r.speakerName,
        speakerVerified: r.speakerVerified,
        startMs: Number(r.startMs),
        endMs: Number(r.endMs),
        text: r.correctedText ?? r.originalText,
        originalText: r.originalText,
        corrected: r.correctedText !== null,
        status: r.status,
        confidence: r.confidence,
      })),
  );
  return { transcript, segments };
}

export async function exportTranscript(meeting: Meeting, format: "txt" | "json" | "docx" | "pdf"): Promise<ExportFile> {
  const { transcript, segments } = await loadFinalSegments(meeting.id);
  const base = `transkrip-${fileSlug(meeting.title)}`;

  if (format === "json") {
    return {
      mime: "application/json; charset=utf-8",
      fileName: `${base}.json`,
      body: JSON.stringify(
        {
          meeting: { id: meeting.id, title: meeting.title, startedAt: meeting.startedAt, endedAt: meeting.endedAt, timezone: meeting.timezone },
          transcript: transcript && { status: transcript.status, version: transcript.version, language: transcript.language },
          segments,
        },
        null,
        2,
      ),
    };
  }

  const header = [
    `Transkrip: ${meeting.title}`,
    `Tanggal: ${formatMeetingDate(meeting)}`,
    `Status transkrip: ${transcript?.status ?? "Tidak tersedia"}`,
  ];

  if (format === "txt") {
    const lines = segments.map((s) => segmentLine(s) + (s.corrected ? " [dikoreksi]" : ""));
    return {
      mime: "text/plain; charset=utf-8",
      fileName: `${base}.txt`,
      body: [...header, "", ...(lines.length ? lines : ["Tidak ada segmen transkrip."])].join("\n"),
    };
  }

  const blocks: DocBlock[] = [
    { kind: "title", text: `Transkrip ${meeting.title}` },
    { kind: "meta", text: header.slice(1).join("  ·  ") },
    ...(segments.length
      ? segments.map<DocBlock>((s) => ({
          kind: "line",
          label: `${formatTimestamp(s.startMs)}  ${s.speakerName}${s.speakerVerified === false ? " (belum terverifikasi)" : ""}`,
          text: s.text + (s.corrected ? " [dikoreksi]" : ""),
        }))
      : [{ kind: "para", text: "Tidak ada segmen transkrip." } as DocBlock]),
  ];
  if (format === "docx") {
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: `${base}.docx`,
      body: await renderDocx(blocks),
    };
  }
  return { mime: "application/pdf", fileName: `${base}.pdf`, body: await renderPdf(blocks) };
}
