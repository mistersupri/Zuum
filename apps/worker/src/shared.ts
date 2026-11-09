import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import pino from "pino";
import { redisChannelForMeeting, type EventAudience, type RealtimeEvent, type RealtimeEventType } from "@zuum/shared";
import { config } from "./config";

export const log = pino({
  level: config.NODE_ENV === "test" ? "warn" : "info",
  transport: config.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
  // Transcript text is never logged by default (PRD 14).
  redact: ["text", "*.text", "token", "*.token"],
});

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export async function publish<P>(meetingId: string, type: RealtimeEventType, audience: EventAudience, payload: P, version = Date.now()) {
  const ev: RealtimeEvent<P> = {
    eventId: randomUUID(),
    type,
    meetingId,
    occurredAt: new Date().toISOString(),
    version,
    audience,
    payload,
  };
  await redis.publish(redisChannelForMeeting(meetingId), JSON.stringify(ev));
}

export const QUEUES = {
  transcription: "zuum-transcription",
  ai: "zuum-ai",
} as const;

/** Redis lease with heartbeat. Used to guarantee one active transcriber per room and per track. */
export class Lease {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    readonly key: string,
    private readonly ttlMs = 15_000,
  ) {}

  async acquire(): Promise<boolean> {
    const ok = await redis.set(this.key, config.WORKER_ID, "PX", this.ttlMs, "NX");
    if (ok !== "OK") return false;
    this.timer = setInterval(() => {
      // Extend only if we still own it.
      redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
          1,
          this.key,
          config.WORKER_ID,
          String(this.ttlMs),
        )
        .catch(() => undefined);
    }, this.ttlMs / 3);
    return true;
  }

  async release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        this.key,
        config.WORKER_ID,
      )
      .catch(() => undefined);
  }
}

export const roomLeaseKey = (roomName: string) => `zuum:tx:room:${roomName}`;
export const trackLeaseKey = (trackSid: string) => `zuum:tx:track:${trackSid}`;
