import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  LIVEKIT_URL: z.string().default("ws://localhost:7880"),
  LIVEKIT_API_KEY: z.string(),
  LIVEKIT_API_SECRET: z.string(),

  // "deepgram" for production; "mock" only for local pipeline testing (labels its output as test text).
  STT_PROVIDER: z.enum(["deepgram", "mock"]).default("deepgram"),
  STT_LANGUAGE: z.string().default("id"),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-2"),
  // Below this confidence a final segment is stored as NEEDS_REVIEW.
  STT_REVIEW_CONFIDENCE: z.coerce.number().default(0.55),

  LLM_PROVIDER: z.enum(["anthropic", "mock"]).default("anthropic"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),

  TRANSCRIPTION_CONCURRENCY: z.coerce.number().default(20),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
});

export const config = schema.parse(process.env);
