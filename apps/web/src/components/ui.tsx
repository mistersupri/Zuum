import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { WarningCircle, X } from "@phosphor-icons/react";
import { initials, speakerHue } from "../lib/format";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quiet" | "room" | "roomGhost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-teal text-on-teal hover:bg-teal-hover",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-surface-2",
  ghost: "text-ink hover:bg-surface-2",
  quiet: "text-muted hover:text-ink hover:bg-surface-2",
  danger: "bg-rec text-white hover:opacity-90 dark:text-[#1e0d0b]",
  // The meeting room is always dark, independent of the app theme.
  room: "border border-room-line bg-room-3 text-room-ink hover:bg-room-line",
  roomGhost: "text-room-ink hover:bg-room-3",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = "primary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "press inline-flex select-none items-center justify-center gap-2 rounded-[10px] font-semibold whitespace-nowrap",
        "disabled:cursor-not-allowed disabled:opacity-55",
        size === "sm" && "h-9 px-3 text-sm",
        size === "md" && "h-11 px-4 text-[15px]",
        size === "lg" && "h-12 px-5 text-base",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className ?? "size-5")} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-center gap-1 text-sm text-rec" role="alert">
          <WarningCircle weight="fill" aria-hidden className="shrink-0" /> {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const inputShape = "w-full rounded-[10px] border px-3 text-[15px] transition-colors duration-150";
const inputTones = {
  app: "border-line-strong bg-surface text-ink placeholder:text-muted hover:border-muted focus-visible:border-teal",
  room: "border-room-line bg-room text-room-ink placeholder:text-room-muted hover:border-room-muted",
};
type FieldTone = keyof typeof inputTones;
const inputBase = (tone: FieldTone = "app") => cx(inputShape, inputTones[tone]);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; tone?: FieldTone }>(function Input(
  { className, invalid, tone, ...rest },
  ref,
) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cx(inputBase(tone), "h-11", invalid && "border-rec", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { tone?: FieldTone }>(function Textarea(
  { className, tone, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(inputBase(tone), "min-h-24 py-2.5 leading-relaxed", className)} {...rest} />;
});

export function Select({ className, tone, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { tone?: FieldTone }) {
  return <select className={cx(inputBase(tone), "h-11 pr-8", className)} {...rest} />;
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="font-semibold text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-50",
          checked ? "border-teal bg-teal" : "border-line-strong bg-surface-2",
        )}
      >
        <span
          className={cx(
            "inline-block size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[var(--ease-out-strong)]",
            checked ? "translate-x-6" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}

export type Tone = "neutral" | "teal" | "kunyit" | "rec" | "ok";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  teal: "bg-teal-soft text-teal",
  kunyit: "bg-kunyit-soft text-ink",
  rec: "bg-rec-soft text-rec",
  ok: "bg-teal-soft text-ok",
};
/** Status pill. Only for real states (LIVE, REC, job status), never decoration. */
export function Badge({ tone = "neutral", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold", TONES[tone])}>
      {dot && <span className={cx("size-1.5 rounded-full bg-current", tone === "rec" && "rec-dot")} aria-hidden />}
      {children}
    </span>
  );
}

export function Avatar({ name, id, size = 36, speaking, className }: { name: string; id?: string | null; size?: number; speaking?: boolean; className?: string }) {
  const hue = speakerHue(id ?? name);
  return (
    <span
      aria-hidden
      className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-bold", speaking && "speaking-ring", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, size * 0.38),
        background: `oklch(0.86 0.05 ${hue})`,
        color: `oklch(0.3 0.06 ${hue})`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[14px] border border-dashed border-line-strong px-5 py-8">
      <p className="font-semibold text-ink">{title}</p>
      {children && <div className="max-w-prose text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Terjadi kesalahan.";
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-[14px] border border-rec/40 bg-rec-soft px-5 py-5">
      <p className="flex items-center gap-2 font-semibold text-rec">
        <WarningCircle weight="fill" aria-hidden /> Gagal memuat
      </p>
      <p className="text-sm text-ink">{msg}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Coba lagi
        </Button>
      )}
    </div>
  );
}

export function LoadingBlock({ label = "Memuat..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-muted" role="status" aria-live="polite">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

/** Modal dialog: focus moves in, Tab is trapped, Escape closes, focus returns to the trigger. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  tone = "app",
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  tone?: "app" | "room";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute("disabled"),
      );
    (focusables()[1] ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const els = focusables();
        if (!els.length) return;
        const first = els[0]!;
        const last = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="enter-fade absolute inset-0 bg-black/45" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ maxWidth: width }}
        className={cx(
          "enter-pop relative max-h-[92dvh] w-full overflow-auto rounded-t-[16px] p-5 shadow-pop sm:rounded-[16px] sm:p-6",
          tone === "room" ? "room border border-room-line bg-room-2 text-room-ink" : "bg-surface text-ink",
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Tutup"
            className={cx("press -m-2 rounded-lg p-2", tone === "room" ? "text-room-muted hover:bg-room-3" : "text-muted hover:bg-surface-2")}
          >
            <X size={18} />
          </button>
        </div>
        <div className={tone === "room" ? "text-room-ink" : "text-ink"}>{children}</div>
        {footer && <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Accessible tabs: arrow keys move between tabs, roving tabindex. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
  tone = "app",
}: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
  tone?: "app" | "room";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label} className={cx("flex gap-1 overflow-x-auto scrollbar-thin", className)}>
      {tabs.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={active}
            aria-controls={`panel-${t.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!dir) return;
              e.preventDefault();
              const next = (i + dir + tabs.length) % tabs.length;
              onChange(tabs[next]!.id);
              refs.current[next]?.focus();
            }}
            className={cx(
              "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-sm font-semibold transition-colors duration-150",
              tone === "room"
                ? active
                  ? "bg-room-3 text-room-ink"
                  : "text-room-muted hover:text-room-ink"
                : active
                  ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]"
                  : "text-muted hover:text-ink",
            )}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className={cx("tnum rounded-full px-1.5 text-xs", tone === "room" ? "bg-kunyit text-on-kunyit" : "bg-surface-2 text-muted")}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
