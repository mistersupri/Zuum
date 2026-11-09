import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { CaretDown, Desktop, Moon, SignOut, Sun, UserCircle } from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import { useTheme, type ThemePref } from "../lib/theme";
import { Avatar, cx } from "./ui";

export function Wordmark({ className }: { className?: string }) {
  // [LOGO] Placeholder: product name as text until an official logo is supplied.
  return (
    <span className={cx("text-[22px] font-extrabold tracking-[-0.03em]", className)}>
      Zuum<span className="text-kunyit">.</span>
    </span>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const themes: { id: ThemePref; label: string; icon: ReactNode }[] = [
    { id: "light", label: "Terang", icon: <Sun size={16} /> },
    { id: "dark", label: "Gelap", icon: <Moon size={16} /> },
    { id: "system", label: "Sistem", icon: <Desktop size={16} /> },
  ];
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="press flex h-11 items-center gap-2 rounded-[10px] px-1.5 hover:bg-surface-2 sm:px-2"
      >
        <Avatar name={user.displayName} id={user.id} size={32} />
        <span className="hidden max-w-36 truncate text-sm font-semibold sm:block">{user.displayName}</span>
        <CaretDown size={14} className="text-muted" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="enter-pop absolute right-0 top-full z-40 mt-2 w-64 origin-top-right rounded-[14px] border border-line bg-surface p-1.5 shadow-pop"
        >
          <div className="px-3 py-2">
            <p className="truncate font-semibold">{user.displayName}</p>
            <p className="truncate text-sm text-muted">{user.email}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav("/profil");
            }}
            className="flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-sm font-medium hover:bg-surface-2"
          >
            <UserCircle size={18} aria-hidden /> Profil & pengaturan
          </button>
          <div className="px-3 pb-1 pt-2 text-xs font-semibold text-muted">Tema</div>
          <div className="grid grid-cols-3 gap-1 px-1.5 pb-1.5" role="group" aria-label="Tema">
            {themes.map((t) => (
              <button
                key={t.id}
                role="menuitemradio"
                aria-checked={theme === t.id}
                onClick={() => setTheme(t.id)}
                className={cx(
                  "press flex h-14 flex-col items-center justify-center gap-1 rounded-[10px] text-xs font-semibold",
                  theme === t.id ? "bg-teal-soft text-teal" : "text-muted hover:bg-surface-2",
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-line" />
          <button
            role="menuitem"
            onClick={async () => {
              await logout();
              nav("/masuk");
            }}
            className="flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-sm font-medium text-rec hover:bg-rec-soft"
          >
            <SignOut size={18} aria-hidden /> Keluar
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const nav = [
    { to: "/", label: "Beranda", end: true },
    { to: "/riwayat", label: "Riwayat", end: false },
  ];
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">
        Lewati ke konten
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link to="/" className="rounded-md text-ink" aria-label="Zuum, beranda">
            <Wordmark />
          </Link>
          <nav aria-label="Navigasi utama" className="flex items-center gap-1">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cx(
                    "flex h-11 items-center rounded-[10px] px-2.5 text-sm font-semibold transition-colors sm:px-3",
                    isActive ? "text-ink" : "text-muted hover:text-ink",
                  )
                }
              >
                {({ isActive }) => (
                  <span className="relative">
                    {n.label}
                    {isActive && <span className="absolute -bottom-[13px] left-0 right-0 h-[2px] rounded-full bg-teal" aria-hidden />}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <UserMenu />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
        {children}
      </main>
    </div>
  );
}
