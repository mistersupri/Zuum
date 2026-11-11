import { describe, expect, it, vi } from "vitest";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { ensureBucket } from "../src/lib/bucket";

const log = { info: vi.fn(), warn: vi.fn() };
const s3err = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const noSleep = { sleep: async () => {} };

/** Fake S3 client: answers each command with the next scripted outcome for its type. */
function fake(script: { head: unknown[]; create?: unknown[] }) {
  const calls: string[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    const kind = cmd instanceof HeadBucketCommand ? "head" : cmd instanceof CreateBucketCommand ? "create" : "other";
    calls.push(kind);
    const outcome = (kind === "head" ? script.head : script.create ?? []).shift();
    if (outcome instanceof Error) throw outcome;
    return {};
  });
  return { client: { send } as never, calls };
}

describe("ensureBucket", () => {
  it("does nothing when the bucket already exists", async () => {
    const f = fake({ head: [undefined] });
    expect(await ensureBucket(f.client, "rec", log, noSleep)).toBe("exists");
    expect(f.calls).toEqual(["head"]);
  });

  it("creates the bucket when HEAD returns 404", async () => {
    const f = fake({ head: [s3err("NotFound", 404)], create: [undefined] });
    expect(await ensureBucket(f.client, "rec", log, noSleep)).toBe("created");
    expect(f.calls).toEqual(["head", "create"]);
  });

  it("treats a concurrent create by another API instance as success", async () => {
    const f = fake({ head: [s3err("NotFound", 404)], create: [s3err("BucketAlreadyOwnedByYou", 409)] });
    expect(await ensureBucket(f.client, "rec", log, noSleep)).toBe("exists");
  });

  it("retries while storage is still starting, then succeeds", async () => {
    const down = Object.assign(new Error("connect ECONNREFUSED"), { name: "Error" });
    const f = fake({ head: [down, down, s3err("NotFound", 404)], create: [undefined] });
    expect(await ensureBucket(f.client, "rec", log, noSleep)).toBe("created");
    expect(f.calls).toEqual(["head", "head", "head", "create"]);
  });

  it("stops immediately on wrong credentials instead of retrying", async () => {
    const f = fake({ head: [s3err("Forbidden", 403)] });
    expect(await ensureBucket(f.client, "rec", log, noSleep)).toBe("failed");
    expect(f.calls).toEqual(["head"]);
  });

  it("gives up after the attempt limit without throwing", async () => {
    const down = new Error("ECONNREFUSED");
    const f = fake({ head: [down, down, down] });
    expect(await ensureBucket(f.client, "rec", log, { ...noSleep, attempts: 3 })).toBe("failed");
    expect(f.calls).toHaveLength(3);
  });
});
