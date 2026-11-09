import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle } from "@phosphor-icons/react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Wordmark } from "../components/AppShell";
import { Button, Field, Input, LoadingBlock } from "../components/ui";

function AuthLayout({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* Left panel states what the product does, in plain words. No fabricated proof. */}
      <aside className="hidden flex-col justify-between bg-teal p-12 text-on-teal lg:flex">
        <Wordmark className="text-on-teal" />
        <div className="max-w-md">
          <p className="font-serif text-[34px] leading-[1.15] tracking-[-0.01em]">
            Rapat selesai, notulennya sudah tertulis.
          </p>
          <ul className="mt-8 space-y-3 text-[15px] leading-relaxed opacity-90">
            <li>Video meeting langsung dari browser, tamu cukup membuka tautan.</li>
            <li>Transkrip Bahasa Indonesia muncul saat rapat berjalan, lengkap dengan nama pembicara.</li>
            <li>Ringkasan, keputusan, dan tindak lanjut disusun dari transkrip, dengan rujukan ke kalimat aslinya.</li>
          </ul>
        </div>
        <p className="text-sm opacity-75">Rekaman dan transkrip hanya berjalan setelah peserta menyetujuinya.</p>
      </aside>
      <div className="flex flex-col px-4 py-8 sm:px-10">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">{title}</h1>
          {intro && <div className="mt-2 text-muted">{intro}</div>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-muted">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

function errorText(err: unknown) {
  return err instanceof ApiError ? err.message : "Terjadi kesalahan. Silakan coba lagi.";
}

function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  return Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
}

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-[10px] bg-rec-soft px-3 py-2.5 text-sm font-medium text-rec">
      {errorText(error)}
    </p>
  );
}

export function LoginPage() {
  const { login, status } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const next = params.get("lanjut") || "/";

  if (status === "authenticated") return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      nav(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Masuk ke Zuum"
      intro="Kelola rapat, transkrip, dan notulen tim Anda."
      footer={
        <>
          Belum punya akun?{" "}
          <Link to={`/daftar${params.get("lanjut") ? `?lanjut=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-teal underline-offset-4 hover:underline">
            Daftar gratis
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={error} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Kata sandi" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="-mt-1 text-right">
          <Link to="/lupa-sandi" className="text-sm font-semibold text-teal underline-offset-4 hover:underline">
            Lupa kata sandi?
          </Link>
        </div>
        <Button type="submit" size="lg" loading={busy} disabled={!email || !password}>
          Masuk
        </Button>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register, status } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [verify, setVerify] = useState(false);
  const next = params.get("lanjut") || "/";
  if (status === "authenticated" && !verify) return <Navigate to={next} replace />;

  const errs = fieldErrors(error);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await register(form);
      if (res.verificationRequired) setVerify(true);
      else nav(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (verify) {
    return (
      <AuthLayout title="Periksa email Anda" intro={`Kami mengirim tautan verifikasi ke ${form.email}.`}>
        <Link to="/masuk" className="font-semibold text-teal">
          Kembali ke halaman masuk
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Buat akun"
      intro="Akun dibutuhkan untuk membuat rapat. Tamu bisa bergabung tanpa akun."
      footer={
        <>
          Sudah punya akun?{" "}
          <Link to="/masuk" className="font-semibold text-teal underline-offset-4 hover:underline">
            Masuk
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {!Object.keys(errs).length && <FormError error={error} />}
        <Field label="Nama tampilan" htmlFor="name" error={errs.displayName} hint="Nama ini muncul di rapat dan transkrip.">
          <Input id="name" autoComplete="name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} invalid={!!errs.displayName} />
        </Field>
        <Field label="Email" htmlFor="email" error={errs.email}>
          <Input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} invalid={!!errs.email} />
        </Field>
        <Field label="Kata sandi" htmlFor="password" error={errs.password} hint="Minimal 10 karakter.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            invalid={!!errs.password}
          />
        </Field>
        <Button type="submit" size="lg" loading={busy}>
          Buat akun
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/forgot-password", { body: { email } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      title="Atur ulang kata sandi"
      intro="Masukkan email akun Anda. Bila terdaftar, kami kirimkan tautan atur ulang yang berlaku 30 menit."
      footer={
        <Link to="/masuk" className="font-semibold text-teal underline-offset-4 hover:underline">
          Kembali ke halaman masuk
        </Link>
      }
    >
      {sent ? (
        <p role="status" className="flex items-start gap-2 rounded-[10px] bg-teal-soft px-3 py-3 text-sm text-ink">
          <CheckCircle weight="fill" className="mt-0.5 shrink-0 text-teal" aria-hidden />
          Jika {email} terdaftar, tautan atur ulang sudah dikirim. Periksa juga folder spam.
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FormError error={error} />
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" loading={busy} disabled={!email}>
            Kirim tautan
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errs = fieldErrors(error);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/reset-password", { body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Kata sandi baru">
      {done ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="rounded-[10px] bg-teal-soft px-3 py-3 text-sm">
            Kata sandi berhasil diubah. Semua sesi lama telah dikeluarkan.
          </p>
          <Link to="/masuk" className="font-semibold text-teal">
            Masuk dengan kata sandi baru
          </Link>
        </div>
      ) : !token ? (
        <p className="text-muted">Tautan tidak lengkap. Minta tautan baru dari halaman lupa kata sandi.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {!errs.password && <FormError error={error} />}
          <Field label="Kata sandi baru" htmlFor="password" error={errs.password} hint="Minimal 10 karakter.">
            <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" loading={busy}>
            Simpan kata sandi
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api("/auth/verify-email", { body: { token: params.get("token") ?? "" } })
      .then(() => setState("ok"))
      .catch((err) => {
        setError(err);
        setState("error");
      });
  }, [params]);
  return (
    <AuthLayout title="Verifikasi email">
      {state === "loading" && <LoadingBlock label="Memverifikasi..." />}
      {state === "ok" && (
        <p className="text-ink">
          Email terverifikasi.{" "}
          <Link to="/masuk" className="font-semibold text-teal">
            Masuk sekarang
          </Link>
        </p>
      )}
      {state === "error" && <FormError error={error} />}
    </AuthLayout>
  );
}
