import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowClockwise, DownloadSimple, LinkSimple, PencilSimple, Play, VideoCamera, WarningCircle } from "@phosphor-icons/react";
import type { TranscriptSegmentDTO } from "@zuum/shared";
import { ROLE_LABEL } from "@zuum/shared";
import { api, ApiError, download } from "../lib/api";
import { useMeetingEvents } from "../lib/events";
import { copyInviteLink } from "../lib/invite";
import type { ActionItem, AiJob, Asset, Decision, MeetingDetail, MinutesContent, Summary, Topic } from "../lib/types";
import { fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtTime, formatTimestamp } from "../lib/format";
import { Avatar, Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, Select, Tabs, Textarea, cx, type Tone } from "../components/ui";
import { TranscriptView } from "../components/TranscriptView";
import { SettingsForm, defaultSettings, settingsPayload, type MeetingSettings } from "./CreateMeeting";

type TabId = "ringkasan" | "topik" | "keputusan" | "tindak" | "transkrip" | "notulen" | "rekaman" | "peserta";

const JOB_LABEL: Record<string, string> = {
  TRANSCRIPT_FINALIZE: "Finalisasi transkrip",
  FULL_MEETING_DOCUMENT: "Ringkasan, keputusan, tindak lanjut, notulen",
};

function ExportMenu({ label, path, formats }: { label: string; path: string; formats: { id: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
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
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="secondary" icon={<DownloadSimple size={16} aria-hidden />} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {label}
      </Button>
      {open && (
        <div role="menu" className="enter-pop absolute right-0 top-full z-20 mt-1 w-44 origin-top-right rounded-[12px] border border-line bg-surface p-1 shadow-pop">
          {formats.map((f) => (
            <button
              key={f.id}
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                try {
                  await download(path, { format: f.id });
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : "Ekspor gagal.");
                }
              }}
              className="flex h-10 w-full items-center rounded-[8px] px-3 text-left text-sm hover:bg-surface-2"
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceLinks({ ids, onOpen }: { ids: string[]; onOpen: (ids: string[]) => void }) {
  if (!ids.length) return <span className="text-sm text-muted">Tanpa rujukan transkrip</span>;
  return (
    <button onClick={() => onOpen(ids)} className="text-sm font-semibold text-teal underline-offset-4 hover:underline">
      Lihat {ids.length} kutipan di transkrip
    </button>
  );
}

const DECISION: Record<Decision["status"], { label: string; tone: Tone }> = {
  CONFIRMED: { label: "Disepakati", tone: "ok" },
  PROPOSED: { label: "Diusulkan", tone: "teal" },
  REJECTED: { label: "Ditolak", tone: "neutral" },
  NEEDS_REVIEW: { label: "Perlu ditinjau", tone: "kunyit" },
};
const ACTION: Record<ActionItem["status"], string> = { OPEN: "Terbuka", IN_PROGRESS: "Dikerjakan", DONE: "Selesai", CANCELLED: "Dibatalkan" };

export function MeetingDetailPage() {
  const { meetingId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabId) || "ringkasan";
  const setTab = (t: TabId) => setParams({ tab: t }, { replace: true });
  const [highlight, setHighlight] = useState<Set<string>>(new Set());

  const detail = useQuery({ queryKey: ["meeting", meetingId], queryFn: () => api<MeetingDetail>(`/meetings/${meetingId}`) });
  const d = detail.data;
  const m = d?.meeting;
  const perms = d?.me.permissions;
  const ended = m?.status === "ENDED";
  const canResults = !!perms?.viewResults && ended;

  const status = useQuery({
    queryKey: ["meeting", meetingId, "ai-status"],
    enabled: canResults,
    queryFn: () => api<{ jobs: AiJob[]; queued: boolean; transcript: { status: string; version: number } | null }>(`/meetings/${meetingId}/ai/status`),
    refetchInterval: (q) => {
      const s = q.state.data;
      return s && (s.queued || s.jobs.some((j) => j.status === "RUNNING" || j.status === "QUEUED") || s.transcript?.status === "FINALIZING") ? 4000 : false;
    },
  });
  const running = !!status.data && (status.data.queued || status.data.jobs.some((j) => j.status === "RUNNING" || j.status === "QUEUED"));
  const docJob = status.data?.jobs.find((j) => j.type === "FULL_MEETING_DOCUMENT");

  const summary = useQuery({ queryKey: ["meeting", meetingId, "summary"], enabled: canResults, queryFn: () => api<{ summary: Summary | null }>(`/meetings/${meetingId}/summary`) });
  const topics = useQuery({ queryKey: ["meeting", meetingId, "topics"], enabled: canResults, queryFn: () => api<{ items: Topic[] }>(`/meetings/${meetingId}/topics`) });
  const decisions = useQuery({ queryKey: ["meeting", meetingId, "decisions"], enabled: canResults, queryFn: () => api<{ items: Decision[] }>(`/meetings/${meetingId}/decisions`) });
  const actions = useQuery({ queryKey: ["meeting", meetingId, "actions"], enabled: canResults, queryFn: () => api<{ items: ActionItem[] }>(`/meetings/${meetingId}/action-items`) });
  const minutes = useQuery({
    queryKey: ["meeting", meetingId, "minutes"],
    enabled: canResults,
    queryFn: () => api<{ minutes: { version: number; content: MinutesContent; generatedAt: string; model: string | null } | null }>(`/meetings/${meetingId}/minutes`),
  });
  const transcript = useQuery({
    queryKey: ["meeting", meetingId, "transcript"],
    enabled: canResults,
    queryFn: async () => {
      let after = 0;
      const all: TranscriptSegmentDTO[] = [];
      type Meta = { status: string; metadata: { duplicateSegmentIds?: string[]; gaps?: unknown[] } | null } | null;
      let meta: Meta = null;
      for (;;) {
        const r: { transcript: Meta; segments: TranscriptSegmentDTO[]; nextAfterSequence: number | null } = await api<{ transcript: Meta; segments: TranscriptSegmentDTO[]; nextAfterSequence: number | null }>(`/meetings/${meetingId}/transcript`, {
          query: { afterSequence: after, limit: 1000 },
        });
        meta = r.transcript;
        all.push(...r.segments);
        if (r.nextAfterSequence === null) break;
        after = r.nextAfterSequence;
      }
      const dup = new Set(meta?.metadata?.duplicateSegmentIds ?? []);
      return { meta, segments: all.filter((s) => !dup.has(s.id)) };
    },
  });
  const assets = useQuery({
    queryKey: ["meeting", meetingId, "assets"],
    enabled: canResults,
    queryFn: () => api<{ items: Asset[]; storageConfigured: boolean }>(`/meetings/${meetingId}/assets`),
  });

  // When the pipeline finishes, reload results.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
    wasRunning.current = running;
  }, [running, qc, meetingId]);
  useMeetingEvents(meetingId, (ev) => {
    if (ev.type.startsWith("ai.job") || ev.type === "transcript.status.updated") void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
  }, ended);

  const segmentsById = useMemo(() => new Map((transcript.data?.segments ?? []).map((s) => [s.id, s])), [transcript.data]);
  const openEvidence = (ids: string[]) => {
    setHighlight(new Set(ids));
    setTab("transkrip");
  };

  if (detail.isLoading) return <LoadingBlock />;
  if (detail.isError || !d || !m) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;

  const regenerate = async () => {
    try {
      await api(`/meetings/${meetingId}/ai/generate`, { body: {} });
      toast.success("Hasil AI sedang disusun ulang. Transkrip tidak diubah.");
      void status.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Gagal memulai pemrosesan.");
    }
  };

  const tabs: { id: TabId; label: string; count?: number }[] = ended
    ? [
        { id: "ringkasan", label: "Ringkasan" },
        { id: "topik", label: "Topik", count: topics.data?.items.length },
        { id: "keputusan", label: "Keputusan", count: decisions.data?.items.length },
        { id: "tindak", label: "Tindak lanjut", count: actions.data?.items.length },
        { id: "transkrip", label: "Transkrip" },
        { id: "notulen", label: "Notulen" },
        { id: "rekaman", label: "Rekaman" },
        { id: "peserta", label: "Peserta" },
      ]
    : [{ id: "ringkasan", label: "Ikhtisar" }, { id: "peserta", label: "Peserta" }];

  const resultsBlocked = ended && !perms?.viewResults;

  return (
    <div className="flex flex-col gap-6">
      {/* Title block */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={m.status === "LIVE" ? "rec" : m.status === "SCHEDULED" ? "teal" : "neutral"} dot={m.status === "LIVE"}>
              {{ LIVE: "Berlangsung", SCHEDULED: "Terjadwal", ENDED: "Selesai", CANCELLED: "Dibatalkan" }[m.status]}
            </Badge>
            <span className="tnum text-sm text-muted">Kode {m.code}</span>
          </div>
          <h1 className="mt-2 text-[28px] font-extrabold leading-tight tracking-[-0.02em] sm:text-[34px]">{m.title}</h1>
          <p className="tnum mt-1 text-muted">
            {fmtDate(m.startedAt ?? m.scheduledAt ?? m.createdAt, m.timezone)}
            {m.startedAt && `, ${fmtTime(m.startedAt, m.timezone)}`}
            {m.endedAt && ` sampai ${fmtTime(m.endedAt, m.timezone)}`}
            {m.startedAt && m.endedAt && ` (${fmtDuration(new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime())})`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(m.status === "LIVE" || m.status === "SCHEDULED") && (
            <Button icon={<VideoCamera size={18} weight="fill" aria-hidden />} onClick={() => nav(`/m/${m.id}`)}>
              {m.status === "LIVE" ? "Masuk rapat" : "Mulai rapat"}
            </Button>
          )}
          {perms?.manage && (m.status === "LIVE" || m.status === "SCHEDULED") && (
            <Button variant="secondary" icon={<LinkSimple size={18} aria-hidden />} onClick={() => copyInviteLink(m.id)}>
              Salin tautan undangan
            </Button>
          )}
          {ended && perms?.generateAi && (
            <Button variant="secondary" icon={<ArrowClockwise size={18} aria-hidden />} onClick={regenerate} disabled={running}>
              Susun ulang hasil AI
            </Button>
          )}
        </div>
      </div>

      {/* Pipeline status: visible progress and actionable failures (PRD 7.1 step 12, 16.5). */}
      {ended && perms?.viewResults && (
        <PipelineStatus running={running} transcriptStatus={status.data?.transcript?.status} job={docJob} canRetry={!!perms.generateAi} onRetry={regenerate} />
      )}

      <Tabs label="Bagian rapat" tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : "ringkasan"} onChange={setTab} className="-mx-1 border-b border-line pb-2" />

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {resultsBlocked && tab !== "peserta" ? (
          <EmptyState title="Hasil rapat tidak dibagikan">Host membatasi transkrip dan hasil rapat ini.</EmptyState>
        ) : !ended && tab === "ringkasan" ? (
          <Overview detail={d} onSaved={() => qc.invalidateQueries({ queryKey: ["meeting", meetingId] })} />
        ) : tab === "ringkasan" ? (
          <SummaryTab q={summary} running={running} />
        ) : tab === "topik" ? (
          <QueryList q={topics} empty="Belum ada topik." running={running}>
            {(items: Topic[]) => (
              <ol className="flex flex-col divide-y divide-line">
                {items.map((t, i) => (
                  <li key={t.id} className="grid gap-2 py-5 sm:grid-cols-[48px_minmax(0,1fr)_auto] sm:gap-4">
                    <span className="tnum font-serif text-2xl text-muted">{String(i + 1).padStart(2, "0")}</span>
                    <div className="min-w-0">
                      <h3 className="font-bold">{t.title}</h3>
                      <p className="mt-1 font-serif text-[17px] leading-relaxed">{t.summary}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        {t.contributorIds.length > 0 && (
                          <span className="flex -space-x-1.5">
                            {t.contributorIds.map((id) => {
                              const p = d.participants.find((x) => x.id === id);
                              return p ? <Avatar key={id} name={p.displayName} id={p.identity} size={26} className="ring-2 ring-paper" /> : null;
                            })}
                          </span>
                        )}
                        <EvidenceLinks ids={t.evidenceSegmentIds} onOpen={openEvidence} />
                      </div>
                    </div>
                    {t.startMs !== null && (
                      <span className="tnum text-sm text-muted">
                        {formatTimestamp(t.startMs)}
                        {t.endMs !== null && ` sampai ${formatTimestamp(t.endMs)}`}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </QueryList>
        ) : tab === "keputusan" ? (
          <QueryList q={decisions} empty="Tidak ada keputusan yang terdeteksi di transkrip." running={running}>
            {(items: Decision[]) => (
              <ul className="flex flex-col gap-3">
                {items.map((dec) => (
                  <DecisionCard key={dec.id} dec={dec} canReview={!!perms?.review} onOpen={openEvidence} segments={segmentsById} onSaved={() => decisions.refetch()} />
                ))}
              </ul>
            )}
          </QueryList>
        ) : tab === "tindak" ? (
          <QueryList q={actions} empty="Tidak ada tindak lanjut yang terdeteksi di transkrip." running={running}>
            {(items: ActionItem[]) => (
              <ActionTable items={items} canReview={!!perms?.review} participants={d.participants} onOpen={openEvidence} onSaved={() => actions.refetch()} />
            )}
          </QueryList>
        ) : tab === "transkrip" ? (
          transcript.isLoading ? (
            <LoadingBlock />
          ) : transcript.isError ? (
            <ErrorState error={transcript.error} onRetry={() => transcript.refetch()} />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted">
                  {transcript.data?.segments.length ?? 0} segmen
                  {transcript.data?.meta?.status === "PARTIAL" && " · sebagian (ada gangguan saat transkripsi)"}
                  {(transcript.data?.meta?.metadata?.gaps?.length ?? 0) > 0 && ` · ${transcript.data?.meta?.metadata?.gaps?.length} jeda panjang`}
                </p>
                {perms?.download && (
                  <ExportMenu
                    label="Unduh transkrip"
                    path={`/meetings/${m.id}/transcript/export`}
                    formats={[
                      { id: "docx", label: "Word (.docx)" },
                      { id: "pdf", label: "PDF" },
                      { id: "txt", label: "Teks (.txt)" },
                      { id: "json", label: "JSON" },
                    ]}
                  />
                )}
              </div>
              <div className="h-[70dvh] rounded-[14px] border border-line bg-surface p-3 sm:p-4">
                <TranscriptView
                  tone="app"
                  meetingId={m.id}
                  segments={transcript.data?.segments ?? []}
                  canEdit={!!perms?.editTranscript}
                  highlightIds={highlight}
                  onUpdated={() => transcript.refetch()}
                  participants={d.participants.map((p) => ({ id: p.id, displayName: p.displayName }))}
                />
              </div>
            </div>
          )
        ) : tab === "notulen" ? (
          <MinutesTab q={minutes} running={running} meetingId={m.id} canDownload={!!perms?.download} decisions={decisions.data?.items ?? []} actions={actions.data?.items ?? []} />
        ) : tab === "rekaman" ? (
          <RecordingsTab q={assets} meetingId={m.id} canDownload={!!perms?.download} />
        ) : (
          <ParticipantsTab detail={d} />
        )}
      </div>
    </div>
  );
}

function PipelineStatus({ running, transcriptStatus, job, canRetry, onRetry }: { running: boolean; transcriptStatus?: string; job?: AiJob; canRetry: boolean; onRetry: () => void }) {
  if (running || transcriptStatus === "FINALIZING") {
    return (
      <div role="status" className="flex items-center gap-3 rounded-[14px] bg-kunyit-soft px-4 py-3 text-sm">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-kunyit" aria-hidden />
        <span>
          <strong>Menyusun hasil rapat.</strong> Transkrip difinalisasi, lalu ringkasan, keputusan, dan notulen dibuat. Halaman ini diperbarui otomatis.
        </span>
      </div>
    );
  }
  if (job?.status === "FAILED") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-[14px] border border-rec/40 bg-rec-soft px-4 py-3 text-sm sm:flex-row sm:items-center">
        <WarningCircle size={20} weight="fill" className="shrink-0 text-rec" aria-hidden />
        <span className="flex-1">
          <strong>{JOB_LABEL[job.type] ?? job.type} gagal.</strong> {job.errorMessage ?? job.errorCode}
        </span>
        {canRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Coba lagi
          </Button>
        )}
      </div>
    );
  }
  if (job?.status === "COMPLETED" && job.errorCode === "TRANSCRIPT_EMPTY") {
    return <p className="rounded-[14px] bg-surface-2 px-4 py-3 text-sm">Transkrip rapat ini kosong, jadi tidak ada ringkasan atau notulen yang dibuat.</p>;
  }
  return null;
}

function QueryList<T>({ q, empty, running, children }: { q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => void; data?: { items: T[] } }; empty: string; running: boolean; children: (items: T[]) => ReactNode }) {
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const items = q.data?.items ?? [];
  if (!items.length) return <EmptyState title={running ? "Sedang disusun..." : empty}>{!running && "Daftar ini disusun AI dari transkrip. Item tanpa bukti di transkrip tidak dibuat."}</EmptyState>;
  return <>{children(items)}</>;
}

function SummaryTab({ q, running }: { q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => void; data?: { summary: Summary | null } }; running: boolean }) {
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const s = q.data?.summary;
  if (!s) return <EmptyState title={running ? "Ringkasan sedang disusun..." : "Ringkasan belum tersedia"}>{!running && "Ringkasan dibuat otomatis setelah rapat berakhir dan transkrip difinalisasi."}</EmptyState>;
  return (
    <article className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="max-w-[68ch]">
        {s.needsReview && (
          <p className="mb-5 rounded-[10px] bg-kunyit-soft px-3 py-2 text-sm">Beberapa keputusan atau tindak lanjut perlu ditinjau manusia sebelum notulen disahkan.</p>
        )}
        {s.purpose && (
          <p className="mb-4 text-sm">
            <span className="font-bold">Tujuan rapat: </span>
            {s.purpose}
          </p>
        )}
        <div className="flex flex-col gap-4 font-serif text-[19px] leading-[1.65]">
          {s.overview.split(/\n{2,}/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </div>
      <aside className="lg:border-l lg:border-line lg:pl-8">
        <h2 className="text-sm font-bold">Poin utama</h2>
        {s.keyPoints.length ? (
          <ul className="mt-3 flex flex-col gap-3">
            {s.keyPoints.map((k, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-relaxed">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-teal" aria-hidden />
                {k}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">Tidak ada.</p>
        )}
        <p className="mt-6 text-xs text-muted">
          Versi {s.version} · {fmtDateTime(s.generatedAt)}
          {s.model && ` · ${s.model}`}
        </p>
      </aside>
    </article>
  );
}

function DecisionCard({ dec, canReview, onOpen, segments, onSaved }: { dec: Decision; canReview: boolean; onOpen: (ids: string[]) => void; segments: Map<string, TranscriptSegmentDTO>; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ description: dec.description, status: dec.status });
  const [busy, setBusy] = useState(false);
  const quote = dec.evidenceSegmentIds.map((id) => segments.get(id)).find(Boolean);
  const save = async (patch: Partial<typeof form>) => {
    setBusy(true);
    try {
      await api(`/decisions/${dec.id}`, { method: "PATCH", body: patch });
      toast.success("Keputusan diperbarui.");
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Gagal menyimpan.");
    } finally {
      setBusy(false);
    }
  };
  const st = DECISION[dec.status];
  return (
    <li className="rounded-[14px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Badge tone={st.tone}>{st.label}</Badge>
        {canReview && !editing && (
          <div className="flex gap-1">
            {dec.status !== "CONFIRMED" && (
              <Button size="sm" variant="ghost" onClick={() => save({ status: "CONFIRMED" })} loading={busy}>
                Tandai disepakati
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<PencilSimple size={16} aria-hidden />} onClick={() => setEditing(true)}>
              Ubah
            </Button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="mt-3 flex flex-col gap-3">
          <Textarea aria-label="Isi keputusan" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Select aria-label="Status keputusan" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Decision["status"] })}>
            {Object.entries(DECISION).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
          <div className="flex gap-2">
            <Button size="sm" loading={busy} onClick={() => save(form)}>
              Simpan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Batal
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 font-serif text-[18px] leading-relaxed">{dec.description}</p>
      )}
      {dec.context && <p className="mt-2 text-sm text-muted">{dec.context}</p>}
      {quote && (
        <blockquote className="mt-3 border-l-2 border-line-strong pl-3 text-sm text-muted">
          <span className="font-semibold text-ink">{quote.speakerName}</span>, <span className="tnum">{formatTimestamp(quote.startMs)}</span>: "{quote.text}"
        </blockquote>
      )}
      <div className="mt-3">
        <EvidenceLinks ids={dec.evidenceSegmentIds} onOpen={onOpen} />
      </div>
    </li>
  );
}

function ActionTable({ items, canReview, participants, onOpen, onSaved }: { items: ActionItem[]; canReview: boolean; participants: MeetingDetail["participants"]; onOpen: (ids: string[]) => void; onSaved: () => void }) {
  const [edit, setEdit] = useState<ActionItem | null>(null);
  const [form, setForm] = useState({ description: "", assigneeParticipantId: "", dueDate: "", status: "OPEN" as ActionItem["status"] });
  const [busy, setBusy] = useState(false);
  const open = (a: ActionItem) => {
    setEdit(a);
    setForm({ description: a.description, assigneeParticipantId: a.assigneeParticipantId ?? "", dueDate: a.dueDate?.slice(0, 10) ?? "", status: a.status });
  };
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api(`/action-items/${edit.id}`, {
        method: "PATCH",
        body: { description: form.description, assigneeParticipantId: form.assigneeParticipantId || null, dueDate: form.dueDate || null, status: form.status },
      });
      toast.success("Tindak lanjut diperbarui.");
      setEdit(null);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Gagal menyimpan.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ul className="flex flex-col divide-y divide-line rounded-[14px] border border-line bg-surface">
        {items.map((a) => (
          <li key={a.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-6 sm:p-5">
            <div className="min-w-0 flex-1">
              <p className={cx("font-medium leading-relaxed", a.status === "DONE" && "text-muted line-through")}>{a.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className={a.assignee ? "text-ink" : "text-muted"}>
                  <span className="text-muted">Penanggung jawab: </span>
                  {a.assignee?.displayName ?? "Belum ditentukan"}
                </span>
                <span className={a.dueDate ? "text-ink" : "text-muted"}>
                  <span className="text-muted">Tenggat: </span>
                  {a.dueDate ? fmtDate(a.dueDate, "UTC") : "Tidak disebutkan"}
                </span>
              </div>
              <div className="mt-2">
                <EvidenceLinks ids={a.evidenceSegmentIds} onOpen={onOpen} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {a.needsReview && <Badge tone="kunyit">Perlu ditinjau</Badge>}
              <Badge tone={a.status === "DONE" ? "ok" : a.status === "IN_PROGRESS" ? "teal" : "neutral"}>{ACTION[a.status]}</Badge>
              {canReview && (
                <Button size="sm" variant="ghost" aria-label={`Ubah tindak lanjut: ${a.description}`} icon={<PencilSimple size={16} aria-hidden />} onClick={() => open(a)}>
                  Ubah
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title="Ubah tindak lanjut"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Batal
            </Button>
            <Button loading={busy} onClick={save}>
              Simpan
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Deskripsi" htmlFor="ai-desc">
            <Textarea id="ai-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Penanggung jawab" htmlFor="ai-who">
            <Select id="ai-who" value={form.assigneeParticipantId} onChange={(e) => setForm({ ...form, assigneeParticipantId: e.target.value })}>
              <option value="">Belum ditentukan</option>
              {participants
                .filter((p) => p.status === "JOINED" || p.status === "LEFT")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tenggat" htmlFor="ai-due">
              <Input id="ai-due" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </Field>
            <Field label="Status" htmlFor="ai-status">
              <Select id="ai-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ActionItem["status"] })}>
                {Object.entries(ACTION).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function MinutesTab({
  q,
  running,
  meetingId,
  canDownload,
  decisions,
  actions,
}: {
  q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => void; data?: { minutes: { version: number; content: MinutesContent; generatedAt: string; model: string | null } | null } };
  running: boolean;
  meetingId: string;
  canDownload: boolean;
  decisions: Decision[];
  actions: ActionItem[];
}) {
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const mn = q.data?.minutes;
  if (!mn) return <EmptyState title={running ? "Notulen sedang disusun..." : "Notulen belum tersedia"} />;
  const c = mn.content;
  const NA = <span className="text-muted">Tidak disebutkan</span>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Versi {mn.version} · {fmtDateTime(mn.generatedAt)}
        </p>
        {canDownload && (
          <ExportMenu
            label="Unduh notulen"
            path={`/meetings/${meetingId}/minutes/export`}
            formats={[
              { id: "docx", label: "Word (.docx)" },
              { id: "pdf", label: "PDF" },
              { id: "txt", label: "Teks (.txt)" },
            ]}
          />
        )}
      </div>
      {/* The minutes read as a document: serif body on a paper sheet. */}
      <article className="mx-auto w-full max-w-[760px] rounded-[6px] border border-line bg-surface px-5 py-8 font-serif text-[17px] leading-[1.7] shadow-[0_1px_0_var(--line)] sm:px-14 sm:py-14">
        <header className="border-b border-line pb-6 text-center">
          <p className="font-sans text-xs font-semibold text-muted">NOTULEN RAPAT</p>
          <h2 className="mt-2 text-[26px] font-semibold leading-tight">{c.title}</h2>
          <p className="mt-2 text-[15px] text-muted">{c.dateLine}</p>
        </header>
        <dl className="mt-6 grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[15px] max-sm:grid-cols-1">
          <dt className="font-sans text-sm font-semibold text-muted">Pimpinan rapat</dt>
          <dd>{c.host}</dd>
          <dt className="font-sans text-sm font-semibold text-muted">Peserta</dt>
          <dd>{c.participants.length ? c.participants.join(", ") : NA}</dd>
        </dl>
        <h3 className="mt-8 text-[20px] font-semibold">Agenda</h3>
        {c.agenda.length ? (
          <ol className="mt-2 list-decimal pl-6">
            {c.agenda.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-2">{NA}</p>
        )}
        <h3 className="mt-8 text-[20px] font-semibold">Ringkasan</h3>
        <p className="mt-2">{c.summary || NA}</p>
        <h3 className="mt-8 text-[20px] font-semibold">Pembahasan</h3>
        {c.sections.length ? (
          c.sections.map((s, i) => (
            <div key={i} className="mt-3">
              <p className="font-semibold">{s.topic}</p>
              <p>{s.discussion}</p>
            </div>
          ))
        ) : (
          <p className="mt-2">{NA}</p>
        )}
        <h3 className="mt-8 text-[20px] font-semibold">Keputusan</h3>
        {decisions.length ? (
          <ol className="mt-2 list-decimal pl-6">
            {decisions.map((d) => (
              <li key={d.id}>
                {d.description} <span className="font-sans text-sm text-muted">({DECISION[d.status].label})</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2">{NA}</p>
        )}
        <h3 className="mt-8 text-[20px] font-semibold">Tindak lanjut</h3>
        {actions.length ? (
          <ol className="mt-2 list-decimal pl-6">
            {actions
              .filter((a) => a.status !== "CANCELLED")
              .map((a) => (
                <li key={a.id}>
                  {a.description}. Penanggung jawab: {a.assignee?.displayName ?? "Belum ditentukan"}. Tenggat: {a.dueDate ? fmtDate(a.dueDate, "UTC") : "Tidak disebutkan"}.
                </li>
              ))}
          </ol>
        ) : (
          <p className="mt-2">{NA}</p>
        )}
        {c.closingNotes && (
          <>
            <h3 className="mt-8 text-[20px] font-semibold">Penutup</h3>
            <p className="mt-2">{c.closingNotes}</p>
          </>
        )}
        <p className="mt-10 border-t border-line pt-4 font-sans text-xs text-muted">{c.disclaimer}</p>
      </article>
    </div>
  );
}

function RecordingsTab({ q, meetingId, canDownload }: { q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => void; data?: { items: Asset[]; storageConfigured: boolean } }; meetingId: string; canDownload: boolean }) {
  const [playing, setPlaying] = useState<{ url: string; name: string } | null>(null);
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const items = q.data?.items ?? [];
  if (!items.length) return <EmptyState title="Tidak ada rekaman">Rekaman hanya dibuat bila host menekan tombol rekam selama rapat.</EmptyState>;
  const label: Record<Asset["status"], { text: string; tone: Tone }> = {
    QUEUED: { text: "Antre", tone: "neutral" },
    RECORDING: { text: "Merekam", tone: "rec" },
    PROCESSING: { text: "Diproses", tone: "kunyit" },
    READY: { text: "Siap", tone: "ok" },
    FAILED: { text: "Gagal", tone: "rec" },
    DELETED: { text: "Dihapus", tone: "neutral" },
  };
  const play = async (a: Asset) => {
    try {
      const r = await api<{ url: string }>(`/meetings/${meetingId}/assets/${a.id}/url`, { body: {} });
      setPlaying({ url: r.url, name: a.fileName ?? "Rekaman" });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Rekaman tidak dapat dibuka.");
    }
  };
  return (
    <>
      <ul className="flex flex-col divide-y divide-line rounded-[14px] border border-line bg-surface">
        {items.map((a) => (
          <li key={a.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{a.type === "COMPOSITE_RECORDING" ? "Rekaman rapat (video)" : a.type === "AUDIO_TRACK" ? "Audio per peserta" : a.type}</p>
              <p className="tnum text-sm text-muted">
                {fmtDateTime(a.createdAt)}
                {a.durationMs ? ` · ${fmtDuration(a.durationMs)}` : ""}
                {a.sizeBytes ? ` · ${fmtBytes(a.sizeBytes)}` : ""}
              </p>
              {a.status === "FAILED" && <p className="mt-1 text-sm text-rec">{a.errorMessage ?? a.errorCode}</p>}
            </div>
            <Badge tone={label[a.status].tone}>{label[a.status].text}</Badge>
            {a.status === "READY" && canDownload && (
              <Button size="sm" variant="secondary" icon={<Play size={16} weight="fill" aria-hidden />} onClick={() => play(a)}>
                Putar
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!q.data?.storageConfigured && <p className="mt-3 text-sm text-muted">Penyimpanan objek (S3) belum dikonfigurasi di server, sehingga rekaman belum dapat diputar.</p>}
      <Dialog open={!!playing} onClose={() => setPlaying(null)} title={playing?.name ?? ""} width={880}>
        {playing && <video src={playing.url} controls autoPlay className="w-full rounded-[10px] bg-black" />}
        <p className="mt-2 text-xs text-muted">Tautan pemutaran berlaku 10 menit.</p>
      </Dialog>
    </>
  );
}

function ParticipantsTab({ detail }: { detail: MeetingDetail }) {
  const rows = detail.participants.filter((p) => p.status !== "INVITED" || p.role === "OWNER");
  if (!rows.length) return <EmptyState title="Belum ada peserta" />;
  const STATUS: Record<string, string> = { JOINED: "Hadir", LEFT: "Hadir, sudah keluar", WAITING: "Menunggu", REMOVED: "Dikeluarkan", REJECTED: "Ditolak", INVITED: "Belum masuk" };
  return (
    <ul className="flex flex-col divide-y divide-line rounded-[14px] border border-line bg-surface">
      {rows.map((p) => (
        <li key={p.id} className="flex items-center gap-3 p-3 sm:px-5">
          <Avatar name={p.displayName} id={p.identity} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{p.displayName}</p>
            <p className="text-sm text-muted">
              {ROLE_LABEL[p.role]}
              {p.isGuest ? " · tanpa akun" : ""}
            </p>
          </div>
          <span className="text-right text-sm text-muted">
            {STATUS[p.status]}
            {p.joinedAt && <span className="tnum block text-xs">masuk {fmtTime(p.joinedAt)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Overview({ detail, onSaved }: { detail: MeetingDetail; onSaved: () => void }) {
  const m = detail.meeting;
  const canEdit = detail.me.permissions.manage && m.status === "SCHEDULED";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<MeetingSettings>(defaultSettings);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const nav = useNavigate();
  const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

  const startEdit = () => {
    setValue({
      ...defaultSettings,
      ...m,
      description: m.description ?? "",
      scheduledAt: toLocal(m.scheduledAt),
      durationMinutes: m.durationMinutes ? String(m.durationMinutes) : "",
      passcode: "",
    });
    setEditing(true);
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-6">
        <SettingsForm value={value} onChange={setValue} errors={{}} />
        <p className="text-sm text-muted">Kosongkan kode sandi untuk mempertahankan yang lama.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Batal
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { passcode, ...rest } = settingsPayload(value);
                await api(`/meetings/${m.id}`, { method: "PATCH", body: passcode ? { ...rest, passcode } : rest });
                toast.success("Pengaturan disimpan.");
                setEditing(false);
                onSaved();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : "Gagal menyimpan.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Simpan pengaturan
          </Button>
        </div>
      </div>
    );
  }

  const rows: [string, ReactNode][] = [
    ["Agenda", m.agenda.length ? m.agenda.join("; ") : "Belum diisi"],
    ["Akses tamu", m.guestLinkEnabled ? "Diizinkan melalui tautan" : "Tidak diizinkan"],
    ["Ruang tunggu", m.waitingRoom ? "Aktif" : "Nonaktif"],
    ["Kode sandi", m.hasPasscode ? "Ada" : "Tidak ada"],
    ["Transkripsi", m.transcriptionEnabled ? "Aktif, Bahasa Indonesia" : "Nonaktif"],
    ["Perekaman", m.recordingEnabled ? "Diizinkan (dimulai manual oleh host)" : "Tidak diizinkan"],
    ["Kapasitas", `${m.maxParticipants} peserta`],
    ["Retensi data", `${m.retentionDays} hari`],
  ];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <dl className="divide-y divide-line rounded-[14px] border border-line bg-surface">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:px-5">
            <dt className="text-sm font-semibold text-muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {detail.me.permissions.manage && (
        <div className="flex flex-col gap-3">
          {canEdit && (
            <Button variant="secondary" icon={<PencilSimple size={18} aria-hidden />} onClick={startEdit}>
              Ubah pengaturan
            </Button>
          )}
          <Button variant="secondary" icon={<ArrowClockwise size={18} aria-hidden />} onClick={() => copyInviteLink(m.id, { rotate: true })}>
            Cabut semua tautan lama
          </Button>
          {m.status === "SCHEDULED" && (
            <Button variant="ghost" className="text-rec hover:bg-rec-soft" onClick={() => setConfirmCancel(true)}>
              Batalkan rapat
            </Button>
          )}
          <p className="text-sm text-muted">Mencabut tautan membuat tautan lama tidak berlaku; tautan baru langsung disalin.</p>
        </div>
      )}
      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Batalkan rapat ini?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              Kembali
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api(`/meetings/${m.id}/cancel`, { body: {} });
                  toast.success("Rapat dibatalkan.");
                  nav("/");
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : "Gagal membatalkan.");
                }
              }}
            >
              Batalkan rapat
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">Tautan undangan tidak dapat dipakai lagi setelah rapat dibatalkan.</p>
      </Dialog>
      {m.status === "LIVE" && (
        <p className="text-sm text-muted lg:col-span-2">
          Rapat sedang berlangsung. <Link to={`/m/${m.id}`} className="font-semibold text-teal underline-offset-4 hover:underline">Masuk rapat</Link>
        </p>
      )}
    </div>
  );
}
