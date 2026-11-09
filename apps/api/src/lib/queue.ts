import { Queue } from "bullmq";
import { prisma, type Prisma } from "@zuum/db";
import { redis } from "./redis";

// Queue names are shared with apps/worker.
export const QUEUES = {
  transcription: "zuum-transcription",
  ai: "zuum-ai",
  maintenance: "zuum-maintenance",
} as const;

const connection = redis;
export const transcriptionQueue = new Queue(QUEUES.transcription, { connection });
export const aiQueue = new Queue(QUEUES.ai, { connection });

export type OutboxTopic = "ai.pipeline" | "transcription.ensure-room";

/**
 * Transactional outbox (PRD 5.3): callers write the event inside the same
 * transaction as the state change; `relayOutbox` moves it to BullMQ afterwards.
 * If the process dies between commit and enqueue, the next relay tick retries.
 */
export function outboxEvent(tx: Prisma.TransactionClient, topic: OutboxTopic, payload: Prisma.InputJsonValue) {
  return tx.outboxEvent.create({ data: { topic, payload } });
}

export async function relayOutbox(log: { error: (o: object, m: string) => void }) {
  const pending = await prisma.outboxEvent.findMany({
    where: { dispatchedAt: null, attempts: { lt: 10 } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const ev of pending) {
    try {
      const payload = ev.payload as Record<string, string>;
      if (ev.topic === "ai.pipeline") {
        // jobId = outbox id makes the enqueue idempotent if the relay runs twice.
        await aiQueue.add("meeting-documents", payload, {
          jobId: `outbox-${ev.id}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 10_000 },
          delay: 3_000,
          removeOnComplete: 500,
          removeOnFail: 1000,
        });
      } else if (ev.topic === "transcription.ensure-room") {
        await transcriptionQueue.add("ensure-room", payload, {
          jobId: `outbox-${ev.id}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: 500,
          removeOnFail: 1000,
        });
      }
      await prisma.outboxEvent.update({ where: { id: ev.id }, data: { dispatchedAt: new Date() } });
    } catch (err) {
      log.error({ err, outboxId: ev.id }, "outbox relay gagal");
      await prisma.outboxEvent.update({
        where: { id: ev.id },
        data: { attempts: { increment: 1 }, lastError: String(err).slice(0, 500) },
      });
    }
  }
}
