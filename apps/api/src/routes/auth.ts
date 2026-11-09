import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "@zuum/db";
import { config } from "../config";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto";
import { AppError, Errors } from "../lib/errors";
import { signAccessToken } from "../lib/jwt";
import { sendMail } from "../lib/mailer";

const REFRESH_COOKIE = "zuum_rt";
const COOKIE_PATH = "/api/v1/auth";

const email = z.string().trim().toLowerCase().email("Format email tidak valid.").max(254);
const password = z.string().min(10, "Kata sandi minimal 10 karakter.").max(200);

export const publicUser = (u: {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  emailVerifiedAt: Date | null;
}) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  avatarUrl: u.avatarUrl,
  locale: u.locale,
  timezone: u.timezone,
  emailVerified: !!u.emailVerifiedAt,
});

async function issueSession(reply: FastifyReply, req: FastifyRequest, userId: string, familyId?: string) {
  const raw = randomToken();
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  const record = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(raw),
      familyId: familyId ?? randomToken(12),
      expiresAt,
      userAgent: req.headers["user-agent"]?.slice(0, 300),
    },
  });
  reply.setCookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: COOKIE_PATH,
    expires: expiresAt,
  });
  return { accessToken: await signAccessToken(userId), refreshId: record.id };
}

/**
 * Cookie-authenticated endpoints require this header. Browsers cannot send it
 * cross-site without a CORS preflight, which the allowlist rejects (CSRF guard).
 */
function requireCsrfHeader(req: FastifyRequest) {
  if (req.headers["x-zuum-csrf"] !== "1") throw Errors.forbidden("Permintaan ditolak.");
}

const sensitive = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", sensitive, async (req, reply) => {
    const body = z
      .object({ email, password, displayName: z.string().trim().min(2, "Nama minimal 2 karakter.").max(80) })
      .parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw Errors.conflict("EMAIL_TAKEN", "Email ini sudah terdaftar. Silakan masuk.");
    const user = await prisma.user.create({
      data: {
        email: body.email,
        displayName: body.displayName,
        passwordHash: await hashPassword(body.password),
        emailVerifiedAt: config.REQUIRE_EMAIL_VERIFICATION ? null : new Date(),
      },
    });
    if (config.REQUIRE_EMAIL_VERIFICATION) {
      await sendVerification(user.id, user.email, app);
      return reply.status(201).send({ user: publicUser(user), verificationRequired: true });
    }
    const session = await issueSession(reply, req, user.id);
    return reply.status(201).send({ user: publicUser(user), accessToken: session.accessToken });
  });

  app.post("/login", sensitive, async (req, reply) => {
    const body = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    // Same message whether the email exists or not.
    const invalid = new AppError(401, "INVALID_CREDENTIALS", "Email atau kata sandi salah.");
    if (!user?.passwordHash) throw invalid;
    if (!(await verifyPassword(user.passwordHash, body.password))) throw invalid;
    if (user.status === "SUSPENDED" || user.status === "DELETED")
      throw new AppError(403, "ACCOUNT_DISABLED", "Akun ini dinonaktifkan.");
    if (config.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt)
      throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verifikasi email Anda terlebih dahulu.");
    const session = await issueSession(reply, req, user.id);
    return { user: publicUser(user), accessToken: session.accessToken };
  });

  /** Rotating refresh: each token is single-use; reuse of a rotated token revokes the whole family. */
  app.post("/refresh", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    requireCsrfHeader(req);
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) throw Errors.unauthorized("Sesi berakhir. Silakan masuk kembali.");
    const token = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
    if (!token) throw Errors.unauthorized("Sesi berakhir. Silakan masuk kembali.");
    if (token.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { familyId: token.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw Errors.unauthorized("Sesi tidak valid. Silakan masuk kembali.");
    }
    if (token.expiresAt < new Date() || token.user.status !== "ACTIVE") {
      throw Errors.unauthorized("Sesi berakhir. Silakan masuk kembali.");
    }
    const session = await issueSession(reply, req, token.userId, token.familyId);
    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date(), replacedBy: session.refreshId },
    });
    return { user: publicUser(token.user), accessToken: session.accessToken };
  });

  app.post("/logout", async (req, reply) => {
    requireCsrfHeader(req);
    const raw = req.cookies[REFRESH_COOKIE];
    if (raw) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: sha256(raw), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.status(204).send();
  });

  app.post("/forgot-password", sensitive, async (req, reply) => {
    const body = z.object({ email }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user && user.status === "ACTIVE") {
      const raw = randomToken();
      await prisma.userAuthToken.create({
        data: {
          userId: user.id,
          purpose: "password_reset",
          tokenHash: sha256(raw),
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
      await sendMail(
        {
          to: user.email,
          subject: "Atur ulang kata sandi Zuum",
          text: `Halo ${user.displayName},\n\nBuka tautan berikut untuk mengatur ulang kata sandi (berlaku 30 menit):\n${config.PUBLIC_APP_URL}/reset-password?token=${raw}\n\nAbaikan email ini jika Anda tidak memintanya.`,
        },
        app.log,
      );
    }
    // Identical response either way, so the endpoint does not reveal registered emails.
    return reply.status(202).send({ ok: true });
  });

  app.post("/reset-password", sensitive, async (req) => {
    const body = z.object({ token: z.string().min(20), password }).parse(req.body);
    const record = await prisma.userAuthToken.findUnique({ where: { tokenHash: sha256(body.token) } });
    if (!record || record.purpose !== "password_reset" || record.consumedAt || record.expiresAt < new Date()) {
      throw new AppError(400, "RESET_TOKEN_INVALID", "Tautan atur ulang tidak valid atau sudah kedaluwarsa.");
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(body.password) } }),
      prisma.userAuthToken.update({ where: { id: record.id }, data: { consumedAt: new Date() } }),
      // A password reset signs out every existing session.
      prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { ok: true };
  });

  app.post("/verify-email", sensitive, async (req) => {
    const body = z.object({ token: z.string().min(20) }).parse(req.body);
    const record = await prisma.userAuthToken.findUnique({ where: { tokenHash: sha256(body.token) } });
    if (!record || record.purpose !== "email_verify" || record.consumedAt || record.expiresAt < new Date()) {
      throw new AppError(400, "VERIFY_TOKEN_INVALID", "Tautan verifikasi tidak valid atau sudah kedaluwarsa.");
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
      prisma.userAuthToken.update({ where: { id: record.id }, data: { consumedAt: new Date() } }),
    ]);
    return { ok: true };
  });
}

async function sendVerification(userId: string, to: string, app: FastifyInstance) {
  const raw = randomToken();
  await prisma.userAuthToken.create({
    data: { userId, purpose: "email_verify", tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 24 * 3600_000) },
  });
  await sendMail(
    {
      to,
      subject: "Verifikasi email Zuum",
      text: `Buka tautan berikut untuk memverifikasi email Anda:\n${config.PUBLIC_APP_URL}/verify-email?token=${raw}`,
    },
    app.log,
  );
}
