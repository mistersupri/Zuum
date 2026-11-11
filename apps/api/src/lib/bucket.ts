import { CreateBucketCommand, HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";

interface Log {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
}

const statusOf = (err: unknown) => (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const nameOf = (err: unknown) => (err as { name?: string })?.name ?? "";

/** A missing bucket answers 404 on HEAD; anything else (network, 5xx, auth) is not "missing". */
const isMissing = (err: unknown) => statusOf(err) === 404 || ["NotFound", "NoSuchBucket"].includes(nameOf(err));
const alreadyThere = (err: unknown) => ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(nameOf(err));
// Wrong credentials or a forbidden bucket will not fix themselves by retrying.
const isFatal = (err: unknown) => statusOf(err) === 401 || statusOf(err) === 403 || ["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied"].includes(nameOf(err));

/**
 * Makes sure the recordings bucket exists, creating it when missing. Works with any
 * S3-compatible storage (RustFS, Cloudflare R2, AWS S3), so deployments need no separate
 * bucket-init container. Storage often starts after the API, so connection errors are
 * retried with backoff; the API keeps serving meanwhile.
 */
export async function ensureBucket(
  client: Pick<S3Client, "send">,
  bucket: string,
  log: Log,
  { attempts = 30, baseDelayMs = 2000, maxDelayMs = 15_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<"exists" | "created" | "failed"> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      log.info({ bucket }, "bucket penyimpanan tersedia");
      return "exists";
    } catch (err) {
      if (isMissing(err)) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
          log.info({ bucket }, "bucket penyimpanan dibuat");
          return "created";
        } catch (createErr) {
          if (alreadyThere(createErr)) return "exists";
          if (isFatal(createErr)) {
            log.warn({ bucket, err: createErr }, "bucket tidak dapat dibuat: periksa S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY");
            return "failed";
          }
          err = createErr;
        }
      } else if (isFatal(err)) {
        log.warn({ bucket, err }, "akses penyimpanan ditolak: periksa S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY");
        return "failed";
      }
      if (attempt === attempts) {
        log.warn({ bucket, err }, "penyimpanan tidak dapat dihubungi; rekaman belum dapat disimpan");
        return "failed";
      }
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  return "failed";
}
