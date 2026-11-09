import { prisma, type AIJobType, type Meeting, type Prisma } from "@zuum/db";
import {
  ChunkExtractionSchema,
  MinutesSchema,
  SummarySchema,
  chunkTranscript,
  enforceEvidence,
  findGaps,
  mergeExtractions,
  orderSegments,
  formatTimestamp,
  NOT_MENTIONED,
} from "@zuum/shared";
import { log, publish, redis, roomLeaseKey } from "../shared";
import { LlmError, llmProvider, type LlmUsage } from "./llm";
import { EXTRACTION_SYSTEM, MINUTES_SYSTEM, PROMPT_VERSION, SUMMARY_SYSTEM } from "./prompts";

export interface PipelineJob {
  meetingId: string;
  trigger: "auto" | "manual";
  runKey: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withJob<T>(meetingId: string, type: AIJobType, key: string, fn: (jobId: string) => Promise<T>) {
  // idempotencyKey makes BullMQ retries reuse the same AIJob row.
  const job = await prisma.aIJob.upsert({
    where: { idempotencyKey: key },
    create: { meetingId, type, idempotencyKey: key, status: "QUEUED", promptVersion: PROMPT_VERSION },
    update: {},
  });
  if (job.status === "COMPLETED") return null;
  await prisma.aIJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, errorCode: null, errorMessage: null },
  });
  await publish(meetingId, "ai.job.started", "participants", { jobId: job.id, type });
  try {
    const result = await fn(job.id);
    await prisma.aIJob.update({ where: { id: job.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await publish(meetingId, "ai.job.completed", "participants", { jobId: job.id, type });
    return result;
  } catch (err) {
    const code = err instanceof LlmError ? err.code : "PIPELINE_ERROR";
    const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
    await prisma.aIJob.update({ where: { id: job.id }, data: { status: "FAILED", errorCode: code, errorMessage: message } });
    await publish(meetingId, "ai.job.failed", "participants", { jobId: job.id, type, errorCode: code });
    throw err;
  }
}

/** PRD 7.1 step 2: wait until the live transcription worker has flushed and released the room. */
async function waitForTranscriptFlush(meeting: Meeting) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const held = await redis.exists(roomLeaseKey(meeting.livekitRoomName));
    if (!held) return true;
    await sleep(2000);
  }
  return false;
}

/** PRD 7.1 steps 3-4: order, dedupe, mark gaps, snapshot as a new transcript version. */
async function finalizeTranscript(meeting: Meeting, flushed: boolean) {
  const transcript = await prisma.transcript.findUniqueOrThrow({ where: { meetingId: meeting.id } });
  const rows = await prisma.transcriptSegment.findMany({ where: { transcriptId: transcript.id } });
  const segs = orderSegments(
    rows.map((r) => ({
      id: r.id,
      participantId: r.participantId,
      speakerName: r.speakerName,
      speakerVerified: r.speakerVerified,
      startMs: Number(r.startMs),
      endMs: Number(r.endMs),
      text: r.correctedText ?? r.originalText,
      status: r.status,
    })),
  );

  // Same speaker, same text, overlapping time: keep the first, list the rest as duplicates.
  // Final segments are never deleted; duplicates are excluded from exports and AI input.
  const duplicates: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1]!;
    const b = segs[i]!;
    if (a.participantId === b.participantId && a.text.trim() === b.text.trim() && b.startMs <= a.endMs) duplicates.push(b.id);
  }
  const gaps = findGaps(segs);
  const prevMeta = (transcript.metadata as Record<string, unknown> | null) ?? {};
  const partial = !flushed || transcript.errorCode === "WORKER_ERRORS";
  await prisma.transcript.update({
    where: { id: transcript.id },
    data: {
      status: segs.length === 0 && partial ? "PARTIAL" : partial ? "PARTIAL" : "COMPLETED",
      finalizedAt: new Date(),
      version: { increment: 1 },
      metadata: { ...prevMeta, duplicateSegmentIds: duplicates, gaps, flushed } as unknown as Prisma.InputJsonValue,
    },
  });
  await publish(meeting.id, "transcript.status.updated", "participants", { status: partial ? "PARTIAL" : "COMPLETED" });
  const dupSet = new Set(duplicates);
  return segs.filter((s) => !dupSet.has(s.id));
}

