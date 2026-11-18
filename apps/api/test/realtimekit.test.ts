import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRealtimeKitClient, createWebhookVerifier, RealtimeKitError } from "../src/lib/realtimekit";

const env = (data: unknown, success = true) => new Response(JSON.stringify({ success, data, message: "" }), { status: success ? 200 : 400, headers: { "content-type": "application/json" } });
const client = (fetchImpl: unknown) => createRealtimeKitClient({ accountId: "ACC", appId: "APP", apiToken: "TOKEN", fetchImpl: fetchImpl as never });

describe("RealtimeKit client (paths and bodies from the Cloudflare OpenAPI spec)", () => {
  it("creates a meeting at /meetings with the bearer token", async () => {
    const f = vi.fn(async () => env({ id: "m1", title: "Rapat" }));
    const m = await client(f).createMeeting({ title: "Rapat", transcribeOnEnd: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/ACC/realtime/kit/APP/meetings");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(init.body as string)).toMatchObject({ title: "Rapat", transcribe_on_end: true, session_keep_alive_time_in_secs: 60 });
    expect(m.id).toBe("m1");
  });

  it("adds a participant with our id as custom_participant_id and returns the token", async () => {
    const f = vi.fn(async () => env({ id: "p1", custom_participant_id: "zuum-part-1", token: "jwt" }));
    const p = await client(f).addParticipant("m1", { customParticipantId: "zuum-part-1", name: "Budi", presetName: "group_call_host" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/meetings\/m1\/participants$/);
    expect(JSON.parse(init.body as string)).toEqual({ custom_participant_id: "zuum-part-1", name: "Budi", preset_name: "group_call_host" });
    expect(p.token).toBe("jwt");
  });

  it("kicks by custom participant id and kick-all sends no body", async () => {
    const f = vi.fn(async () => env({}));
    await client(f).kick("m1", ["zuum-part-1"]);
    await client(f).kickAll("m1");
    const [kickUrl, kickInit] = f.mock.calls[0] as unknown as [string, RequestInit];
    const [allUrl, allInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(kickUrl).toMatch(/active-session\/kick$/);
    expect(JSON.parse(kickInit.body as string)).toEqual({ custom_participant_ids: ["zuum-part-1"] });
    expect(allUrl).toMatch(/active-session\/kick-all$/);
    expect(allInit.body).toBeUndefined();
  });

  it("turns a failed envelope into a RealtimeKitError with Cloudflare's message", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "invalid token" }] }), { status: 401 }));
    await expect(client(f).createMeeting({ title: "x" })).rejects.toBeInstanceOf(RealtimeKitError);
    await expect(client(f).createMeeting({ title: "x" })).rejects.toThrow(/invalid token/);
  });
});

describe("RealtimeKit webhook signatures (RSA-SHA256 over the raw body)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyFetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { publicKey: pem } })));
  const body = JSON.stringify({ event: "meeting.participantJoined", meeting: { id: "m1" }, participant: { customParticipantId: "zuum-part-1" } });
  const signed = sign("RSA-SHA256", Buffer.from(body, "utf8"), privateKey).toString("base64");

  it("accepts a correctly signed body", async () => {
    expect(await createWebhookVerifier({ fetchImpl: keyFetch as never }).verify(body, signed)).toBe(true);
  });

  it("rejects a changed body, a missing header, and a foreign signature", async () => {
    const v = createWebhookVerifier({ fetchImpl: keyFetch as never });
    expect(await v.verify(body.replace("m1", "m2"), signed)).toBe(false);
    expect(await v.verify(body, null)).toBe(false);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = sign("RSA-SHA256", Buffer.from(body, "utf8"), other.privateKey).toString("base64");
    expect(await v.verify(body, forged)).toBe(false);
  });

  it("fetches the public key once and reuses it", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { publicKey: pem } })));
    const v = createWebhookVerifier({ fetchImpl: f as never });
    await v.verify(body, signed);
    await v.verify(body, signed);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
