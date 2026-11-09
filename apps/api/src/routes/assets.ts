import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@zuum/db";
import { authorize } from "../lib/access";
import { audit } from "../lib/audit";
import { AppError, Errors } from "../lib/errors";
import { deleteObject, signedDownloadUrl, storageConfigured } from "../lib/storage";
import { toJSON } from "../lib/serialize";

export async function assetRoutes(app: FastifyInstance) {
  app.get("/meetings/:meetingId/assets", async (req) => {
    const { meetingId } = z.object({ meetingId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "results.view");
    const items = await prisma.meetingAsset.findMany({
      where: { meetingId, status: { not: "DELETED" } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        status: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        durationMs: true,
        createdAt: true,
        readyAt: true,
        errorCode: true,
        errorMessage: true,
        metadata: true,
      },
    });
    return { items: toJSON(items), storageConfigured: storageConfigured() };
  });

  /** Authorization check, then a short-lived signed URL. Every access is audited (PRD 4.7, 11.4). */
  app.post("/meetings/:meetingId/assets/:assetId/url", async (req) => {
    const { meetingId, assetId } = z.object({ meetingId: z.string(), assetId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "results.download");
    const asset = await prisma.meetingAsset.findFirst({ where: { id: assetId, meetingId } });
    if (!asset || asset.status === "DELETED") throw Errors.notFound("Rekaman");
    if (asset.status !== "READY" || !asset.storageKey)
      throw new AppError(409, "ASSET_NOT_READY", "Rekaman belum siap diputar.");
    const url = await signedDownloadUrl(asset.storageKey, asset.fileName);
    if (!url) throw new AppError(503, "STORAGE_NOT_CONFIGURED", "Penyimpanan objek belum dikonfigurasi.");
    await audit(req, { action: "recording.access", resource: "asset", resourceId: asset.id, meetingId });
    return { url, expiresInSeconds: 600 };
  });

  app.delete("/meetings/:meetingId/assets/:assetId", async (req) => {
    const { meetingId, assetId } = z.object({ meetingId: z.string(), assetId: z.string() }).parse(req.params);
    await authorize(req, meetingId, "meeting.manage");
    const asset = await prisma.meetingAsset.findFirst({ where: { id: assetId, meetingId } });
    if (!asset) throw Errors.notFound("Rekaman");
    if (asset.storageKey) await deleteObject(asset.storageKey);
    await prisma.meetingAsset.update({ where: { id: asset.id }, data: { status: "DELETED", deletedAt: new Date() } });
    await audit(req, { action: "asset.delete", resource: "asset", resourceId: asset.id, meetingId });
    return { ok: true };
  });
}
