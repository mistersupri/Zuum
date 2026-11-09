import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Camera, CameraSlash, LinkSimple, Microphone, MicrophoneSlash, Record, ClosedCaptioning, Hourglass, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError, guestSession } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMeetingEvents } from "../lib/events";
import { copyInviteLink } from "../lib/invite";
import { loadPrefs, savePrefs, usePreview, type DevicePrefs } from "../lib/devices";
import type { JoinResponse } from "../lib/types";
import { fmtDateTime } from "../lib/format";
import { Wordmark } from "../components/AppShell";
import { Avatar, Button, Field, Input, LoadingBlock, Select, cx } from "../components/ui";

interface Preview {
  meeting: {
    id: string;
    title: string;
    status: "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";
    scheduledAt: string | null;
    hasPasscode: boolean;
    waitingRoom: boolean;
    recordingEnabled: boolean;
    transcriptionEnabled: boolean;
    hostName: string;
    guestLinkEnabled: boolean;
    isOwner?: boolean;
  };
  consentNoticeVersion: string;
}

export const joinStorageKey = (meetingId: string) => `zuum-join:${meetingId}`;

function DeviceSelect({ label, kind, value, devices, onChange }: { label: string; kind: MediaDeviceKind; value?: string; devices: MediaDeviceInfo[]; onChange: (id: string) => void }) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId);
  if (!list.length) return null;
  const id = `dev-${kind}`;
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Bawaan sistem</option>
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function JoinPage() {
  const { token, meetingId: routeMeetingId } = useParams();
  const { user, status } = useAuth();
  const nav = useNavigate();

  const preview = useQuery({
    queryKey: ["join-preview", token ?? routeMeetingId, status],
    enabled: status !== "loading" && (!!token || status === "authenticated" || !!(routeMeetingId && guestSession.get(routeMeetingId))),
    queryFn: () =>
      token
        ? api<Preview>(`/invitations/${token}/preview`)
        : api<Preview>(`/meetings/${routeMeetingId}/preview`, { guestFor: routeMeetingId }),
  });

  const [prefs, setPrefs] = useState<DevicePrefs>(loadPrefs);
  const { stream, devices, permission, level, stop } = usePreview(prefs);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [waiting, setWaiting] = useState<null | "WAITING" | "NOT_STARTED">(null);
  const [needPasscode, setNeedPasscode] = useState(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const meeting = preview.data?.meeting;
  const meetingId = meeting?.id ?? routeMeetingId;
  const needsConsent = !!meeting && (meeting.recordingEnabled || meeting.transcriptionEnabled);
  const isGuest = status !== "authenticated";

  const attemptJoin = useCallback(async () => {
    if (!meetingId || !preview.data) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<JoinResponse>(`/meetings/${meetingId}/join`, {
        guestFor: meetingId,
        body: {
          invitationToken: token,
          displayName: isGuest ? name.trim() || undefined : undefined,
          passcode: passcode || undefined,
          consent: needsConsent
            ? { recording: consent, transcription: consent, noticeVersion: preview.data.consentNoticeVersion }
            : undefined,
        },
      });
      if (res.guestToken) guestSession.set(meetingId, res.guestToken);
      if (res.status === "JOINED") {
        sessionStorage.setItem(joinStorageKey(meetingId), JSON.stringify({ join: res, prefs }));
        stop();
        nav(`/m/${meetingId}/ruang`, { replace: true });
        return;
      }
      setWaiting(res.status);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Gagal bergabung.");
      if (e.code === "PASSCODE_REQUIRED" || e.code === "PASSCODE_INVALID") setNeedPasscode(true);
      setError(e);
      setWaiting(null);
    } finally {
      setBusy(false);
    }
  }, [meetingId, preview.data, token, isGuest, name, passcode, needsConsent, consent, prefs, stop, nav]);

  // While waiting: admitted/rejected arrive over SSE; polling covers missed events and "host started".
  useMeetingEvents(
    meetingId,
    (ev) => {
      if (ev.type === "meeting.participant.admitted") void attemptJoin();
      if (ev.type === "meeting.participant.rejected") {
        setWaiting(null);
        setError(new ApiError(403, "PARTICIPANT_REJECTED", "Host menolak permintaan Anda untuk masuk."));
      }
    },
    !!waiting,
  );
  useEffect(() => {
    if (!waiting || !meetingId) return;
    const t = setInterval(async () => {
      try {
        const me = await api<{ admitted: boolean; meetingStatus: string; status: string }>(`/meetings/${meetingId}/me`, { guestFor: meetingId });
        if (me.status === "REJECTED") {
          setWaiting(null);
          setError(new ApiError(403, "PARTICIPANT_REJECTED", "Host menolak permintaan Anda untuk masuk."));
        } else if (me.admitted && me.meetingStatus === "LIVE") void attemptJoin();
      } catch {
        /* keep waiting */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [waiting, meetingId, attemptJoin]);

  if (status === "loading") return <LoadingBlock />;
  if (!token && status === "anonymous" && !(routeMeetingId && guestSession.get(routeMeetingId))) {
    return <Navigate to={`/masuk?lanjut=${encodeURIComponent(`/m/${routeMeetingId}`)}`} replace />;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attemptJoin();
  };

  const ended = meeting && (meeting.status === "ENDED" || meeting.status === "CANCELLED");
  const canSubmit = !!meeting && !ended && (!isGuest || name.trim().length >= 2) && (!needsConsent || consent);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center justify-between px-4 sm:px-8">
        <Link to={user ? "/" : "#"} aria-label="Zuum" className="rounded-md text-ink">
          <Wordmark />
        </Link>
        {user && <span className="text-sm text-muted">Masuk sebagai {user.displayName}</span>}
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 items-start gap-8 px-4 pb-12 pt-4 sm:px-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-12 lg:pt-10">
        {/* Preview */}
        <section aria-label="Pratinjau kamera dan mikrofon" className="flex flex-col gap-4">
          <div className="relative aspect-video overflow-hidden rounded-[16px] bg-room">
            {prefs.camOn && stream?.getVideoTracks().length ? (
              <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Avatar name={(isGuest ? name : user?.displayName) || "Anda"} id={user?.id} size={88} />
              </div>
            )}
            {permission === "denied" && (
              <div className="absolute inset-0 flex items-center justify-center bg-room/90 p-6 text-center text-room-ink">
                <div className="max-w-sm">
                  <p className="font-semibold">Browser memblokir kamera atau mikrofon</p>
                  <p className="mt-2 text-sm text-room-muted">
                    Izinkan akses lewat ikon gembok di bilah alamat, lalu muat ulang halaman. Anda tetap bisa bergabung untuk mendengarkan.
                  </p>
                </div>
              </div>
            )}
            {permission === "asking" && (
              <p className="absolute inset-x-0 bottom-0 bg-black/55 px-4 py-2 text-center text-sm text-white">Izinkan akses kamera dan mikrofon di browser Anda.</p>
            )}
            <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
              <button
                type="button"
                onClick={() => setPrefs((p) => ({ ...p, micOn: !p.micOn }))}
                aria-pressed={prefs.micOn}
                aria-label={prefs.micOn ? "Matikan mikrofon" : "Nyalakan mikrofon"}
                className={cx("press relative flex size-12 items-center justify-center overflow-hidden rounded-full", prefs.micOn ? "bg-room-3 text-room-ink" : "bg-rec text-white")}
              >
                {prefs.micOn && <span className="absolute inset-x-0 bottom-0 bg-kunyit/60 transition-[height] duration-75" style={{ height: `${Math.round(level * 100)}%` }} aria-hidden />}
                <span className="relative">{prefs.micOn ? <Microphone size={22} weight="fill" /> : <MicrophoneSlash size={22} weight="fill" />}</span>
              </button>
              <button
                type="button"
                onClick={() => setPrefs((p) => ({ ...p, camOn: !p.camOn }))}
                aria-pressed={prefs.camOn}
                aria-label={prefs.camOn ? "Matikan kamera" : "Nyalakan kamera"}
                className={cx("press flex size-12 items-center justify-center rounded-full", prefs.camOn ? "bg-room-3 text-room-ink" : "bg-rec text-white")}
              >
                {prefs.camOn ? <Camera size={22} weight="fill" /> : <CameraSlash size={22} weight="fill" />}
              </button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <DeviceSelect label="Mikrofon" kind="audioinput" value={prefs.audioInput} devices={devices} onChange={(v) => setPrefs((p) => ({ ...p, audioInput: v || undefined }))} />
            <DeviceSelect label="Kamera" kind="videoinput" value={prefs.videoInput} devices={devices} onChange={(v) => setPrefs((p) => ({ ...p, videoInput: v || undefined }))} />
            {"setSinkId" in HTMLMediaElement.prototype && (
              <DeviceSelect label="Speaker" kind="audiooutput" value={prefs.audioOutput} devices={devices} onChange={(v) => setPrefs((p) => ({ ...p, audioOutput: v || undefined }))} />
            )}
          </div>
        </section>

        {/* Join form */}
        <section aria-labelledby="join-title" className="flex flex-col gap-6">
          {preview.isLoading ? (
            <LoadingBlock label="Memeriksa undangan..." />
          ) : preview.isError ? (
            <div className="flex flex-col gap-3">
              <h1 id="join-title" className="text-[26px] font-extrabold tracking-[-0.02em]">
                Tidak dapat membuka rapat
              </h1>
              <p className="text-muted">{preview.error instanceof ApiError ? preview.error.message : "Tautan tidak dapat diperiksa."}</p>
              {user && (
                <Link to="/" className="font-semibold text-teal">
                  Kembali ke beranda
                </Link>
              )}
            </div>
          ) : meeting ? (
            waiting ? (
              <div className="flex flex-col gap-4" role="status" aria-live="polite">
                <Hourglass size={32} className="text-teal" aria-hidden />
                <h1 id="join-title" className="text-[26px] font-extrabold tracking-[-0.02em]">
                  {waiting === "WAITING" ? "Menunggu persetujuan host" : "Rapat belum dimulai"}
                </h1>
                <p className="text-muted">
                  {waiting === "WAITING"
                    ? `${meeting.hostName} akan menerima Anda ke "${meeting.title}". Halaman ini otomatis masuk begitu disetujui.`
                    : `Anda akan otomatis masuk saat ${meeting.hostName} memulai rapat.`}
                </p>
                <div>
                  <Button variant="secondary" onClick={() => setWaiting(null)}>
                    Batal
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
                <div>
                  <p className="text-sm text-muted">Rapat oleh {meeting.hostName}</p>
                  <h1 id="join-title" className="mt-1 text-[28px] font-extrabold leading-tight tracking-[-0.02em]">
                    {meeting.title}
                  </h1>
                  {meeting.status === "SCHEDULED" && meeting.scheduledAt && (
                    <p className="tnum mt-1 text-sm text-muted">Dijadwalkan {fmtDateTime(meeting.scheduledAt)}</p>
                  )}
                </div>

                {ended ? (
                  <p className="rounded-[10px] bg-surface-2 px-3 py-3 text-ink">Rapat ini sudah berakhir.</p>
                ) : (
                  <>
                    {isGuest && (
                      <Field label="Nama Anda" htmlFor="guest-name" hint="Nama ini dipakai sebagai nama pembicara di transkrip.">
                        <Input id="guest-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
                      </Field>
                    )}
                    {(meeting.hasPasscode || needPasscode) && !meeting.isOwner && (
                      <Field label="Kode sandi rapat" htmlFor="passcode">
                        <Input id="passcode" autoComplete="off" value={passcode} onChange={(e) => setPasscode(e.target.value)} invalid={error?.code === "PASSCODE_INVALID"} />
                      </Field>
                    )}
                    {needsConsent && (
                      <div className="rounded-[14px] border border-line bg-surface p-4">
                        <p className="font-semibold">Sebelum masuk</p>
                        <ul className="mt-2 flex flex-col gap-2 text-sm text-ink">
                          {meeting.transcriptionEnabled && (
                            <li className="flex gap-2">
                              <ClosedCaptioning size={18} className="mt-0.5 shrink-0 text-teal" aria-hidden />
                              Suara Anda ditranskripsi otomatis dan diberi nama Anda sebagai pembicara.
                            </li>
                          )}
                          {meeting.recordingEnabled && (
                            <li className="flex gap-2">
                              <Record size={18} className="mt-0.5 shrink-0 text-rec" aria-hidden />
                              Host dapat merekam audio dan video. Indikator REC selalu tampil saat rekaman berjalan.
                            </li>
                          )}
                        </ul>
                        <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm font-medium">
                          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--teal)]" />
                          Saya mengerti dan setuju rapat ini dapat ditranskripsi dan direkam.
                        </label>
                      </div>
                    )}
                    {error && (
                      <p role="alert" className="flex items-start gap-2 rounded-[10px] bg-rec-soft px-3 py-2.5 text-sm font-medium text-rec">
                        <WarningCircle weight="fill" className="mt-0.5 shrink-0" aria-hidden />
                        {error.message}
                      </p>
                    )}
                    <Button type="submit" size="lg" loading={busy} disabled={!canSubmit}>
                      {meeting.isOwner && meeting.status !== "LIVE" ? "Mulai rapat" : meeting.waitingRoom && !meeting.isOwner ? "Minta masuk" : "Masuk rapat"}
                    </Button>
                    {meeting.isOwner && (
                      <Button type="button" variant="secondary" icon={<LinkSimple size={18} aria-hidden />} onClick={() => copyInviteLink(meeting.id)}>
                        Salin tautan undangan
                      </Button>
                    )}
                    {isGuest && (
                      <p className="text-sm text-muted">
                        Punya akun?{" "}
                        <Link to={`/masuk?lanjut=${encodeURIComponent(location.pathname)}`} className="font-semibold text-teal underline-offset-4 hover:underline">
                          Masuk dulu
                        </Link>{" "}
                        agar rapat tersimpan di riwayat Anda.
                      </p>
                    )}
                  </>
                )}
              </form>
            )
          ) : null}
        </section>
      </main>
    </div>
  );
}
