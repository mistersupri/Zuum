import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { config } from "./config";
import { AppError } from "./lib/errors";
import { verifyToken, type Claims } from "./lib/jwt";
import { redis } from "./lib/redis";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { meetingRoutes } from "./routes/meetings";
import { joinRoutes } from "./routes/join";
import { controlRoutes } from "./routes/controls";
import { transcriptRoutes } from "./routes/transcript";
import { aiRoutes } from "./routes/ai";
import { chatRoutes } from "./routes/chat";
import { streamRoutes } from "./routes/stream";
import { webhookRoutes } from "./routes/webhooks";
import { assetRoutes } from "./routes/assets";

declare module "fastify" {
  interface FastifyRequest {
    actor: Claims | null;
  }
}

export async function buildApp() {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    genReqId: () => `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    logger: {
      level: config.NODE_ENV === "test" ? "warn" : "info",
      // Tokens, passwords and cookies never reach the log (PRD 11.3, 14).
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "*.password",
          "*.token",
          "*.passcode",
          "*.invitationToken",
        ],
        censor: "[redacted]",
      },
      transport: config.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
    },
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    redis,
    nameSpace: "zuum-rl:",
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429,
      error: {
        code: "RATE_LIMITED",
        message: `Terlalu banyak permintaan. Coba lagi dalam ${Math.ceil(ctx.ttl / 1000)} detik.`,
        requestId: req.id,
      },
    }),
  });

  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) req.actor = await verifyToken(header.slice(7));
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Data yang dikirim belum lengkap atau tidak valid.",
          requestId: req.id,
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, requestId: req.id, details: err.details },
      });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 429) return reply.status(429).send(err);
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return reply.status(status).send({
      error: {
        code: status >= 500 ? "INTERNAL_ERROR" : ((err as FastifyError).code ?? "BAD_REQUEST"),
        message: status >= 500 ? "Terjadi kesalahan di server. Silakan coba lagi." : err.message,
        requestId: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Endpoint tidak ditemukan.", requestId: req.id } }),
  );

  app.get("/healthz", async () => ({ ok: true, version: process.env.APP_VERSION ?? "dev" }));
  app.get("/api/v1/healthz", async () => ({ ok: true, version: process.env.APP_VERSION ?? "dev" }));

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(userRoutes);
      await api.register(meetingRoutes);
      await api.register(joinRoutes);
      await api.register(controlRoutes);
      await api.register(transcriptRoutes);
      await api.register(aiRoutes);
      await api.register(chatRoutes);
      await api.register(streamRoutes);
      await api.register(assetRoutes);
      await api.register(webhookRoutes);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
