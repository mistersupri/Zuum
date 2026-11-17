import { describe, expect, it, vi } from "vitest";
import { createTurnProvider, TURN_TTL_SECONDS } from "../src/lib/turn";

const ok = (iceServers: unknown) => new Response(JSON.stringify({ iceServers }), { status: 201, headers: { "content-type": "application/json" } });
const sample = [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  {
    urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
    username: "u",
    credential: "c",
  },
];

describe("Cloudflare TURN provider", () => {
  it("calls generate-ice-servers with the key id, bearer token and ttl (as in the docs)", async () => {
    const fetchImpl = vi.fn(async () => ok(sample));
    const t = createTurnProvider({ keyId: "KEY1", apiToken: "TOKEN", fetchImpl: fetchImpl as never });
    await t.iceServers();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/KEY1/credentials/generate-ice-servers");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(init.body as string)).toEqual({ ttl: TURN_TTL_SECONDS });
    expect(TURN_TTL_SECONDS).toBeLessThanOrEqual(48 * 3600);
  });

  it("drops port 53 (blocked by browsers) and keeps the rest", async () => {
    const t = createTurnProvider({ keyId: "K", apiToken: "T", fetchImpl: (async () => ok(sample)) as never });
    const servers = await t.iceServers();
    const turnUrls = servers.flatMap((s) => s.urls);
    expect(turnUrls.some((u) => u.includes(":53"))).toBe(false);
    expect(turnUrls).toContain("turns:turn.cloudflare.com:443?transport=tcp");
  });

  it("caches credentials and refreshes when a third of the TTL remains", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => ok(sample));
    const t = createTurnProvider({ keyId: "K", apiToken: "T", fetchImpl: fetchImpl as never, now: () => clock });
    await t.iceServers();
    await t.iceServers();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += (TURN_TTL_SECONDS * 2 / 3 + 1) * 1000; // less than a third left
    await t.iceServers();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns no servers when not configured, without calling Cloudflare", async () => {
    const fetchImpl = vi.fn(async () => ok(sample));
    expect(await createTurnProvider({ keyId: "", apiToken: "", fetchImpl: fetchImpl as never }).iceServers()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never blocks a meeting: failures return [] and are logged", async () => {
    const log = { warn: vi.fn() };
    const t = createTurnProvider({ keyId: "K", apiToken: "bad", fetchImpl: (async () => new Response("no", { status: 401 })) as never, log });
    expect(await t.iceServers()).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("keeps serving the previous credentials if a refresh fails before they expire", async () => {
    let clock = 0;
    let fail = false;
    const t = createTurnProvider({
      keyId: "K", apiToken: "T", now: () => clock, log: { warn: () => {} },
      fetchImpl: (async () => (fail ? new Response("down", { status: 503 }) : ok(sample))) as never,
    });
    const first = await t.iceServers();
    fail = true;
    clock += (TURN_TTL_SECONDS * 2 / 3 + 1) * 1000;
    expect(await t.iceServers()).toEqual(first);
  });
});
