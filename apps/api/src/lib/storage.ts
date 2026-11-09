import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

const configured = Boolean(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY);

const s3 = configured
  ? new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
    })
  : null;

// Presigning is a local computation, so a client pointed at the public endpoint never has
// to reach it; it only puts the right host into the signed URL.
const signer =
  configured && config.S3_PUBLIC_ENDPOINT
    ? new S3Client({
        region: config.S3_REGION,
        endpoint: config.S3_PUBLIC_ENDPOINT,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
      })
    : s3;

export const storageConfigured = () => configured;

/** Short-lived download URL. Callers must run the authorization check first (PRD 4.7). */
export async function signedDownloadUrl(key: string, fileName?: string | null) {
  if (!signer) return null;
  return getSignedUrl(
    signer,
    new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: fileName ? `attachment; filename="${fileName.replace(/"/g, "")}"` : undefined,
    }),
    { expiresIn: config.SIGNED_URL_TTL_SECONDS },
  );
}

export async function deleteObject(key: string) {
  if (!s3) return;
  await s3.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
}
