import type { Meeting } from "@zuum/db";

export const fileSlug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "meeting";

export function formatMeetingDate(m: Pick<Meeting, "startedAt" | "endedAt" | "scheduledAt" | "createdAt" | "timezone">) {
  const start = m.startedAt ?? m.scheduledAt ?? m.createdAt;
  const date = new Intl.DateTimeFormat("id-ID", { dateStyle: "full", timeZone: m.timezone }).format(start);
  const time = (d: Date) => new Intl.DateTimeFormat("id-ID", { timeStyle: "short", timeZone: m.timezone }).format(d);
  return m.endedAt ? `${date}, ${time(start)} sampai ${time(m.endedAt)} (${m.timezone})` : `${date}, ${time(start)} (${m.timezone})`;
}
