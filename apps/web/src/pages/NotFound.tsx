import { Link } from "react-router-dom";
import { Wordmark } from "../components/AppShell";

export function NotFoundPage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <Wordmark />
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Halaman tidak ditemukan</h1>
      <p className="text-muted">Tautan ini mungkin salah ketik, sudah dicabut, atau rapatnya telah dihapus.</p>
      <Link to="/" className="font-semibold text-teal underline-offset-4 hover:underline">
        Kembali ke beranda
      </Link>
    </div>
  );
}
