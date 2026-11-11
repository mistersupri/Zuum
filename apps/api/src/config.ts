import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_SECRET: z.string().min(32, "JWT_SECRET minimal 32 karakter"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  GUEST_TOKEN_TTL_SECONDS: z.coerce.number().default(12 * 3600),
  REQUIRE_EMAIL_VERIFICATION: bool,

  LIVEKIT_URL: z.string().default("ws://localhost:7880"),
  LIVEKIT_API_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string(),
  LIVEKIT_API_SECRET: z.string(),
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().default(600),
  RECORD_INDIVIDUAL_AUDIO: bool,

  S3_ENDPOINT: z.string().optional(),
  // Browser-reachable endpoint used only to sign download URLs (e.g. http://<host>:9000 when
  // S3_ENDPOINT is the internal http://rustfs:9000). Defaults to S3_ENDPOINT.
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("zuum-recordings"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(600),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Zuum <no-reply@localhost>"),

  CONSENT_NOTICE_VERSION: z.string().default("2026-11-v1"),
  TRUST_PROXY: bool,
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Konfigurasi environment tidak valid:\n${lines}`);
  }
  return parsed.data;
}

export const config = load();
export const livekitHttpUrl = () =>
  config.LIVEKIT_API_URL ?? config.LIVEKIT_URL.replace(/^ws(s?):\/\//, "http$1://");
