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

export const storageConfigured = () => configured;

/** Short-lived download URL. Callers must run the authorization check first (PRD 4.7). */
export async function signedDownloadUrl(key: string, fileName?: string | null) {
  if (!s3) return null;
  return getSignedUrl(
    s3,
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
