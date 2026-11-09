import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  LIVEKIT_URL: z.string().default("ws://localhost:7880"),
  LIVEKIT_API_KEY: z.string(),
  LIVEKIT_API_SECRET: z.string(),

  // whisper: any OpenAI-compatible /audio/transcriptions endpoint. Free when self-hosted
  //          (speaches / faster-whisper, whisper.cpp), cheap on hosted Whisper APIs.
  // deepgram: paid streaming STT with the lowest latency.
  // mock: local pipeline testing only; labels its output as test text.
  STT_PROVIDER: z.enum(["whisper", "deepgram", "mock"]).default("whisper"),
  STT_LANGUAGE: z.string().default("id"),
  WHISPER_BASE_URL: z.string().default("http://localhost:8000/v1"),
  WHISPER_API_KEY: z.string().optional(),
  WHISPER_MODEL: z.string().default("Systran/faster-whisper-small"),
  // 0 = no partial text (cheapest; finals arrive after each utterance ends).
  WHISPER_PARTIAL_INTERVAL_MS: z.coerce.number().default(0),
  WHISPER_NO_SPEECH_THRESHOLD: z.coerce.number().default(0.6),
  WHISPER_TIMEOUT_MS: z.coerce.number().default(60_000),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-2"),
  // Below this confidence a final segment is stored as NEEDS_REVIEW.
  STT_REVIEW_CONFIDENCE: z.coerce.number().default(0.55),

  // ollama: free, self-hosted open model. anthropic: Claude (Haiku 5.5 by default, the low-cost tier).
  LLM_PROVIDER: z.enum(["ollama", "anthropic", "mock"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:7b-instruct"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(10 * 60_000),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  TRANSCRIPTION_CONCURRENCY: z.coerce.number().default(20),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
});

export const config = schema.parse(process.env);
