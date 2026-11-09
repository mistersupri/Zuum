export { formatTimestamp } from "@zuum/shared";

export const fmtDateTime = (iso: string | null | undefined, tz?: string) =>
  iso
    ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso))
    : "";

export const fmtDate = (iso: string | null | undefined, tz?: string) =>
  iso ? new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: tz }).format(new Date(iso)) : "";

export const fmtTime = (iso: string | null | undefined, tz?: string) =>
  iso ? new Intl.DateTimeFormat("id-ID", { timeStyle: "short", timeZone: tz }).format(new Date(iso)) : "";

export function fmtRelative(iso: string) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("id-ID", { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function fmtBytes(n: number | null) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0).replace(".", ",")} ${units[i]}`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

// Speaker hues: muted, distinguishable, stable per participant id. Data encoding, not palette.
const SPEAKER_HUES = [168, 32, 205, 340, 95, 265];
export function speakerHue(key: string | null) {
  if (!key) return 0;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return SPEAKER_HUES[h % SPEAKER_HUES.length]!;
}
