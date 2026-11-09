import { Link } from "react-router-dom";
import { CaretRight, LockSimple, Users } from "@phosphor-icons/react";
import type { Meeting } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { Badge, type Tone } from "./ui";

const STATUS: Record<Meeting["status"], { label: string; tone: Tone }> = {
  LIVE: { label: "Berlangsung", tone: "rec" },
  SCHEDULED: { label: "Terjadwal", tone: "teal" },
  ENDED: { label: "Selesai", tone: "neutral" },
  CANCELLED: { label: "Dibatalkan", tone: "neutral" },
};

/** Processing state shown on ended meetings, so users know whether minutes are ready. */
export function processingLabel(m: Meeting): { label: string; tone: Tone } | null {
  if (m.status !== "ENDED") return null;
  if (m.aiStatus === "RUNNING" || m.aiStatus === "QUEUED" || m.transcriptStatus === "FINALIZING")
    return { label: "Notulen diproses", tone: "kunyit" };
  if (m.aiStatus === "FAILED") return { label: "Pemrosesan gagal", tone: "rec" };
  if (m.aiStatus === "COMPLETED") return { label: "Notulen siap", tone: "ok" };
  if (!m.transcriptionEnabled) return null;
  return { label: "Menunggu proses", tone: "neutral" };
}

export function MeetingRow({ m }: { m: Meeting }) {
  const status = STATUS[m.status];
  const proc = processingLabel(m);
  const when = m.startedAt ?? m.scheduledAt ?? m.createdAt;
  const href = m.status === "LIVE" || m.status === "SCHEDULED" ? `/m/${m.id}` : `/rapat/${m.id}`;
  return (
    <li>
      <Link to={href} className="press group flex items-center gap-3 rounded-[12px] px-3 py-3.5 hover:bg-surface sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-ink">{m.title}</span>
            {m.hasPasscode && <LockSimple size={14} className="shrink-0 text-muted" aria-label="Dilindungi kode sandi" />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span className="tnum">{fmtDateTime(when, m.timezone)}</span>
            {m.attendeeCount !== undefined && m.attendeeCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <Users size={14} aria-hidden /> <span className="tnum">{m.attendeeCount}</span> hadir
              </span>
            )}
            {!m.isOwner && m.ownerName && <span>oleh {m.ownerName}</span>}
            {m.matchedTranscript && <span className="text-teal">cocok di transkrip</span>}
          </div>
          {/* Status sits under the title so long titles never get squeezed by badges. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={status.tone} dot={m.status === "LIVE"}>
              {status.label}
            </Badge>
            {proc && <Badge tone={proc.tone}>{proc.label}</Badge>}
          </div>
        </div>
        <CaretRight size={16} className="shrink-0 text-muted transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}
