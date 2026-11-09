import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Check, Flag, PencilSimple, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import type { PartialSegmentPayload, TranscriptSegmentDTO } from "@zuum/shared";
import { api, ApiError } from "../lib/api";
import { formatTimestamp } from "../lib/format";
import { Avatar, Button, Input, Select, Textarea, cx } from "./ui";

interface Props {
  segments: TranscriptSegmentDTO[];
  partials?: (PartialSegmentPayload & { at: number })[];
  canEdit: boolean;
  meetingId: string;
  tone: "room" | "app";
  onSegmentClick?: (seg: TranscriptSegmentDTO) => void;
  onUpdated?: (seg: TranscriptSegmentDTO) => void;
  highlightIds?: Set<string>;
  live?: boolean;
  participants?: { id: string; displayName: string }[];
}

function SegmentRow({
  seg,
  canEdit,
  meetingId,
  tone,
  onClick,
  onUpdated,
  highlighted,
  participants,
}: {
  seg: TranscriptSegmentDTO;
  canEdit: boolean;
  meetingId: string;
  tone: "room" | "app";
  onClick?: () => void;
  onUpdated?: (s: TranscriptSegmentDTO) => void;
  highlighted?: boolean;
  participants?: { id: string; displayName: string }[];
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(seg.text);
  const [speaker, setSpeaker] = useState(seg.participantId ?? "");
  const [busy, setBusy] = useState(false);
  const muted = tone === "room" ? "text-room-muted" : "text-muted";

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api<{ segment: TranscriptSegmentDTO }>(`/transcript-segments/${seg.id}`, { method: "PATCH", body, guestFor: meetingId });
      onUpdated?.(res.segment);
      setEditing(false);
      toast.success("Transkrip diperbarui. Teks asli tetap tersimpan.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Gagal menyimpan koreksi.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      id={`seg-${seg.id}`}
      className={cx(
        "group enter-line flex gap-3 rounded-[10px] px-2 py-2.5",
        highlighted && (tone === "room" ? "bg-room-3" : "bg-kunyit-soft"),
      )}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 72px" }}
    >
      <Avatar name={seg.speakerName} id={seg.participantId} size={30} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-bold">{seg.speakerName}</span>
          {!seg.speakerVerified && <span className={cx("text-xs", muted)}>pembicara belum terverifikasi</span>}
          {onClick ? (
            <button onClick={onClick} className={cx("tnum text-xs underline-offset-2 hover:underline", muted)} aria-label={`Putar dari ${formatTimestamp(seg.startMs)}`}>
              {formatTimestamp(seg.startMs)}
            </button>
          ) : (
            <span className={cx("tnum text-xs", muted)}>
              {seg.timingEstimated ? "~" : ""}
              {formatTimestamp(seg.startMs)}
            </span>
          )}
          {seg.status === "CORRECTED" && <span className={cx("text-xs italic", muted)} title={`Asli: ${seg.originalText}`}>dikoreksi</span>}
          {seg.status === "NEEDS_REVIEW" && (
            // Turmeric is too light for text on paper; light mode uses a soft fill with ink text instead.
            <span className={cx("rounded px-1.5 text-xs font-semibold", tone === "room" ? "text-kunyit" : "bg-kunyit-soft text-ink")}>perlu ditinjau</span>
          )}
        </div>
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Teks segmen" tone={tone} />
            {participants && participants.length > 0 && (
              <Select aria-label="Pembicara" value={speaker} onChange={(e) => setSpeaker(e.target.value)} tone={tone}>
                <option value="">Pembicara tidak diketahui</option>
                {participants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            )}
            {seg.correctedText && <p className={cx("text-xs", muted)}>Teks asli: {seg.originalText}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                loading={busy}
                icon={<Check size={16} aria-hidden />}
                onClick={() =>
                  save({
                    ...(text.trim() !== seg.text ? { text: text.trim() } : {}),
                    ...(speaker !== (seg.participantId ?? "") ? { participantId: speaker || null } : {}),
                  })
                }
                disabled={!text.trim() || (text.trim() === seg.text && speaker === (seg.participantId ?? ""))}
              >
                Simpan
              </Button>
              <Button size="sm" variant={tone === "room" ? "roomGhost" : "ghost"} icon={<X size={16} aria-hidden />} onClick={() => setEditing(false)}>
                Batal
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 leading-relaxed [overflow-wrap:anywhere]">{seg.text}</p>
        )}
      </div>
      {canEdit && !editing && (
        <div className="flex shrink-0 flex-col gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <button
            onClick={() => {
              setText(seg.text);
              setSpeaker(seg.participantId ?? "");
              setEditing(true);
            }}
            aria-label="Koreksi segmen"
            className={cx("press rounded-lg p-2", tone === "room" ? "text-room-muted hover:bg-room-3 hover:text-room-ink" : "text-muted hover:bg-surface-2 hover:text-ink")}
          >
            <PencilSimple size={16} />
          </button>
          <button
            onClick={() => save({ needsReview: seg.status !== "NEEDS_REVIEW" })}
            aria-label={seg.status === "NEEDS_REVIEW" ? "Hapus tanda tinjau" : "Tandai perlu ditinjau"}
            aria-pressed={seg.status === "NEEDS_REVIEW"}
            className={cx(
              "press rounded-lg p-2",
              seg.status === "NEEDS_REVIEW" ? (tone === "room" ? "text-kunyit" : "bg-kunyit-soft text-ink") : tone === "room" ? "text-room-muted hover:bg-room-3 hover:text-room-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            <Flag size={16} weight={seg.status === "NEEDS_REVIEW" ? "fill" : "regular"} />
          </button>
        </div>
      )}
    </li>
  );
}

/** Transcript list with speaker filter, search, auto-scroll that pauses when the reader scrolls up. */
export function TranscriptView({ segments, partials = [], canEdit, meetingId, tone, onSegmentClick, onUpdated, highlightIds, live, participants }: Props) {
  const [speaker, setSpeaker] = useState("");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const speakers = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of segments) map.set(s.participantId ?? `name:${s.speakerName}`, s.speakerName);
    return [...map.entries()];
  }, [segments]);

  const q = query.trim().toLowerCase();
  const shown = segments.filter(
    (s) => (!speaker || (s.participantId ?? `name:${s.speakerName}`) === speaker) && (!q || s.text.toLowerCase().includes(q) || s.speakerName.toLowerCase().includes(q)),
  );
  const shownPartials = partials.filter((p) => !speaker || p.participantId === speaker);

  useLayoutEffect(() => {
    if (!live || !follow || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown.length, shownPartials.length, follow, live, partials]);

  useEffect(() => {
    const first = highlightIds && [...highlightIds][0];
    if (first) document.getElementById(`seg-${first}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightIds]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !live) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setFollow(atBottom);
  };

  const muted = tone === "room" ? "text-room-muted" : "text-muted";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-2 pb-3">
        <Input aria-label="Cari di transkrip" placeholder="Cari" value={query} onChange={(e) => setQuery(e.target.value)} tone={tone} className="h-10" />
        <Select aria-label="Filter pembicara" value={speaker} onChange={(e) => setSpeaker(e.target.value)} tone={tone} className="h-10 max-w-[46%]">
          <option value="">Semua pembicara</option>
          {speakers.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto scrollbar-thin" aria-live={live ? "polite" : undefined} aria-relevant="additions">
          {shown.length === 0 && shownPartials.length === 0 ? (
            <p className={cx("px-2 py-6 text-sm", muted)}>
              {q || speaker ? "Tidak ada segmen yang cocok." : live ? "Transkrip akan muncul di sini saat peserta mulai berbicara." : "Transkrip kosong."}
            </p>
          ) : (
            <ul className="flex flex-col">
              {shown.map((s) => (
                <SegmentRow
                  key={s.id}
                  seg={s}
                  canEdit={canEdit}
                  meetingId={meetingId}
                  tone={tone}
                  onClick={onSegmentClick ? () => onSegmentClick(s) : undefined}
                  onUpdated={onUpdated}
                  highlighted={highlightIds?.has(s.id)}
                  participants={participants}
                />
              ))}
              {shownPartials.map((p) => (
                <li key={p.utteranceKey} className="flex gap-3 rounded-[10px] px-2 py-2.5">
                  <Avatar name={p.speakerName} id={p.participantId} size={30} speaking className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold">{p.speakerName}</span>
                      <span className={cx("text-xs", muted)}>sedang dikenali</span>
                    </div>
                    <p className={cx("mt-0.5 leading-relaxed", muted)}>{p.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {live && !follow && (
          <button
            onClick={() => {
              setFollow(true);
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
            }}
            className="press enter-pop absolute bottom-3 left-1/2 flex h-10 -translate-x-1/2 items-center gap-1.5 rounded-full bg-kunyit px-4 text-sm font-semibold text-on-kunyit shadow-pop"
          >
            <ArrowDown size={16} aria-hidden /> Ikuti transkrip
          </button>
        )}
      </div>
    </div>
  );
}
