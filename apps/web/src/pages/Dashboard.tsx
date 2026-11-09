import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus, VideoCamera } from "@phosphor-icons/react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Meeting } from "../lib/types";
import { rememberInvite } from "../lib/invite";
import { Button, EmptyState, ErrorState, Field, Input, LoadingBlock } from "../components/ui";
import { MeetingRow } from "../components/MeetingList";

/** Accepts a full invite URL, a /j/<token> path, a bare token, or a meeting code like abc-defg-hij. */
function parseJoinInput(raw: string): { kind: "token"; token: string } | { kind: "code"; code: string } | null {
  const v = raw.trim();
  if (!v) return null;
  const fromUrl = /\/j\/([A-Za-z0-9_-]{20,})/.exec(v);
  if (fromUrl) return { kind: "token", token: fromUrl[1]! };
  if (/^[a-z2-9]{3}-?[a-z2-9]{4}-?[a-z2-9]{3}$/i.test(v)) {
    const c = v.toLowerCase().replace(/-/g, "");
    return { kind: "code", code: `${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}` };
  }
  if (/^[A-Za-z0-9_-]{20,}$/.test(v)) return { kind: "token", token: v };
  return null;
}

function JoinForm() {
  const nav = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseJoinInput(value);
    if (!parsed) return setError("Masukkan tautan undangan atau kode meeting (contoh: abc-defg-hij).");
    setError(null);
    if (parsed.kind === "token") return nav(`/j/${parsed.token}`);
    setBusy(true);
    try {
      const res = await api<{ meetingId: string }>(`/meetings/by-code/${parsed.code}`);
      nav(`/m/${res.meetingId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kode tidak dapat diperiksa.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <Field label="Gabung dengan tautan atau kode" htmlFor="join" error={error}>
        <div className="flex gap-2">
          <Input id="join" placeholder="abc-defg-hij atau tautan undangan" value={value} onChange={(e) => setValue(e.target.value)} invalid={!!error} />
          <Button type="submit" variant="secondary" loading={busy} disabled={!value.trim()}>
            Gabung
          </Button>
        </div>
      </Field>
    </form>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const recent = useQuery({
    queryKey: ["meetings", "recent"],
    queryFn: () => api<{ items: Meeting[] }>("/meetings", { query: { limit: 8 } }),
    refetchInterval: 15_000,
  });
  const instant = useMutation({
    mutationFn: () => api<{ meeting: Meeting; invitation: { url: string } }>("/meetings", { body: { title: `Rapat ${user?.displayName.split(" ")[0] ?? ""}`.trim() } }),
    onSuccess: (res) => {
      rememberInvite(res.meeting.id, res.invitation.url);
      nav(`/m/${res.meeting.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Rapat gagal dibuat."),
  });

  const items = recent.data?.items ?? [];
  const live = items.filter((m) => m.status === "LIVE");
  const upcoming = items.filter((m) => m.status === "SCHEDULED");
  const past = items.filter((m) => m.status === "ENDED" || m.status === "CANCELLED");
  const hour = new Date().getHours();
  const greet = hour < 11 ? "Selamat pagi" : hour < 15 ? "Selamat siang" : hour < 19 ? "Selamat sore" : "Selamat malam";

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-12">
      <section aria-labelledby="start-heading" className="flex flex-col gap-8">
        <div>
          <p className="text-muted">
            {greet}, {user?.displayName.split(" ")[0]}
          </p>
          <h1 id="start-heading" className="mt-1 text-[32px] font-extrabold leading-tight tracking-[-0.025em] sm:text-[40px]">
            Mulai rapat, biarkan Zuum mencatat.
          </h1>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button size="lg" icon={<VideoCamera size={20} weight="fill" aria-hidden />} loading={instant.isPending} onClick={() => instant.mutate()}>
            Mulai rapat sekarang
          </Button>
          <Button size="lg" variant="secondary" icon={<CalendarPlus size={20} aria-hidden />} onClick={() => nav("/rapat/baru")}>
            Atur rapat
          </Button>
        </div>

        <div className="max-w-lg">
          <JoinForm />
        </div>

        {live.length > 0 && (
          <div>
            <h2 className="mb-2 text-sm font-bold text-ink">Sedang berlangsung</h2>
            <ul className="-mx-3 sm:-mx-4">{live.map((m) => <MeetingRow key={m.id} m={m} />)}</ul>
          </div>
        )}
      </section>

      <aside aria-labelledby="recent-heading" className="flex flex-col gap-6 lg:border-l lg:border-line lg:pl-10">
        {upcoming.length > 0 && (
          <div>
            <h2 className="mb-2 text-sm font-bold">Akan datang</h2>
            <ul className="-mx-3">{upcoming.map((m) => <MeetingRow key={m.id} m={m} />)}</ul>
          </div>
        )}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 id="recent-heading" className="text-sm font-bold">
              Rapat terakhir
            </h2>
            {past.length > 0 && (
              <Link to="/riwayat" className="text-sm font-semibold text-teal underline-offset-4 hover:underline">
                Lihat semua
              </Link>
            )}
          </div>
          {recent.isLoading ? (
            <LoadingBlock />
          ) : recent.isError ? (
            <ErrorState error={recent.error} onRetry={() => recent.refetch()} />
          ) : past.length === 0 ? (
            <EmptyState title="Belum ada rapat yang selesai">
              Setelah rapat berakhir, transkrip, ringkasan, dan notulennya muncul di sini.
            </EmptyState>
          ) : (
            <ul className="-mx-3">{past.map((m) => <MeetingRow key={m.id} m={m} />)}</ul>
          )}
        </div>
      </aside>
    </div>
  );
}
