import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, X } from "@phosphor-icons/react";
import { api, ApiError } from "../lib/api";
import type { Meeting } from "../lib/types";
import { rememberInvite } from "../lib/invite";
import { Button, Field, Input, Select, Switch, Textarea } from "../components/ui";

export interface MeetingSettings {
  title: string;
  description: string;
  agenda: string[];
  scheduledAt: string;
  durationMinutes: string;
  maxParticipants: number;
  guestLinkEnabled: boolean;
  waitingRoom: boolean;
  passcode: string;
  recordingEnabled: boolean;
  transcriptionEnabled: boolean;
  transcriptVisibility: Meeting["transcriptVisibility"];
  participantsCanDownload: boolean;
  coHostCanMute: boolean;
  coHostCanRemove: boolean;
  coHostCanRecord: boolean;
  retentionDays: number;
}

export const defaultSettings: MeetingSettings = {
  title: "",
  description: "",
  agenda: [],
  scheduledAt: "",
  durationMinutes: "",
  maxParticipants: 150,
  guestLinkEnabled: true,
  waitingRoom: true,
  passcode: "",
  recordingEnabled: true,
  transcriptionEnabled: true,
  transcriptVisibility: "HOST_AND_PARTICIPANTS",
  participantsCanDownload: false,
  coHostCanMute: true,
  coHostCanRemove: false,
  coHostCanRecord: false,
  retentionDays: 90,
};

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-line pt-8 md:grid-cols-[240px_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 className="font-bold">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

export function SettingsForm({ value, onChange, errors }: { value: MeetingSettings; onChange: (v: MeetingSettings) => void; errors: Record<string, string> }) {
  const set = <K extends keyof MeetingSettings>(k: K, v: MeetingSettings[K]) => onChange({ ...value, [k]: v });
  const [agendaDraft, setAgendaDraft] = useState("");
  const addAgenda = () => {
    const t = agendaDraft.trim();
    if (!t) return;
    set("agenda", [...value.agenda, t]);
    setAgendaDraft("");
  };
  return (
    <div className="flex flex-col gap-8">
      <Section title="Detail rapat" description="Judul dan agenda membantu AI menyusun notulen yang sesuai.">
        <Field label="Judul" htmlFor="title" error={errors.title}>
          <Input id="title" value={value.title} onChange={(e) => set("title", e.target.value)} placeholder="Contoh: Rapat koordinasi persiapan acara" invalid={!!errors.title} />
        </Field>
        <Field label="Deskripsi" htmlFor="desc" hint="Opsional.">
          <Textarea id="desc" value={value.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2">
          <label htmlFor="agenda" className="text-sm font-semibold">
            Agenda
          </label>
          {value.agenda.length > 0 && (
            <ol className="flex flex-col gap-1.5">
              {value.agenda.map((a, i) => (
                <li key={i} className="flex items-center gap-3 rounded-[10px] bg-surface-2 py-1.5 pl-3 pr-1.5 text-sm">
                  <span className="tnum w-5 text-muted">{i + 1}.</span>
                  <span className="flex-1">{a}</span>
                  <button
                    type="button"
                    aria-label={`Hapus agenda ${a}`}
                    onClick={() => set("agenda", value.agenda.filter((_, j) => j !== i))}
                    className="press rounded-lg p-2 text-muted hover:bg-surface hover:text-ink"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex gap-2">
            <Input
              id="agenda"
              value={agendaDraft}
              placeholder="Tambah butir agenda"
              onChange={(e) => setAgendaDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAgenda();
                }
              }}
            />
            <Button type="button" variant="secondary" onClick={addAgenda} disabled={!agendaDraft.trim()} icon={<Plus size={16} aria-hidden />}>
              Tambah
            </Button>
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Waktu mulai" htmlFor="when" hint="Kosongkan untuk rapat instan.">
            <Input id="when" type="datetime-local" value={value.scheduledAt} onChange={(e) => set("scheduledAt", e.target.value)} />
          </Field>
          <Field label="Perkiraan durasi (menit)" htmlFor="dur" hint="Opsional.">
            <Input id="dur" type="number" min={5} max={1440} inputMode="numeric" value={value.durationMinutes} onChange={(e) => set("durationMinutes", e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section title="Akses" description="Siapa yang dapat masuk melalui tautan undangan.">
        <div className="divide-y divide-line">
          <Switch label="Izinkan tamu tanpa akun" description="Tamu masuk dengan tautan dan wajib mengisi nama." checked={value.guestLinkEnabled} onChange={(v) => set("guestLinkEnabled", v)} />
          <Switch label="Ruang tunggu" description="Host menyetujui setiap peserta baru sebelum masuk." checked={value.waitingRoom} onChange={(v) => set("waitingRoom", v)} />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Kode sandi" htmlFor="pass" hint="Opsional, disarankan untuk rapat sensitif." error={errors.passcode}>
            <Input id="pass" type="text" autoComplete="off" value={value.passcode} onChange={(e) => set("passcode", e.target.value)} />
          </Field>
          <Field label="Kapasitas peserta" htmlFor="cap" error={errors.maxParticipants}>
            <Input id="cap" type="number" min={2} max={500} inputMode="numeric" value={value.maxParticipants} onChange={(e) => set("maxParticipants", Number(e.target.value))} />
          </Field>
        </div>
      </Section>

      <Section
        title="Rekaman & transkrip"
        description="Peserta selalu diberi tahu dan diminta persetujuan sebelum rekaman atau transkripsi berjalan."
      >
        <div className="divide-y divide-line">
          <Switch label="Transkripsi langsung" description="Bahasa Indonesia, per peserta, tampil selama rapat." checked={value.transcriptionEnabled} onChange={(v) => set("transcriptionEnabled", v)} />
          <Switch label="Izinkan perekaman" description="Host tetap harus menekan tombol rekam saat rapat." checked={value.recordingEnabled} onChange={(v) => set("recordingEnabled", v)} />
        </div>
        <Field label="Siapa yang dapat melihat transkrip dan hasil" htmlFor="vis">
          <Select id="vis" value={value.transcriptVisibility} onChange={(e) => set("transcriptVisibility", e.target.value as MeetingSettings["transcriptVisibility"])}>
            <option value="HOST_AND_PARTICIPANTS">Host dan peserta terdaftar</option>
            <option value="EVERYONE">Semua, termasuk tamu</option>
            <option value="HOST_ONLY">Hanya host dan co-host</option>
          </Select>
        </Field>
        <div className="divide-y divide-line">
          <Switch label="Peserta boleh mengunduh hasil" description="Transkrip dan notulen. Tamu tidak pernah dapat mengunduh." checked={value.participantsCanDownload} onChange={(v) => set("participantsCanDownload", v)} />
        </div>
        <Field label="Simpan rekaman dan transkrip selama" htmlFor="ret">
          <Select id="ret" value={value.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value))}>
            <option value={30}>30 hari</option>
            <option value={90}>90 hari</option>
            <option value={180}>180 hari</option>
            <option value={365}>1 tahun</option>
          </Select>
        </Field>
      </Section>

      <Section title="Wewenang co-host" description="Co-host diangkat oleh host saat rapat berlangsung.">
        <div className="divide-y divide-line">
          <Switch label="Membisukan peserta" checked={value.coHostCanMute} onChange={(v) => set("coHostCanMute", v)} />
          <Switch label="Mengeluarkan peserta" checked={value.coHostCanRemove} onChange={(v) => set("coHostCanRemove", v)} />
          <Switch label="Memulai dan menghentikan rekaman" checked={value.coHostCanRecord} onChange={(v) => set("coHostCanRecord", v)} />
        </div>
      </Section>
    </div>
  );
}

export function settingsPayload(v: MeetingSettings) {
  return {
    title: v.title.trim(),
    description: v.description.trim() || null,
    agenda: v.agenda,
    scheduledAt: v.scheduledAt ? new Date(v.scheduledAt).toISOString() : null,
    durationMinutes: v.durationMinutes ? Number(v.durationMinutes) : null,
    maxParticipants: v.maxParticipants,
    guestLinkEnabled: v.guestLinkEnabled,
    waitingRoom: v.waitingRoom,
    passcode: v.passcode.trim() || null,
    recordingEnabled: v.recordingEnabled,
    transcriptionEnabled: v.transcriptionEnabled,
    transcriptVisibility: v.transcriptVisibility,
    participantsCanDownload: v.participantsCanDownload,
    coHostCanMute: v.coHostCanMute,
    coHostCanRemove: v.coHostCanRemove,
    coHostCanRecord: v.coHostCanRecord,
    retentionDays: v.retentionDays,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function CreateMeetingPage() {
  const nav = useNavigate();
  const [value, setValue] = useState<MeetingSettings>(defaultSettings);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.title.trim()) return setErrors({ title: "Judul meeting wajib diisi." });
    setBusy(true);
    setErrors({});
    try {
      const res = await api<{ meeting: Meeting; invitation: { url: string } }>("/meetings", { body: settingsPayload(value) });
      rememberInvite(res.meeting.id, res.invitation.url);
      toast.success("Rapat dibuat. Tautan undangan dapat disalin dari halaman ini atau dari panel Peserta.");
      nav(value.scheduledAt ? `/rapat/${res.meeting.id}` : `/m/${res.meeting.id}`);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setErrors(Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message])));
      }
      toast.error(err instanceof ApiError ? err.message : "Rapat gagal dibuat.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-4xl flex-col gap-8" noValidate>
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Atur rapat</h1>
        <p className="mt-1 text-muted">Semua pengaturan dapat diubah lagi sebelum rapat dimulai.</p>
      </div>
      <SettingsForm value={value} onChange={setValue} errors={errors} />
      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-line bg-paper/95 px-4 py-4 backdrop-blur-sm sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
        <Button type="button" variant="ghost" onClick={() => nav(-1)}>
          Batal
        </Button>
        <Button type="submit" loading={busy}>
          {value.scheduledAt ? "Jadwalkan rapat" : "Buat dan masuk"}
        </Button>
      </div>
    </form>
  );
}
