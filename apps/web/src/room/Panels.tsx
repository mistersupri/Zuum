import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParticipants, useIsSpeaking } from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { toast } from "sonner";
import { Check, DotsThreeVertical, LinkSimple, MagnifyingGlass, MicrophoneSlash, PaperPlaneRight, X } from "@phosphor-icons/react";
import { copyInviteLink } from "../lib/invite";
import { ROLE_LABEL } from "@zuum/shared";
import { api, ApiError } from "../lib/api";
import type { ChatMessage, ParticipantRow, Permissions } from "../lib/types";
import { fmtTime } from "../lib/format";
import { Avatar, Button, Dialog, Input, cx } from "../components/ui";


// ---------------- Participants ----------------

function LiveAvatar({ p, name, id }: { p: Participant; name: string; id: string }) {
  const speaking = useIsSpeaking(p);
  return <Avatar name={name} id={id} size={34} speaking={speaking} />;
}

// useIsSpeaking needs a participant; rows still connecting have none yet.
function SpeakingAvatar({ p, name, id }: { p?: Participant; name: string; id: string }) {
  return p ? <LiveAvatar p={p} name={name} id={id} /> : <Avatar name={name} id={id} size={34} />;
}

function ParticipantMenu({
  row,
  meetingId,
  perms,
  myRole,
  onChanged,
}: {
  row: ParticipantRow;
  meetingId: string;
  perms: Permissions;
  myRole: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const act = async (path: string, body?: unknown, ok?: string) => {
    setOpen(false);
    try {
      await api(`/meetings/${meetingId}/participants/${row.id}/${path}`, { body: body ?? {}, guestFor: meetingId });
      if (ok) toast.success(ok);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Tindakan gagal.");
    }
  };

  const canRole = perms.manage && !row.isGuest && row.role !== "OWNER";
  const canRemove = perms.remove && row.role !== "OWNER" && !(row.role === "HOST" && myRole !== "OWNER");
  if (!perms.mute && !canRole && !canRemove) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Tindakan untuk ${row.displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="press rounded-lg p-2.5 text-room-muted hover:bg-room-3 hover:text-room-ink"
      >
        <DotsThreeVertical size={18} weight="bold" />
      </button>
      {open && (
        <div role="menu" className="enter-pop absolute right-0 top-full z-20 mt-1 w-52 origin-top-right rounded-[12px] border border-room-line bg-room-2 p-1 shadow-pop">
          {perms.mute && (
            <button role="menuitem" onClick={() => act("mute", undefined, `${row.displayName} dibisukan.`)} className="flex h-10 w-full items-center rounded-[8px] px-3 text-left text-sm hover:bg-room-3">
              Bisukan mikrofon
            </button>
          )}
          {canRole && (
            <button
              role="menuitem"
              onClick={() => act("role", { role: row.role === "CO_HOST" ? "PARTICIPANT" : "CO_HOST" })}
              className="flex h-10 w-full items-center rounded-[8px] px-3 text-left text-sm hover:bg-room-3"
            >
              {row.role === "CO_HOST" ? "Cabut co-host" : "Jadikan co-host"}
            </button>
          )}
          {canRemove && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setConfirmRemove(true);
              }}
              className="flex h-10 w-full items-center rounded-[8px] px-3 text-left text-sm text-[#ff8f85] hover:bg-room-3"
            >
              Keluarkan dari rapat
            </button>
          )}
        </div>
      )}
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Keluarkan ${row.displayName}?`}
        tone="room"
        footer={
          <>
            <Button variant="roomGhost" onClick={() => setConfirmRemove(false)}>
              Batal
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRemove(false);
                void act("remove", undefined, `${row.displayName} dikeluarkan.`);
              }}
            >
              Keluarkan
            </Button>
          </>
        }
      >
        <p className="text-sm text-room-muted">Peserta ini tidak dapat bergabung kembali ke rapat ini, termasuk dengan tautan yang sama.</p>
      </Dialog>
    </div>
  );
}

export function ParticipantsPanel({
  meetingId,
  rows,
  waiting,
  perms,
  myRole,
  onChanged,
}: {
  meetingId: string;
  rows: ParticipantRow[];
  waiting: ParticipantRow[];
  perms: Permissions;
  myRole: string;
  onChanged: () => void;
}) {
  const lk = useParticipants();
  const [q, setQ] = useState("");
  const byIdentity = useMemo(() => new Map(lk.map((p) => [p.identity, p])), [lk]);
  const present = rows.filter((r) => byIdentity.has(r.identity) || r.status === "JOINED");
  const list = present
    .filter((r) => !q || r.displayName.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.role === "OWNER" ? -1 : b.role === "OWNER" ? 1 : a.displayName.localeCompare(b.displayName)));

  const decide = async (row: ParticipantRow, action: "admit" | "reject") => {
    try {
      await api(`/meetings/${meetingId}/participants/${row.id}/${action}`, { body: {}, guestFor: meetingId });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Tindakan gagal.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {perms.admit && waiting.length > 0 && (
        <section aria-labelledby="lobby-h" className="rounded-[12px] bg-kunyit-soft/20 p-3 ring-1 ring-kunyit/40">
          <div className="mb-2 flex items-center justify-between">
            <h3 id="lobby-h" className="text-sm font-bold text-room-ink">
              Ruang tunggu ({waiting.length})
            </h3>
            {waiting.length > 1 && (
              <button onClick={() => waiting.forEach((w) => void decide(w, "admit"))} className="text-sm font-semibold text-kunyit underline-offset-4 hover:underline">
                Terima semua
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-1">
            {waiting.map((w) => (
              <li key={w.id} className="flex items-center gap-2">
                <Avatar name={w.displayName} id={w.identity} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{w.displayName}</p>
                  <p className="text-xs text-room-muted">{w.isGuest ? "Tamu" : "Akun terdaftar"}</p>
                </div>
                <button onClick={() => decide(w, "reject")} aria-label={`Tolak ${w.displayName}`} className="press rounded-lg p-2.5 text-room-muted hover:bg-room-3 hover:text-room-ink">
                  <X size={16} />
                </button>
                <button onClick={() => decide(w, "admit")} aria-label={`Terima ${w.displayName}`} className="press flex h-10 items-center gap-1 rounded-lg bg-kunyit px-3 text-sm font-semibold text-on-kunyit">
                  <Check size={16} aria-hidden /> Terima
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {perms.manage && (
        <Button variant="room" size="sm" icon={<LinkSimple size={16} aria-hidden />} onClick={() => copyInviteLink(meetingId)}>
          Salin tautan undangan
        </Button>
      )}
      <div className="relative">
        <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-room-muted" aria-hidden />
        <Input aria-label="Cari peserta" placeholder={`Cari di antara ${present.length} peserta`} value={q} onChange={(e) => setQ(e.target.value)} tone="room" className="h-10 pl-9" />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {list.map((r) => {
          const p = byIdentity.get(r.identity);
          const micMuted = p ? !p.getTrackPublication(Track.Source.Microphone) || p.getTrackPublication(Track.Source.Microphone)?.isMuted : true;
          return (
            // content-visibility keeps a 150-person list cheap to render (PRD 12.3).
            <li key={r.id} className="flex items-center gap-3 rounded-[10px] px-1 py-2" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 52px" }}>
              <SpeakingAvatar p={p} name={r.displayName} id={r.identity} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {r.displayName}
                  {p?.isLocal ? " (Anda)" : ""}
                </p>
                <p className="text-xs text-room-muted">
                  {ROLE_LABEL[r.role]}
                  {!p && " · menyambung"}
                </p>
              </div>
              {micMuted && <MicrophoneSlash size={16} className="text-room-muted" aria-label="Mikrofon mati" />}
              {!p?.isLocal && <ParticipantMenu row={r} meetingId={meetingId} perms={perms} myRole={myRole} onChanged={onChanged} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------- Chat ----------------

export function ChatPanel({ meetingId, messages, myParticipantId }: { meetingId: string; messages: ChatMessage[]; myParticipantId: string | null }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView.
    void end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api(`/meetings/${meetingId}/chat`, { body: { body: text }, guestFor: meetingId });
      setBody("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Pesan gagal dikirim.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" aria-live="polite">
        {messages.length === 0 ? (
          <p className="px-1 py-6 text-sm text-room-muted">Belum ada pesan. Pesan terlihat oleh semua peserta dan tersimpan bersama rapat.</p>
        ) : (
          <ul className="flex flex-col gap-3 py-1">
            {messages.map((m) => {
              const mine = m.participantId === myParticipantId;
              return (
                <li key={m.id} className={cx("flex flex-col", mine ? "items-end" : "items-start")}>
                  <span className="mb-1 text-xs text-room-muted">
                    {mine ? "Anda" : m.senderName} · <span className="tnum">{fmtTime(m.createdAt)}</span>
                  </span>
                  {/* Rendered as text, never HTML (XSS guard, PRD 11.4). */}
                  <p className={cx("max-w-[85%] whitespace-pre-wrap rounded-[12px] px-3 py-2 text-sm [overflow-wrap:anywhere]", mine ? "bg-teal text-on-teal" : "bg-room-3 text-room-ink")}>
                    {m.body}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="flex gap-2 pt-3">
        <Input aria-label="Tulis pesan" placeholder="Tulis pesan" value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} tone="room" className="h-11" />
        <Button type="submit" aria-label="Kirim" loading={busy} disabled={!body.trim()} className="w-11 shrink-0 px-0">
          {!busy && <PaperPlaneRight size={18} weight="fill" />}
        </Button>
      </form>
    </div>
  );
}
