import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConnectionState, DisconnectReason, RoomEvent, VideoPresets, type RoomOptions } from "livekit-client";
import { LiveKitRoom, RoomAudioRenderer, useConnectionState, useLocalParticipant, useRoomContext, StartAudio } from "@livekit/components-react";
import {
  ChatCircleText,
  ClosedCaptioning,
  GridFour,
  LockSimple,
  LockSimpleOpen,
  Microphone,
  MicrophoneSlash,
  MonitorArrowUp,
  PhoneDisconnect,
  Record,
  ShieldCheck,
  SpeakerHigh,
  SquaresFour,
  Users,
  VideoCamera,
  VideoCameraSlash,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import type { RealtimeEvent } from "@zuum/shared";
import { api, ApiError, guestSession } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMeetingEvents } from "../lib/events";
import type { DevicePrefs } from "../lib/devices";
import type { ChatMessage, JoinResponse, MeetingDetail, ParticipantRow } from "../lib/types";
import { fmtDuration } from "../lib/format";
import { Button, Dialog, LoadingBlock, Tabs, cx } from "../components/ui";
import { TranscriptView } from "../components/TranscriptView";
import { joinStorageKey } from "../pages/Join";
import { Stage, type Layout } from "./Stage";
import { ChatPanel, ParticipantsPanel } from "./Panels";
import { useLiveTranscript } from "./useLiveTranscript";

type PanelId = "participants" | "chat" | "transcript";
type EndState = null | { kind: "left" | "ended" | "removed" | "error"; message?: string };

interface Stored {
  join: JoinResponse;
  prefs: DevicePrefs;
}

const roomOptions = (prefs: DevicePrefs): RoomOptions => ({
  // Simulcast + adaptive stream + dynacast keep bandwidth bounded in large rooms (PRD 5.4).
  adaptiveStream: true,
  dynacast: true,
  publishDefaults: { simulcast: true, videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360], red: true, dtx: true },
  videoCaptureDefaults: { resolution: VideoPresets.h720.resolution, deviceId: prefs.videoInput },
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: prefs.audioInput },
  audioOutput: prefs.audioOutput ? { deviceId: prefs.audioOutput } : undefined,
  disconnectOnPageLeave: true,
});

