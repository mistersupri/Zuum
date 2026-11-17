// Cloudflare Realtime TURN: short-lived ICE server credentials for browsers.
// Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/
//
// The TURN key (ID + API token) stays on the server. Credentials are generated per
// admitted participant at join time and handed to that browser only, so the key never
// reaches the client. Credentials expire after at most 48 hours (Cloudflare limit).

const API = "https://rtc.live.cloudflare.com/v1/turn";
// Long enough for a long meeting; Cloudflare allows at most 48h per credential.
export const TURN_TTL_SECONDS = 48 * 3600;
// Refresh when less than a third of the TTL remains.
const REFRESH_BEFORE_MS = (TURN_TTL_SECONDS / 3) * 1000;

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface TurnOptions {
  keyId: string;
  apiToken: string;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: { warn(o: object, m: string): void };
}

interface Cached {
  servers: IceServer[];
  expiresAt: number;
}

// Port 53 is blocked by browsers and makes ICE wait for a timeout (Cloudflare FAQ).
const usable = (url: string) => !/:53(\?|$)/.test(url);

/**
 * Returns the ICE servers for one browser, or [] when TURN is not configured or Cloudflare
 * cannot be reached. A failed lookup must never block a meeting: the browser then falls
 * back to LiveKit's own STUN list.
 */
export function createTurnProvider(opts: TurnOptions) {
  const ttl = opts.ttlSeconds ?? TURN_TTL_SECONDS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let cache: Cached | null = null;

  async function generate(): Promise<IceServer[]> {
    const res = await fetchImpl(`${API}/keys/${encodeURIComponent(opts.keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Cloudflare TURN HTTP ${res.status}`);
    const body = (await res.json()) as { iceServers?: { urls: string[]; username?: string; credential?: string }[] };
    return (body.iceServers ?? [])
      .map((s) => ({ ...s, urls: s.urls.filter(usable) }))
      .filter((s) => s.urls.length > 0);
  }

  return {
    get configured() {
      return Boolean(opts.keyId && opts.apiToken);
    },
    async iceServers(): Promise<IceServer[]> {
      if (!this.configured) return [];
      if (cache && cache.expiresAt - now() > REFRESH_BEFORE_MS) return cache.servers;
      try {
        const servers = await generate();
        cache = { servers, expiresAt: now() + ttl * 1000 };
        return servers;
      } catch (err) {
        opts.log?.warn({ err }, "kredensial Cloudflare TURN gagal dibuat; meeting memakai STUN bawaan");
        // Keep serving the previous credentials until they actually expire.
        return cache && cache.expiresAt > now() ? cache.servers : [];
      }
    },
  };
}
