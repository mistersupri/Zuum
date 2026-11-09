import { useEffect, useMemo, useState } from "react";
import { Track, type Participant } from "livekit-client";
import {
  VideoTrack,
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useSpeakingParticipants,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { CaretLeft, CaretRight, MicrophoneSlash, MonitorArrowUp } from "@phosphor-icons/react";
import { Avatar, cx } from "../components/ui";

export type Layout = "grid" | "speaker";

function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

const isAgent = (p: Participant) => p.identity.startsWith("zuum-");

function Tile({ trackRef, size = "grid", className }: { trackRef: TrackReferenceOrPlaceholder; size?: "grid" | "spot" | "strip"; className?: string }) {
  const p = trackRef.participant;
  const speaking = useIsSpeaking(p);
  const micMuted = useIsMuted({ participant: p, source: Track.Source.Microphone } as TrackReferenceOrPlaceholder);
  const camOff = useIsMuted(trackRef);
  const isScreen = trackRef.source === Track.Source.ScreenShare;
  const showVideo = isTrackReference(trackRef) && !camOff;
  const name = p.name || p.identity;

  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-[12px] bg-room-3",
        speaking && !isScreen && "speaking-ring",
        size === "strip" ? "aspect-video w-40 shrink-0 sm:w-48" : "h-full w-full",
        className,
      )}
    >
      {showVideo ? (
        <VideoTrack trackRef={trackRef} className={cx("h-full w-full", isScreen ? "object-contain bg-black" : "object-cover", p.isLocal && !isScreen && "-scale-x-100")} />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Avatar name={name} id={p.identity} size={size === "strip" ? 40 : size === "spot" ? 112 : 72} speaking={speaking} />
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-[8px] bg-black/60 px-2 py-1 text-xs font-semibold text-white">
        {isScreen && <MonitorArrowUp size={14} aria-hidden />}
        {!isScreen && micMuted && <MicrophoneSlash size={14} weight="fill" className="text-[#ff8f85]" aria-label="Mikrofon mati" />}
        <span className="truncate">
          {isScreen ? `Layar ${name}` : name}
          {p.isLocal && !isScreen ? " (Anda)" : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * Video stage. Only tiles on the current page are rendered; with adaptiveStream on,
 * LiveKit pauses video for tracks that are not on screen, so a 100+ room does not
 * subscribe to 100 HD streams (PRD 4.5, 5.4, 12.3).
 */
export function Stage({ layout }: { layout: Layout }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  ).filter((t) => !isAgent(t.participant));
  const speakers = useSpeakingParticipants();
  const isMobile = useMedia("(max-width: 639px)");
  const perPage = isMobile ? 4 : 9;
  const [page, setPage] = useState(0);
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);

  useEffect(() => {
    const s = speakers.find((p) => !p.isLocal && !isAgent(p)) ?? speakers.find((p) => !isAgent(p));
    if (s) setLastSpeaker(s.identity);
  }, [speakers]);

  const cameras = useMemo(() => tracks.filter((t) => t.source === Track.Source.Camera), [tracks]);
  const screen = tracks.find((t) => t.source === Track.Source.ScreenShare && isTrackReference(t));

  // Spotlight: a screen share wins; otherwise the most recent speaker in speaker layout.
  const spotlight =
    screen ??
    (layout === "speaker" ? cameras.find((t) => t.participant.identity === lastSpeaker) ?? cameras.find((t) => !t.participant.isLocal) ?? cameras[0] : undefined);

  if (spotlight) {
    const strip = cameras.filter((t) => t !== spotlight);
    const stripPage = strip.slice(page * 6, page * 6 + 6);
    const pages = Math.ceil(strip.length / 6);
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="min-h-0 flex-1">
          <Tile trackRef={spotlight} size="spot" />
        </div>
        {strip.length > 0 && (
          <div className="flex items-center gap-2">
            <PageButton dir="prev" disabled={page === 0} onClick={() => setPage((p) => p - 1)} hidden={pages <= 1} />
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto scrollbar-thin">
              {stripPage.map((t) => (
                <Tile key={`${t.participant.identity}-${t.source}`} trackRef={t} size="strip" />
              ))}
            </div>
            <PageButton dir="next" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} hidden={pages <= 1} />
          </div>
        )}
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(cameras.length / perPage));
  const current = Math.min(page, pages - 1);
  const visible = cameras.slice(current * perPage, current * perPage + perPage);
  const n = visible.length;
  const cols = isMobile ? (n <= 1 ? 1 : 2) : n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div
        className="grid min-h-0 flex-1 gap-2 sm:gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {visible.map((t) => (
          <Tile key={`${t.participant.identity}-${t.source}`} trackRef={t} />
        ))}
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm text-room-muted">
          <PageButton dir="prev" disabled={current === 0} onClick={() => setPage(current - 1)} />
          <span className="tnum" aria-live="polite">
            Halaman {current + 1} dari {pages}
          </span>
          <PageButton dir="next" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} />
        </div>
      )}
    </div>
  );
}

function PageButton({ dir, disabled, onClick, hidden }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Halaman sebelumnya" : "Halaman berikutnya"}
      className="press flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-room-3 text-room-ink disabled:opacity-40"
    >
      {dir === "prev" ? <CaretLeft size={18} /> : <CaretRight size={18} />}
    </button>
  );
}