export function MeetingRoomPage() {
  const { meetingId } = useParams();
  const nav = useNavigate();
  const [stored, setStored] = useState<Stored | null>(() => {
    try {
      const raw = meetingId && sessionStorage.getItem(joinStorageKey(meetingId));
      return raw ? (JSON.parse(raw) as Stored) : null;
    } catch {
      return null;
    }
  });
  const [end, setEnd] = useState<EndState>(null);

  // Page reload: the LiveKit token in sessionStorage may be stale; re-join silently.
  useEffect(() => {
    if (!meetingId || stored) return;
    api<JoinResponse>(`/meetings/${meetingId}/join`, { body: {}, guestFor: meetingId })
      .then((res) => {
        if (res.status !== "JOINED") return nav(`/m/${meetingId}`, { replace: true });
        const next = { join: res, prefs: { micOn: false, camOn: false } };
        sessionStorage.setItem(joinStorageKey(meetingId), JSON.stringify(next));
        setStored(next);
      })
      .catch(() => nav(`/m/${meetingId}`, { replace: true }));
  }, [meetingId, stored, nav]);

  if (end) return <EndScreen state={end} meetingId={meetingId!} />;
  if (!stored?.join.livekit || !meetingId) {
    return (
      <div className="room flex min-h-dvh items-center justify-center bg-room text-room-ink">
        <LoadingBlock label="Menyiapkan ruang rapat..." />
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={stored.join.livekit.url}
      token={stored.join.livekit.token}
      connect
      audio={stored.prefs.micOn}
      video={stored.prefs.camOn}
      options={roomOptions(stored.prefs)}
      onDisconnected={(reason) => {
        sessionStorage.removeItem(joinStorageKey(meetingId));
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) setEnd({ kind: "removed" });
        else if (reason === DisconnectReason.ROOM_DELETED) setEnd({ kind: "ended" });
        else if (reason === DisconnectReason.CLIENT_INITIATED) setEnd((e) => e ?? { kind: "left" });
        else setEnd((e) => e ?? { kind: "error", message: "Koneksi ke ruang rapat terputus." });
      }}
      onError={(err) => toast.error(`Media: ${err.message}`)}
      className="room flex h-dvh flex-col bg-room text-room-ink"
    >
      <RoomUI meetingId={meetingId} join={stored.join} onEnd={setEnd} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function useElapsed(startedAt: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return startedAt ? fmtDuration(now - new Date(startedAt).getTime()) : "00:00";
}

function ConnectionBadge() {
  const state = useConnectionState();
  if (state === ConnectionState.Connected)
    return (
      <span className="hidden items-center gap-1 text-xs text-room-muted sm:inline-flex">
        <WifiHigh size={16} aria-hidden /> Terhubung
      </span>
    );
  return (
    <span role="status" className="inline-flex items-center gap-1 text-xs font-semibold text-kunyit">
      <WifiSlash size={16} aria-hidden /> {state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting ? "Menyambung ulang..." : "Menghubungkan..."}
    </span>
  );
}

function RoomUI({ meetingId, join, onEnd }: { meetingId: string; join: JoinResponse; onEnd: (s: EndState) => void }) {
  const qc = useQueryClient();
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const [panel, setPanel] = useState<PanelId | null>(null);
  const panelInit = useRef(false);
  const [layout, setLayout] = useState<Layout>("grid");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [hostMenu, setHostMenu] = useState(false);
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);
  const [noticeVersion, setNoticeVersion] = useState("2026-11-v1");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);

  const detail = useQuery({
    queryKey: ["meeting", meetingId, "room"],
    queryFn: () => api<MeetingDetail>(`/meetings/${meetingId}`, { guestFor: meetingId }),
    refetchInterval: 30_000,
  });
  const perms = detail.data?.me.permissions;
  const permsRef = useRef(perms);
  permsRef.current = perms;
  const meeting = detail.data?.meeting;
  const canSeeTranscript = !!join.permissions?.canViewTranscript && !!meeting?.transcriptionEnabled;

  const waiting = useQuery({
    queryKey: ["meeting", meetingId, "waiting"],
    enabled: !!perms?.admit,
    queryFn: () => api<{ items: ParticipantRow[] }>(`/meetings/${meetingId}/waiting`, { guestFor: meetingId }),
    refetchInterval: 15_000,
  });

  const transcript = useLiveTranscript(meetingId, canSeeTranscript);

  // Desktop opens the transcript (or participants, for people who may not see it) once details load.
  useEffect(() => {
    if (panelInit.current || !detail.data) return;
    panelInit.current = true;
    if (matchMedia("(min-width: 1024px)").matches) setPanel(canSeeTranscript ? "transcript" : "participants");
  }, [detail.data, canSeeTranscript]);

  useEffect(() => {
    api<{ items: ChatMessage[] }>(`/meetings/${meetingId}/chat`, { guestFor: meetingId })
      .then((r) => setChat(r.items))
      .catch(() => undefined);
  }, [meetingId]);

  useEffect(() => {
    if (meeting?.recordingActive && !perms?.record) setRecordingNotice((n) => n ?? "Rapat ini sedang direkam.");
    // Show once per mount when entering an already-recording meeting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting?.id]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
  }, [qc, meetingId]);

  const onEvent = useCallback(
    (ev: RealtimeEvent<any>) => {
      if (ev.type.startsWith("transcript.")) return transcript.apply(ev);
      switch (ev.type) {
        case "meeting.chat.message": {
          const m = ev.payload as ChatMessage;
          setChat((c) => (c.some((x) => x.id === m.id) ? c : [...c, m]));
          if (m.participantId !== join.participantId) {
            setUnreadChat((n) => n + 1);
          }
          break;
        }
        case "meeting.participant.waiting":
          toast(`${(ev.payload as ParticipantRow).displayName} menunggu di ruang tunggu`, {
            action: { label: "Lihat", onClick: () => setPanel("participants") },
          });
          refresh();
          break;
        case "meeting.recording.started":
          setNoticeVersion((ev.payload as { noticeVersion?: string }).noticeVersion ?? "2026-11-v1");
          // People who control recording started it themselves; everyone else gets the notice.
          if (!permsRef.current?.record) setRecordingNotice("Host mulai merekam rapat ini.");
          refresh();
          break;
        case "meeting.recording.stopped":
          setRecordingNotice(null);
          toast((ev.payload as { reason: string }).reason === "failed" ? "Perekaman gagal dimulai." : "Perekaman dihentikan.");
          refresh();
          break;
        case "meeting.locked":
        case "meeting.unlocked":
          toast(ev.type === "meeting.locked" ? "Rapat dikunci. Peserta baru tidak dapat masuk." : "Rapat dibuka kembali.");
          refresh();
          break;
        case "meeting.participant.removed":
          if ((ev.payload as ParticipantRow).id === join.participantId) {
            onEnd({ kind: "removed" });
            void room.disconnect();
          } else refresh();
          break;
        case "meeting.ended":
          onEnd({ kind: "ended" });
          void room.disconnect();
          break;
        default:
          if (ev.type.startsWith("meeting.participant.")) refresh();
      }
    },
    [transcript, join.participantId, refresh, onEnd, room],
  );
  useMeetingEvents(meetingId, onEvent);

  useEffect(() => {
    if (panel === "chat") setUnreadChat(0);
  }, [panel, chat.length]);

  useEffect(() => {
    const onKick = (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) onEnd({ kind: "removed" });
    };
    room.on(RoomEvent.Disconnected, onKick);
    return () => {
      room.off(RoomEvent.Disconnected, onKick);
    };
  }, [room, onEnd]);

  const elapsed = useElapsed(meeting?.startedAt);

  const toggle = async (kind: "mic" | "cam" | "screen") => {
    try {
      if (kind === "mic") await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
      if (kind === "cam") await localParticipant.setCameraEnabled(!isCameraEnabled);
      if (kind === "screen") await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true });
    } catch (err) {
      const e = err as DOMException;
      if (e.name === "NotAllowedError") toast.error(kind === "screen" ? "Berbagi layar dibatalkan atau ditolak browser." : "Browser menolak akses perangkat.");
      else toast.error("Perangkat tidak dapat digunakan.");
    }
  };

  const hostAction = async (path: string, ok?: string) => {
    setHostMenu(false);
    // Starting egress can take seconds; show progress so the click visibly did something.
    const pending = path === "recording/start" ? toast.loading("Menyiapkan perekaman...") : undefined;
    try {
      await api(`/meetings/${meetingId}/${path}`, { body: {}, guestFor: meetingId });
      if (ok) toast.success(ok, { id: pending });
      else if (pending) toast.dismiss(pending);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Tindakan gagal.", { id: pending });
    }
  };

  const leave = async (endForAll: boolean) => {
    setConfirmLeave(false);
    try {
      if (endForAll) await api(`/meetings/${meetingId}/end`, { body: {} });
      else await api(`/meetings/${meetingId}/leave`, { body: {}, guestFor: meetingId });
    } catch {
      /* leaving should never be blocked by the API */
    }
    onEnd({ kind: endForAll ? "ended" : "left" });
    await room.disconnect();
  };

  const acknowledgeRecording = async (granted: boolean) => {
    setRecordingNotice(null);
    await api(`/meetings/${meetingId}/consent`, {
      body: { type: "RECORDING", granted, noticeVersion },
      guestFor: meetingId,
    }).catch(() => undefined);
    if (!granted) void leave(false);
  };

  const waitingRows = waiting.data?.items ?? [];
  const tabs = useMemo(
    () =>
      [
        { id: "participants" as const, label: "Peserta", count: perms?.admit ? waitingRows.length : 0 },
        { id: "chat" as const, label: "Chat", count: panel === "chat" ? 0 : unreadChat },
        ...(canSeeTranscript ? [{ id: "transcript" as const, label: "Transkrip" }] : []),
      ],
    [perms?.admit, waitingRows.length, unreadChat, panel, canSeeTranscript],
  );

  return (
    <>
      {/* Header: title, duration, connection, and always-visible recording/transcription indicators (PRD 11.2, 12.3). */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-room-line px-3 sm:h-16 sm:px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-bold sm:text-base">{meeting?.title ?? "Rapat"}</h1>
          <p className="tnum text-xs text-room-muted">{elapsed}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {meeting?.recordingActive && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[#b42f25] px-2.5 text-xs font-bold text-white" role="status">
              <span className="rec-dot size-2 rounded-full bg-white" aria-hidden /> REC
            </span>
          )}
          {meeting?.transcriptionEnabled && (
            <span className="inline-flex h-7 items-center gap-1 rounded-full bg-room-3 px-2.5 text-xs font-semibold text-room-ink" role="status">
              <ClosedCaptioning size={14} weight="fill" aria-hidden />
              <span className="hidden sm:inline">Transkripsi aktif</span>
              <span className="sm:hidden">CC</span>
            </span>
          )}
          {meeting?.locked && (
            <span className="inline-flex h-7 items-center gap-1 rounded-full bg-room-3 px-2.5 text-xs font-semibold" role="status">
              <LockSimple size={14} weight="fill" aria-hidden /> <span className="hidden sm:inline">Terkunci</span>
            </span>
          )}
          <ConnectionBadge />
          <button
            onClick={() => setLayout((l) => (l === "grid" ? "speaker" : "grid"))}
            aria-label={layout === "grid" ? "Tampilan pembicara" : "Tampilan grid"}
            className="press hidden size-10 items-center justify-center rounded-[10px] text-room-muted hover:bg-room-3 hover:text-room-ink sm:flex"
          >
            {layout === "grid" ? <SquaresFour size={20} /> : <GridFour size={20} />}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 p-2 sm:p-4" aria-label="Video peserta">
          <Stage layout={layout} />
          <StartAudio label="Klik untuk mengaktifkan suara" className="fixed left-1/2 top-20 z-40 -translate-x-1/2 rounded-full bg-kunyit px-4 py-2 text-sm font-semibold text-on-kunyit" />
        </main>

        {panel && (
          <aside
            aria-label="Panel samping"
            className="enter-pop fixed inset-x-0 bottom-0 z-30 flex h-[72dvh] flex-col rounded-t-[16px] border-t border-room-line bg-room-2 p-3 lg:static lg:z-auto lg:h-auto lg:w-[380px] lg:rounded-none lg:border-l lg:border-t-0 lg:p-4"
          >
            <div className="mb-3 flex items-center gap-2">
              <Tabs tone="room" label="Panel rapat" tabs={tabs} value={panel} onChange={setPanel} className="flex-1" />
              <button onClick={() => setPanel(null)} aria-label="Tutup panel" className="press rounded-lg p-2.5 text-room-muted hover:bg-room-3 hover:text-room-ink">
                <X size={18} />
              </button>
            </div>
            <div role="tabpanel" id={`panel-${panel}`} aria-labelledby={`tab-${panel}`} className="min-h-0 flex-1">
              {panel === "participants" && perms && (
                <ParticipantsPanel
                  meetingId={meetingId}
                  rows={detail.data?.participants ?? []}
                  waiting={waitingRows}
                  perms={perms}
                  myRole={detail.data?.me.role ?? "PARTICIPANT"}
                  onChanged={refresh}
                />
              )}
              {panel === "chat" && <ChatPanel meetingId={meetingId} messages={chat} myParticipantId={join.participantId} />}
              {panel === "transcript" && canSeeTranscript &&
                (transcript.loading ? (
                  <LoadingBlock label="Memuat transkrip..." />
                ) : transcript.error ? (
                  <p className="text-sm text-room-muted">Transkrip tidak dapat dimuat. {transcript.error instanceof Error ? transcript.error.message : ""}</p>
                ) : (
                  <TranscriptView
                    live
                    tone="room"
                    meetingId={meetingId}
                    segments={transcript.segments}
                    partials={Object.values(transcript.partials)}
                    canEdit={!!perms?.editTranscript}
                    onUpdated={(s) => transcript.apply({ type: "transcript.segment.corrected", payload: s, eventId: `local-${s.id}-${Date.now()}`, version: Date.now(), meetingId, occurredAt: "", audience: "transcript" })}
                    participants={(detail.data?.participants ?? []).map((p) => ({ id: p.id, displayName: p.displayName }))}
                  />
                ))}
            </div>
          </aside>
        )}
      </div>

      {/* Toolbar */}
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-room-line px-2 py-2 sm:px-5 sm:py-3" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        <div className="hidden w-48 lg:block">
          {meeting && (
            <p className="tnum truncate text-xs text-room-muted" title="Kode rapat">
              Kode {meeting.code}
            </p>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2">
          <ToolButton active={isMicrophoneEnabled} danger={!isMicrophoneEnabled} onClick={() => toggle("mic")} label={isMicrophoneEnabled ? "Matikan mikrofon" : "Nyalakan mikrofon"}>
            {isMicrophoneEnabled ? <Microphone size={22} weight="fill" /> : <MicrophoneSlash size={22} weight="fill" />}
          </ToolButton>
          <ToolButton active={isCameraEnabled} danger={!isCameraEnabled} onClick={() => toggle("cam")} label={isCameraEnabled ? "Matikan kamera" : "Nyalakan kamera"}>
            {isCameraEnabled ? <VideoCamera size={22} weight="fill" /> : <VideoCameraSlash size={22} weight="fill" />}
          </ToolButton>
          {"getDisplayMedia" in (navigator.mediaDevices ?? {}) && (
            <ToolButton active={isScreenShareEnabled} highlight={isScreenShareEnabled} onClick={() => toggle("screen")} label={isScreenShareEnabled ? "Hentikan berbagi layar" : "Bagikan layar"} className="hidden sm:flex">
              <MonitorArrowUp size={22} weight={isScreenShareEnabled ? "fill" : "regular"} />
            </ToolButton>
          )}
          <span className="mx-1 hidden h-8 w-px bg-room-line sm:block" aria-hidden />
          {canSeeTranscript && (
            <ToolButton active={panel === "transcript"} highlight={panel === "transcript"} onClick={() => setPanel((p) => (p === "transcript" ? null : "transcript"))} label="Transkrip">
              <ClosedCaptioning size={22} weight={panel === "transcript" ? "fill" : "regular"} />
            </ToolButton>
          )}
          <ToolButton active={panel === "chat"} highlight={panel === "chat"} onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))} label="Chat" badge={panel === "chat" ? 0 : unreadChat}>
            <ChatCircleText size={22} weight={panel === "chat" ? "fill" : "regular"} />
          </ToolButton>
          <ToolButton
            active={panel === "participants"}
            highlight={panel === "participants"}
            onClick={() => setPanel((p) => (p === "participants" ? null : "participants"))}
            label="Peserta"
            badge={perms?.admit ? waitingRows.length : 0}
          >
            <Users size={22} weight={panel === "participants" ? "fill" : "regular"} />
          </ToolButton>
          {(perms?.lock || perms?.record || perms?.mute) && (
            <div className="relative">
              <ToolButton active={hostMenu} onClick={() => setHostMenu((o) => !o)} label="Kontrol host" expanded={hostMenu}>
                <ShieldCheck size={22} weight={hostMenu ? "fill" : "regular"} />
              </ToolButton>
              {hostMenu && (
                <HostMenu
                  onClose={() => setHostMenu(false)}
                  locked={!!meeting?.locked}
                  recording={!!meeting?.recordingActive}
                  recordingEnabled={!!meeting?.recordingEnabled}
                  perms={perms}
                  onAction={hostAction}
                />
              )}
            </div>
          )}
        </div>
        <div className="flex w-auto justify-end lg:w-48">
          <Button variant="danger" onClick={() => setConfirmLeave(true)} icon={<PhoneDisconnect size={20} weight="fill" aria-hidden />} className="h-12 px-3 sm:px-4">
            <span className="hidden sm:inline">Keluar</span>
          </Button>
        </div>
      </footer>

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={perms?.end ? "Keluar atau akhiri rapat?" : "Keluar dari rapat?"}
        tone="room"
        footer={
          <>
            <Button variant="roomGhost" onClick={() => setConfirmLeave(false)}>
              Batal
            </Button>
            <Button variant="room" onClick={() => leave(false)}>
              Keluar saja
            </Button>
            {perms?.end && (
              <Button variant="danger" onClick={() => leave(true)}>
                Akhiri untuk semua
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm text-room-muted">
          {perms?.end
            ? "Mengakhiri rapat memutus semua peserta, menghentikan rekaman, lalu menyusun transkrip final dan notulen."
            : "Anda dapat bergabung kembali selama rapat masih berlangsung."}
        </p>
      </Dialog>

      <Dialog open={!!recordingNotice} onClose={() => acknowledgeRecording(true)} title="Rapat sedang direkam" tone="room">
        <div className="flex gap-3">
          <Record size={28} weight="fill" className="shrink-0 text-[#ff6b5e]" aria-hidden />
          <p className="text-sm text-room-muted">
            {recordingNotice} Audio dan video Anda masuk ke rekaman. Indikator REC tetap tampil di atas selama perekaman berjalan.
          </p>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="roomGhost" onClick={() => acknowledgeRecording(false)}>
            Keluar dari rapat
          </Button>
          <Button onClick={() => acknowledgeRecording(true)}>Saya mengerti</Button>
        </div>
      </Dialog>
    </>
  );
}

function ToolButton({
  children,
  label,
  onClick,
  active,
  danger,
  highlight,
  badge,
  expanded,
  className,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  highlight?: boolean;
  badge?: number;
  expanded?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-expanded={expanded}
      className={cx(
        "press relative flex size-11 items-center justify-center rounded-[12px] sm:size-12",
        danger ? "bg-[#4a1f1b] text-[#ff8f85] hover:bg-[#5a2621]" : highlight ? "bg-kunyit text-on-kunyit" : "bg-room-3 text-room-ink hover:bg-room-line",
        className,
      )}
    >
      {children}
      {!!badge && badge > 0 && (
        <span className="tnum absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-kunyit px-1 text-[11px] font-bold text-on-kunyit ring-2 ring-room">
          {badge}
        </span>
      )}
    </button>
  );
}

function HostMenu({
  onClose,
  locked,
  recording,
  recordingEnabled,
  perms,
  onAction,
}: {
  onClose: () => void;
  locked: boolean;
  recording: boolean;
  recordingEnabled: boolean;
  perms: MeetingDetail["me"]["permissions"] | undefined;
  onAction: (path: string, ok?: string) => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const item = "flex h-11 w-full items-center gap-3 rounded-[10px] px-3 text-left text-sm font-medium hover:bg-room-3";
  return (
    <div role="menu" aria-label="Kontrol host" className="enter-pop absolute bottom-full left-1/2 z-30 mb-2 w-64 origin-bottom -translate-x-1/2 rounded-[14px] border border-room-line bg-room-2 p-1.5 shadow-pop">
      {perms?.mute && (
        <button role="menuitem" className={item} onClick={() => onAction("mute-all", "Semua peserta dibisukan.")}>
          <SpeakerHigh size={18} aria-hidden /> Bisukan semua peserta
        </button>
      )}
      {perms?.lock && (
        <button role="menuitem" className={item} onClick={() => onAction(locked ? "unlock" : "lock")}>
          {locked ? <LockSimpleOpen size={18} aria-hidden /> : <LockSimple size={18} aria-hidden />}
          {locked ? "Buka kunci rapat" : "Kunci rapat"}
        </button>
      )}
      {perms?.record && (
        <button
          role="menuitem"
          className={cx(item, !recordingEnabled && "cursor-not-allowed opacity-50")}
          disabled={!recordingEnabled}
          onClick={() => onAction(recording ? "recording/stop" : "recording/start")}
        >
          <Record size={18} weight="fill" className="text-[#ff6b5e]" aria-hidden />
          {!recordingEnabled ? "Perekaman tidak diizinkan" : recording ? "Hentikan rekaman" : "Mulai rekam"}
        </button>
      )}
    </div>
  );
}

function EndScreen({ state, meetingId }: { state: NonNullable<EndState>; meetingId: string }) {
  const { status } = useAuth();
  useEffect(() => {
    if (state.kind === "removed" || state.kind === "ended") guestSession.clear(meetingId);
  }, [state.kind, meetingId]);
  const copy = {
    left: { title: "Anda telah keluar dari rapat", body: "Anda dapat bergabung kembali selama rapat masih berlangsung." },
    ended: { title: "Rapat telah berakhir", body: "Transkrip final dan notulen sedang disusun. Hasilnya muncul di halaman rapat dalam beberapa menit." },
    removed: { title: "Anda dikeluarkan dari rapat", body: "Host mengeluarkan Anda. Tautan yang sama tidak dapat dipakai untuk masuk kembali." },
    error: { title: "Koneksi terputus", body: state.message ?? "Periksa koneksi internet Anda lalu coba masuk kembali." },
  }[state.kind];
  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper px-4">
      <div className="enter-pop w-full max-w-md">
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">{copy.title}</h1>
        <p className="mt-2 text-muted">{copy.body}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          {(state.kind === "left" || state.kind === "error") && (
            <Link to={`/m/${meetingId}`} className="press inline-flex h-11 items-center rounded-[10px] bg-teal px-4 font-semibold text-on-teal hover:bg-teal-hover">
              Masuk kembali
            </Link>
          )}
          {status === "authenticated" && (
            <Link to={`/rapat/${meetingId}`} className={cx("press inline-flex h-11 items-center rounded-[10px] px-4 font-semibold", state.kind === "ended" ? "bg-teal text-on-teal hover:bg-teal-hover" : "border border-line-strong bg-surface hover:bg-surface-2")}>
              Buka halaman rapat
            </Link>
          )}
          {status === "authenticated" && (
            <Link to="/" className="press inline-flex h-11 items-center rounded-[10px] px-4 font-semibold text-ink hover:bg-surface-2">
              Ke beranda
            </Link>
          )}
        </div>
        {state.kind === "ended" && status !== "authenticated" && <p className="mt-6 text-sm text-muted">Terima kasih telah hadir.</p>}
      </div>
    </div>
  );
}
