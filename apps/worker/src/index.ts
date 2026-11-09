import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { prisma } from "@zuum/db";
import { config } from "./config";
import { log, redis, QUEUES, roomLeaseKey } from "./shared";
import { RoomAgent } from "./transcription/room-agent";
import { runPipeline, type PipelineJob } from "./ai/pipeline";
import { LlmError } from "./ai/llm";

const agents = new Map<string, RoomAgent>();
const agentMeeting = new Map<string, string>(); // roomName -> meetingId

// Stop the room agent as soon as the API announces the meeting ended.
const sub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
void sub.psubscribe("zuum:meeting:*");
sub.on("pmessage", (_p, _c, message) => {
  try {
    const ev = JSON.parse(message) as { type: string; meetingId: string };
    if (ev.type !== "meeting.ended") return;
    for (const [room, mid] of agentMeeting) {
      if (mid === ev.meetingId) void agents.get(room)?.stop("meeting-ended");
    }
  } catch {
    /* ignore malformed */
  }
});

async function ensureRoom(meetingId: string, roomName: string) {
  if (agents.has(roomName) || agents.size >= config.TRANSCRIPTION_CONCURRENCY) return;
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting || meeting.status !== "LIVE" || !meeting.transcriptionEnabled) return;
  const agent = await RoomAgent.start(meetingId, roomName);
  if (!agent) return;
  agents.set(roomName, agent);
  agentMeeting.set(roomName, meetingId);
  void agent.finished.then(() => {
    agents.delete(roomName);
    agentMeeting.delete(roomName);
  });
}

const transcriptionWorker = new Worker(
  QUEUES.transcription,
  async (job: Job<{ meetingId: string; roomName: string }>) => {
    await ensureRoom(job.data.meetingId, job.data.roomName);
  },
  { connection: redis, concurrency: 5 },
);

const aiWorker = new Worker(
  QUEUES.ai,
  async (job: Job<PipelineJob>) => {
    try {
      await runPipeline(job.data);
    } catch (err) {
      // Non-retryable errors (missing key, refusal) stop BullMQ retries; status is already on the AIJob row.
      if (err instanceof LlmError && !err.retryable) {
        log.warn({ meetingId: job.data.meetingId, code: err.code }, "pipeline AI berhenti");
        return;
      }
      throw err;
    }
  },
  { connection: redis, concurrency: 2, lockDuration: 10 * 60_000 },
);

for (const w of [transcriptionWorker, aiWorker]) {
  w.on("failed", (job, err) => log.error({ err, jobId: job?.id, queue: w.name }, "job gagal"));
}

/**
 * Crash recovery: if a worker died, its lease expires; this loop picks up live meetings
 * whose room has no active transcriber.
 */
async function reconcile() {
  // Safety net for a missed meeting.ended event or a room that closed without a Disconnected event.
  for (const [room, mid] of agentMeeting) {
    const m = await prisma.meeting.findUnique({ where: { id: mid }, select: { status: true } });
    if (!m || m.status !== "LIVE") void agents.get(room)?.stop("reconcile");
  }
  const live = await prisma.meeting.findMany({
    where: { status: "LIVE", transcriptionEnabled: true },
    select: { id: true, livekitRoomName: true },
    take: 200,
  });
  for (const m of live) {
    if (agents.has(m.livekitRoomName)) continue;
    if (await redis.exists(roomLeaseKey(m.livekitRoomName))) continue;
    // Webhooks normally trigger the agent; this covers missed webhooks and crashed workers.
    const present = await prisma.meetingParticipant.count({ where: { meetingId: m.id, status: "JOINED" } });
    if (present) await ensureRoom(m.id, m.livekitRoomName).catch((err) => log.warn({ err }, "reconcile gagal"));
  }
}
const reconcileTimer = setInterval(() => void reconcile().catch(() => undefined), 15_000);

log.info({ version: process.env.APP_VERSION ?? "dev", stt: config.STT_PROVIDER, llm: config.LLM_PROVIDER, worker: config.WORKER_ID }, "worker Zuum aktif");

async function shutdown() {
  clearInterval(reconcileTimer);
  await Promise.all([transcriptionWorker.close(), aiWorker.close()]);
  await Promise.all([...agents.values()].map((a) => a.stop("shutdown")));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
