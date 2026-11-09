import { prisma, type Meeting } from "@zuum/db";
import { NOT_MENTIONED, UNASSIGNED } from "@zuum/shared";
import { renderDocx, renderPdf, type DocBlock } from "./render";
import { fileSlug, formatMeetingDate } from "./format";
import type { ExportFile } from "./transcript";

export interface MinutesContent {
  title: string;
  dateLine: string;
  host: string;
  participants: string[];
  agenda: string[];
  summary: string;
  sections: { topic: string; discussion: string }[];
  closingNotes: string | null;
  disclaimer: string;
}

const DECISION_LABEL: Record<string, string> = {
  CONFIRMED: "Disepakati",
  PROPOSED: "Diusulkan",
  REJECTED: "Ditolak",
  NEEDS_REVIEW: "Perlu ditinjau",
};

/**
 * Builds the formal minutes. Narrative comes from the stored minutes version; decisions
 * and action items are read live so reviewer edits always show up in the export.
 */
export async function buildMinutesBlocks(meeting: Meeting): Promise<DocBlock[] | null> {
  const minutes = await prisma.meetingMinutes.findFirst({ where: { meetingId: meeting.id }, orderBy: { version: "desc" } });
  if (!minutes) return null;
  const c = minutes.content as unknown as MinutesContent;
  const [decisions, actions] = await Promise.all([
    prisma.meetingDecision.findMany({ where: { meetingId: meeting.id }, orderBy: { createdAt: "asc" } }),
    prisma.actionItem.findMany({
      where: { meetingId: meeting.id, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "asc" },
      include: { assignee: { select: { displayName: true } } },
    }),
  ]);
  const fmtDate = (d: Date | null) =>
    d ? new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: "UTC" }).format(d) : NOT_MENTIONED;

  return [
    { kind: "title", text: `Notulen Rapat: ${c.title}` },
    { kind: "meta", text: `${formatMeetingDate(meeting)}  ·  Versi ${minutes.version}` },
    { kind: "heading", text: "Identitas Rapat" },
    { kind: "bullet", text: `Judul: ${c.title}` },
    { kind: "bullet", text: `Waktu: ${c.dateLine}` },
    { kind: "bullet", text: `Pimpinan rapat: ${c.host}` },
    { kind: "bullet", text: `Peserta (${c.participants.length}): ${c.participants.join(", ") || NOT_MENTIONED}` },
    { kind: "heading", text: "Agenda" },
    ...(c.agenda.length ? c.agenda.map<DocBlock>((a) => ({ kind: "bullet", text: a })) : [{ kind: "para", text: NOT_MENTIONED } as DocBlock]),
    { kind: "heading", text: "Ringkasan" },
    { kind: "para", text: c.summary || NOT_MENTIONED },
    { kind: "heading", text: "Pembahasan" },
    ...(c.sections.length
      ? c.sections.map<DocBlock>((s) => ({ kind: "line", label: s.topic, text: s.discussion }))
      : [{ kind: "para", text: NOT_MENTIONED } as DocBlock]),
    { kind: "heading", text: "Keputusan" },
    ...(decisions.length
      ? decisions.map<DocBlock>((d) => ({ kind: "bullet", text: `${d.description} (${DECISION_LABEL[d.status] ?? d.status})` }))
      : [{ kind: "para", text: NOT_MENTIONED } as DocBlock]),
    { kind: "heading", text: "Tindak Lanjut" },
    ...(actions.length
      ? actions.map<DocBlock>((a) => ({
          kind: "bullet",
          text: `${a.description}. Penanggung jawab: ${a.assignee?.displayName ?? UNASSIGNED}. Tenggat: ${fmtDate(a.dueDate)}.`,
        }))
      : [{ kind: "para", text: NOT_MENTIONED } as DocBlock]),
    ...(c.closingNotes ? [{ kind: "heading", text: "Penutup" } as DocBlock, { kind: "para", text: c.closingNotes } as DocBlock] : []),
    { kind: "meta", text: c.disclaimer },
  ];
}

export async function exportMinutes(meeting: Meeting, format: "docx" | "pdf" | "txt"): Promise<ExportFile | null> {
  const blocks = await buildMinutesBlocks(meeting);
  if (!blocks) return null;
  const base = `notulen-${fileSlug(meeting.title)}`;
  if (format === "txt") {
    const text = blocks
      .map((b) => {
        switch (b.kind) {
          case "title":
            return `${b.text}\n${"=".repeat(Math.min(b.text.length, 72))}`;
          case "heading":
            return `\n${b.text}\n${"-".repeat(b.text.length)}`;
          case "bullet":
            return `- ${b.text}`;
          case "line":
            return `${b.label}\n${b.text}`;
          default:
            return b.text;
        }
      })
      .join("\n");
    return { mime: "text/plain; charset=utf-8", fileName: `${base}.txt`, body: text };
  }
  if (format === "docx") {
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: `${base}.docx`,
      body: await renderDocx(blocks),
    };
  }
  return { mime: "application/pdf", fileName: `${base}.pdf`, body: await renderPdf(blocks) };
}
