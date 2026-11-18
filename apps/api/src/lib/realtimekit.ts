// Cloudflare RealtimeKit REST client and webhook verification.
// Endpoints and schemas follow the Cloudflare OpenAPI spec (cloudflare/api-schemas):
//   base   https://api.cloudflare.com/client/v4/accounts/{account}/realtime/kit/{app}
//   auth   Authorization: Bearer <API token with Realtime permission>
//   envelope { success, data, message }
// Webhooks: signed with RSA-SHA256 over the raw body, header `rtk-signature` (base64),
// public key at https://api.realtime.cloudflare.com/.well-known/webhooks.json.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const RTK_API = "https://api.cloudflare.com/client/v4";
export const RTK_WEBHOOK_KEY_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json";

export interface RtkMeeting {
  id: string;
  title?: string | null;
  status?: string;
  [k: string]: unknown;
}

export interface RtkParticipant {
  id: string;
  custom_participant_id: string;
  name?: string | null;
  token: string;
  expires_on?: string;
  [k: string]: unknown;
}

export class RealtimeKitError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ClientOptions {
  accountId: string;
  appId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

export function createRealtimeKitClient(opts: ClientOptions) {
  const base = `${RTK_API}/accounts/${encodeURIComponent(opts.accountId)}/realtime/kit/${encodeURIComponent(opts.appId)}`;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Bodies are sent only when given; some operations (kick-all) take none.
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T; errors?: { message: string }[] } | null;
    if (!res.ok || !json?.success) {
      const msg = json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new RealtimeKitError(res.status, `RealtimeKit ${method} ${path}: ${msg}`);
    }
    return json.data as T;
  }

  return {
    /** One meeting per Zuum meeting. Transcription runs on RealtimeKit's side; see ai_config. */
    createMeeting(input: { title: string; transcribeOnEnd?: boolean; sessionKeepAliveSeconds?: number }) {
      return call<RtkMeeting>("POST", "/meetings", {
        title: input.title,
        session_keep_alive_time_in_secs: input.sessionKeepAliveSeconds ?? 60,
        ...(input.transcribeOnEnd ? { transcribe_on_end: true } : {}),
      });
    },

    /**
     * Adds a participant and returns their auth token. Call this only after Zuum has admitted
     * the participant (waiting room, passcode, consent), and never from the browser.
     * customParticipantId carries our participant id, so events map back to a Zuum row.
     */
    addParticipant(meetingId: string, input: { customParticipantId: string; name: string; presetName: string; expiresOn?: Date }) {
      return call<RtkParticipant>("POST", `/meetings/${encodeURIComponent(meetingId)}/participants`, {
        custom_participant_id: input.customParticipantId,
        name: input.name,
        preset_name: input.presetName,
        ...(input.expiresOn ? { token: { expires_on: input.expiresOn.toISOString() } } : {}),
      });
    },

    /** Removes everyone from the active session (Zuum ends the meeting for everyone). No body. */
    kickAll(meetingId: string) {
      return call<unknown>("POST", `/meetings/${encodeURIComponent(meetingId)}/active-session/kick-all`);
    },

    /** Removes one participant from the active session, by our customParticipantId. */
    kick(meetingId: string, customParticipantIds: string[]) {
      return call<unknown>("POST", `/meetings/${encodeURIComponent(meetingId)}/active-session/kick`, {
        custom_participant_ids: customParticipantIds,
      });
    },
  };
}

// ---- Webhooks ----

interface KeyCache {
  pem: string;
  fetchedAt: number;
}

export function createWebhookVerifier(opts: { fetchImpl?: typeof fetch; now?: () => number; keyUrl?: string } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const keyUrl = opts.keyUrl ?? RTK_WEBHOOK_KEY_URL;
  let cache: KeyCache | null = null;
  const KEY_TTL_MS = 24 * 3600_000;

  async function publicKeyPem(): Promise<string> {
    if (cache && now() - cache.fetchedAt < KEY_TTL_MS) return cache.pem;
    const res = await fetchImpl(keyUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new RealtimeKitError(res.status, "gagal mengambil kunci publik webhook RealtimeKit");
    const json = (await res.json()) as { data?: { publicKey?: string } };
    const pem = json.data?.publicKey;
    if (!pem) throw new RealtimeKitError(500, "kunci publik webhook tidak ada di respons");
    cache = { pem, fetchedAt: now() };
    return pem;
  }

  return {
    /**
     * Returns true only when the signature matches the raw body. Pass the exact bytes received:
     * re-serializing parsed JSON changes whitespace and key order and breaks the check.
     */
    async verify(rawBody: string, signatureB64: string | null | undefined): Promise<boolean> {
      if (!signatureB64) return false;
      const pem = await publicKeyPem();
      const key = createPublicKey(pem);
      return cryptoVerify("RSA-SHA256", Buffer.from(rawBody, "utf8"), key, Buffer.from(signatureB64, "base64"));
    },
  };
}
