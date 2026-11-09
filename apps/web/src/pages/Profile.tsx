import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { User } from "../lib/types";
import { useTheme, type ThemePref } from "../lib/theme";
import { Avatar, Button, Field, Input, Select } from "../components/ui";

const TIMEZONES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "UTC"];

export function ProfilePage() {
  const { user, setUser } = useAuth();
  const [theme, setTheme] = useTheme();
  const [form, setForm] = useState({
    displayName: user?.displayName ?? "",
    timezone: user?.timezone ?? "Asia/Jakarta",
    locale: user?.locale ?? "id-ID",
  });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!user) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const res = await api<{ user: User }>("/users/me", { method: "PATCH", body: form });
      setUser(res.user);
      toast.success("Profil disimpan.");
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setErrors(Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message])));
      }
      toast.error(err instanceof ApiError ? err.message : "Profil gagal disimpan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div className="flex items-center gap-4">
        <Avatar name={form.displayName || user.displayName} id={user.id} size={64} />
        <div className="min-w-0">
          <h1 className="truncate text-[28px] font-extrabold tracking-[-0.02em]">Profil</h1>
          <p className="truncate text-muted">{user.email}</p>
        </div>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="Nama tampilan" htmlFor="dn" error={errors.displayName} hint="Dipakai sebagai nama pembicara di transkrip rapat berikutnya.">
          <Input id="dn" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Zona waktu" htmlFor="tz" error={errors.timezone}>
            <Select id="tz" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {[...new Set([form.timezone, ...TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Bahasa antarmuka" htmlFor="lang" hint="Bahasa Inggris menyusul.">
            <Select id="lang" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
              <option value="id-ID">Bahasa Indonesia</option>
            </Select>
          </Field>
        </div>
        <div>
          <Button type="submit" loading={busy}>
            Simpan profil
          </Button>
        </div>
      </form>
      <section className="border-t border-line pt-8">
        <h2 className="font-bold">Tampilan</h2>
        <div className="mt-3 max-w-xs">
          <Field label="Tema" htmlFor="theme">
            <Select id="theme" value={theme} onChange={(e) => setTheme(e.target.value as ThemePref)}>
              <option value="system">Ikuti sistem</option>
              <option value="light">Terang</option>
              <option value="dark">Gelap</option>
            </Select>
          </Field>
        </div>
      </section>
    </div>
  );
}
