import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@zuum/db";
import { requireUser } from "../lib/access";
import { Errors } from "../lib/errors";
import { publicUser } from "./auth";

const TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

export async function userRoutes(app: FastifyInstance) {
  app.get("/users/me", async (req) => {
    const user = await prisma.user.findUnique({ where: { id: requireUser(req) } });
    if (!user) throw Errors.unauthorized();
    return { user: publicUser(user) };
  });

  app.patch("/users/me", async (req) => {
    const userId = requireUser(req);
    const body = z
      .object({
        displayName: z.string().trim().min(2).max(80).optional(),
        avatarUrl: z
          .string()
          .url()
          .refine((u) => u.startsWith("https://"), "URL foto harus https.")
          .nullable()
          .optional(),
        locale: z.enum(["id-ID", "en-US"]).optional(),
        timezone: z
          .string()
          .refine((tz) => TIMEZONES.has(tz), "Zona waktu tidak dikenal.")
          .optional(),
      })
      .parse(req.body);
    const user = await prisma.user.update({ where: { id: userId }, data: body });
    return { user: publicUser(user) };
  });
}
