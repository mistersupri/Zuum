// Thin fetch client. Access token lives in memory only; the refresh token is an
// httpOnly cookie the browser sends to /api/v1/auth/* (never readable by JS).

const BASE = (import.meta.env.VITE_API_URL ?? "") + "/api/v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onSessionLost: (() => void) | null = null;

export const session = {
  set(token: string | null) {
    accessToken = token;
  },
  get: () => accessToken,
  onLost(fn: () => void) {
    onSessionLost = fn;
  },
};

// Guest sessions are per meeting and per tab.
const guestKey = (meetingId: string) => `zuum-guest:${meetingId}`;
export const guestSession = {
  get(meetingId: string) {
    try {
      return sessionStorage.getItem(guestKey(meetingId));
    } catch {
      return null;
    }
  },
  set(meetingId: string, token: string) {
    try {
      sessionStorage.setItem(guestKey(meetingId), token);
    } catch {
      /* private mode: guest re-joins with the link */
    }
  },
  clear(meetingId: string) {
    try {
      sessionStorage.removeItem(guestKey(meetingId));
    } catch {
      /* ignore */
    }
  },
};

export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "x-zuum-csrf": "1" },
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const body = (await r.json()) as { accessToken: string };
        accessToken = body.accessToken;
        return accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** Use a meeting-scoped guest token instead of the user session. */
  guestFor?: string;
  signal?: AbortSignal;
  raw?: boolean;
}

function authHeader(opts: RequestOptions): string | null {
  if (opts.guestFor && !accessToken) {
    const g = guestSession.get(opts.guestFor);
    if (g) return `Bearer ${g}`;
  }
  return accessToken ? `Bearer ${accessToken}` : null;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const qs = opts.query
    ? "?" +
      new URLSearchParams(
        Object.entries(opts.query)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : "";
  const doFetch = () => {
    const headers: Record<string, string> = {};
    const auth = authHeader(opts);
    if (auth) headers.authorization = auth;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${BASE}${path}${qs}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      credentials: "include",
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  };

  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "Tidak dapat terhubung ke server. Periksa koneksi internet Anda.");
  }
  if (res.status === 401 && accessToken) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await doFetch();
    else onSessionLost?.();
  }
  if (opts.raw) {
    if (!res.ok) throw await toError(res);
    return res as unknown as T;
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

async function toError(res: Response) {
  try {
    const body = (await res.json()) as { error?: { code: string; message: string; details?: unknown; requestId?: string } };
    if (body.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.details, body.error.requestId);
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, "HTTP_" + res.status, "Terjadi kesalahan. Silakan coba lagi.");
}

/** Downloads a file from an authenticated endpoint (exports need the bearer header). */
export async function download(path: string, query: Record<string, string>) {
  const res = await api<Response>(path, { query, raw: true });
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "unduhan";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const apiBase = BASE;
