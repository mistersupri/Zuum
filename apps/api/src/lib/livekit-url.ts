// The LiveKit URL handed to browsers. Two forms are accepted:
//
//   /livekit                    a path on the app's own origin (recommended): the web
//                               container proxies it to LiveKit, so it inherits the app's
//                               TLS. With PUBLIC_APP_URL=https://x it becomes wss://x/livekit.
//   wss://media.example.com     a separate, already TLS-terminated LiveKit host.

export function browserLivekitUrl(livekitUrl: string, publicAppUrl: string): string {
  if (!livekitUrl.startsWith("/")) return livekitUrl;
  const app = new URL(publicAppUrl);
  const scheme = app.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${app.host}${livekitUrl.replace(/\/+$/, "")}`;
}

/**
 * Settings a browser will refuse, reported at startup instead of surfacing later as a
 * Content-Security-Policy / mixed-content error in the meeting room.
 */
export function livekitUrlProblems(livekitUrl: string, publicAppUrl: string): string[] {
  const problems: string[] = [];
  let app: URL;
  try {
    app = new URL(publicAppUrl);
  } catch {
    return [`PUBLIC_APP_URL "${publicAppUrl}" bukan URL yang valid.`];
  }
  if (livekitUrl.startsWith("/")) return problems;
  let lk: URL;
  try {
    lk = new URL(livekitUrl);
  } catch {
    return [`LIVEKIT_URL "${livekitUrl}" bukan URL yang valid. Pakai /livekit atau wss://host.`];
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(lk.protocol)) {
    problems.push(`LIVEKIT_URL harus diawali ws://, wss://, atau berupa path seperti /livekit.`);
  }
  const insecure = lk.protocol === "ws:" || lk.protocol === "http:";
  if (app.protocol === "https:" && insecure) {
    problems.push(
      `LIVEKIT_URL (${livekitUrl}) tidak terenkripsi sementara aplikasi dibuka lewat https. ` +
        `Browser akan memblokirnya (mixed content / CSP). Pakai LIVEKIT_URL=/livekit, atau wss:// ke host LiveKit yang sudah ber-TLS.`,
    );
  }
  if (app.protocol === "http:" && insecure && lk.host !== app.host) {
    problems.push(
      `LIVEKIT_URL (${livekitUrl}) berbeda host dengan aplikasi; Content-Security-Policy hanya mengizinkan ws:// ke host yang sama. Pakai LIVEKIT_URL=/livekit.`,
    );
  }
  return problems;
}