export async function runPipeline(job: PipelineJob) {
  const meeting = await prisma.meeting.findUnique({
    where: { id: job.meetingId },
    include: { owner: { select: { displayName: true } } },
  });
  if (!meeting) return;
  if (meeting.status !== "ENDED") {
    log.warn({ meetingId: meeting.id }, "pipeline dilewati: meeting belum berakhir");
    return;
  }
  const key = (t: string) => `${meeting.id}:${job.runKey}:${t}`;

  const flushed = job.trigger === "auto" ? await waitForTranscriptFlush(meeting) : true;
  const segments =
    (await withJob(meeting.id, "TRANSCRIPT_FINALIZE", key("finalize"), () => finalizeTranscript(meeting, flushed))) ??
    // Retry of a run whose finalize already completed: reload without re-finalizing.
    (await reloadSegments(meeting.id));

  await withJob(meeting.id, "FULL_MEETING_DOCUMENT", key("document"), async (jobId) => {
    if (segments.length === 0) {
      // Nothing to summarize. Store an honest empty result instead of asking the model to invent one.
      await prisma.aIJob.update({ where: { id: jobId }, data: { errorCode: "TRANSCRIPT_EMPTY", errorMessage: "Transkrip kosong." } });
      return;
    }
    const llm = llmProvider();
    const usage: LlmUsage[] = [];
    await prisma.aIJob.update({ where: { id: jobId }, data: { provider: llm.name, model: llm.model } });

    const participants = await prisma.meetingParticipant.findMany({
      where: { meetingId: meeting.id, status: { in: ["JOINED", "LEFT"] } },
      select: { id: true, displayName: true, role: true },
    });
    const meetingDate = new Intl.DateTimeFormat("en-CA", { timeZone: meeting.timezone }).format(meeting.startedAt ?? meeting.createdAt);
    const metaBlock = [
      `Judul rapat: ${meeting.title}`,
      `Tanggal rapat: ${meetingDate} (${meeting.timezone})`,
      `Agenda tertulis: ${meeting.agenda.length ? meeting.agenda.join("; ") : NOT_MENTIONED}`,
      `Deskripsi: ${meeting.description ?? NOT_MENTIONED}`,
      `Peserta (id: nama):`,
      ...participants.map((p) => `- ${p.id}: ${p.displayName}`),
    ].join("\n");

    const ctx = {
      segmentIds: new Set(segments.map((s) => s.id)),
      participantIds: new Set(participants.map((p) => p.id)),
      segmentTimes: new Map(segments.map((s) => [s.id, { startMs: s.startMs, endMs: s.endMs }])),
    };
    const render = (list: typeof segments) =>
      list
        .map(
          (s) =>
            `id=${s.id} | ${formatTimestamp(s.startMs)} | ${s.participantId ?? "tanpa-id"} | ${s.speakerName}${s.speakerVerified === false ? " (belum terverifikasi)" : ""}: ${s.text}`,
        )
        .join("\n");

    // PRD 7.1 steps 5-7: chunk, extract per chunk, merge and dedupe.
    const chunks = chunkTranscript(segments);
    const extracted = [];
    for (const chunk of chunks) {
      const res = await llm.structured({
        system: EXTRACTION_SYSTEM,
        user: `${metaBlock}\n\nPotongan ${chunk.index + 1} dari ${chunks.length} (${formatTimestamp(chunk.startMs)} sampai ${formatTimestamp(chunk.endMs)}).\n<transkrip>\n${render(chunk.segments)}\n</transkrip>`,
        schema: ChunkExtractionSchema,
      });
      usage.push(res.usage);
      extracted.push(enforceEvidence(res.data, ctx));
    }
    const merged = mergeExtractions(extracted);

    // PRD 7.1 step 8: summary from structured results + transcript (transcript only if it fits).
    const fullText = render(segments);
    const structuredBlock = JSON.stringify(
      { topics: merged.topics.map((t) => ({ title: t.title, summary: t.summary })), decisions: merged.decisions, actionItems: merged.actionItems },
      null,
      1,
    );
    const transcriptForSummary = fullText.length < 120_000 ? `\n<transkrip>\n${fullText}\n</transkrip>` : "";
    const summary = await llm.structured({
      system: SUMMARY_SYSTEM,
      user: `${metaBlock}\n\nHasil ekstraksi terstruktur:\n${structuredBlock}${transcriptForSummary}`,
      schema: SummarySchema,
    });
    usage.push(summary.usage);

    // PRD 7.1 step 9: minutes narrative; identity fields come from the database, not the model.
    const minutes = await llm.structured({
      system: MINUTES_SYSTEM,
      user: `${metaBlock}\n\nTopik:\n${merged.topics.map((t) => `- ${t.title}: ${t.summary}`).join("\n") || "(tidak ada)"}${transcriptForSummary}`,
      schema: MinutesSchema,
    });
    usage.push(minutes.usage);

    // PRD 7.1 steps 10-11: everything is validated; save results with model + prompt version.
    const latest = await prisma.meetingMinutes.findFirst({ where: { meetingId: meeting.id }, orderBy: { version: "desc" } });
    const needsReview = merged.decisions.some((d) => d.status === "needs_review") || merged.actionItems.some((a) => a.needsReview) || merged.conflicts.length > 0;
    const dateLine = (() => {
      const start = meeting.startedAt ?? meeting.createdAt;
      const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("id-ID", { ...o, timeZone: meeting.timezone });
      return `${f({ dateStyle: "full" }).format(start)}, ${f({ timeStyle: "short" }).format(start)}${meeting.endedAt ? ` sampai ${f({ timeStyle: "short" }).format(meeting.endedAt)}` : ""} (${meeting.timezone})`;
    })();

    await prisma.$transaction(async (tx) => {
      await tx.meetingTopic.deleteMany({ where: { meetingId: meeting.id } });
      await tx.meetingDecision.deleteMany({ where: { meetingId: meeting.id } });
      await tx.actionItem.deleteMany({ where: { meetingId: meeting.id } });
      await tx.meetingTopic.createMany({
        data: merged.topics.map((t, i) => ({
          meetingId: meeting.id,
          title: t.title,
          summary: t.summary,
          startMs: t.startMs !== null ? BigInt(t.startMs) : null,
          endMs: t.endMs !== null ? BigInt(t.endMs) : null,
          evidenceSegmentIds: t.evidenceSegmentIds,
          contributorIds: t.contributorParticipantIds,
          sortOrder: i,
        })),
      });
      await tx.meetingDecision.createMany({
        data: merged.decisions.map((d) => ({
          meetingId: meeting.id,
          description: d.description,
          context: d.context,
          status: d.status.toUpperCase() as "PROPOSED" | "CONFIRMED" | "REJECTED" | "NEEDS_REVIEW",
          evidenceSegmentIds: d.evidenceSegmentIds,
          confidence: d.confidence,
        })),
      });
      await tx.actionItem.createMany({
        data: merged.actionItems.map((a) => ({
          meetingId: meeting.id,
          description: a.description,
          assigneeParticipantId: a.assigneeParticipantId,
          dueDate: a.dueDate ? new Date(`${a.dueDate}T00:00:00Z`) : null,
          evidenceSegmentIds: a.evidenceSegmentIds,
          confidence: a.confidence,
          needsReview: a.needsReview,
        })),
      });
      await tx.meetingSummary.upsert({
        where: { meetingId: meeting.id },
        create: {
          meetingId: meeting.id,
          overview: summary.data.overview,
          purpose: summary.data.purpose,
          keyPoints: summary.data.keyPoints,
          needsReview,
          rawOutput: { conflicts: merged.conflicts, issues: merged.issues } as unknown as Prisma.InputJsonValue,
          model: llm.model,
          promptVersion: PROMPT_VERSION,
        },
        update: {
          version: { increment: 1 },
          overview: summary.data.overview,
          purpose: summary.data.purpose,
          keyPoints: summary.data.keyPoints,
          needsReview,
          rawOutput: { conflicts: merged.conflicts, issues: merged.issues } as unknown as Prisma.InputJsonValue,
          generatedAt: new Date(),
          model: llm.model,
          promptVersion: PROMPT_VERSION,
        },
      });
      await tx.meetingMinutes.create({
        data: {
          meetingId: meeting.id,
          version: (latest?.version ?? 0) + 1,
          model: llm.model,
          promptVersion: PROMPT_VERSION,
          content: {
            title: meeting.title,
            dateLine,
            host: meeting.owner.displayName,
            participants: participants.map((p) => p.displayName),
            agenda: meeting.agenda.length ? meeting.agenda : minutes.data.agenda,
            summary: summary.data.overview,
            sections: minutes.data.sections,
            closingNotes: minutes.data.closingNotes,
            disclaimer: `Disusun dengan bantuan AI (${llm.model}) dari transkrip otomatis. Tinjau sebelum disahkan.`,
          },
        },
      });
      await tx.aIJob.update({
        where: { id: jobId },
        data: {
          usage: {
            calls: usage.length,
            inputTokens: usage.reduce((a, u) => a + u.inputTokens, 0),
            outputTokens: usage.reduce((a, u) => a + u.outputTokens, 0),
            issues: merged.issues.length,
          },
        },
      });
    });
  });
}

async function reloadSegments(meetingId: string) {
  const t = await prisma.transcript.findUnique({ where: { meetingId } });
  if (!t) return [];
  const dup = new Set(((t.metadata as { duplicateSegmentIds?: string[] } | null)?.duplicateSegmentIds) ?? []);
  const rows = await prisma.transcriptSegment.findMany({ where: { transcriptId: t.id } });
  return orderSegments(
    rows
      .filter((r) => !dup.has(r.id))
      .map((r) => ({
        id: r.id,
        participantId: r.participantId,
        speakerName: r.speakerName,
        speakerVerified: r.speakerVerified,
        startMs: Number(r.startMs),
        endMs: Number(r.endMs),
        text: r.correctedText ?? r.originalText,
        status: r.status,
      })),
  );
}
