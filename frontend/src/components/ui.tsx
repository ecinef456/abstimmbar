// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Small UI primitives, following Ausleihbar's calm-surface idiom. */
import { EllipsisVertical, Info, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { useTranslation } from "react-i18next";

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const styles = {
    primary:
      "bg-brand-400 text-slate-900 hover:bg-brand-500 font-semibold",
    secondary:
      "border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900/60 font-medium",
    danger:
      "text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 font-medium",
    ghost: "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800",
  }[variant];
  return (
    <button
      className={`rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-field bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-slate-950 dark:bg-slate-900 dark:text-slate-100 ${props.className ?? ""}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      {children}
    </label>
  );
}

/** Styled native <select>, matching TextInput/Field. Pass <option>s as children. */
export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={
        "w-full rounded-lg border border-field bg-white px-3 py-2 text-sm " +
        "text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-slate-950 " +
        "dark:bg-slate-900 dark:text-slate-100 " +
        className
      }
    >
      {children}
    </select>
  );
}

/** A subtle info icon whose explanation opens as a small popover on click
 * (#51). Closes on outside click and on Escape, like MoreMenu.
 * Dependency-free, no tooltip framework. */
export function InfoHint({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  // Horizontal nudge (px) to keep the popover inside the viewport regardless
  // of whether the trigger sits near the left or right edge (#14): centered
  // under the icon, then shifted so neither edge is clipped.
  const [shift, setShift] = useState(0);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !noteRef.current) {
      setShift(0);
      return;
    }
    const rect = noteRef.current.getBoundingClientRect();
    const margin = 8;
    if (rect.left < margin) setShift(margin - rect.left);
    else if (rect.right > window.innerWidth - margin)
      setShift(window.innerWidth - margin - rect.right);
    else setShift(0);
  }, [open]);
  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("More information")}
        onClick={() => setOpen((value) => !value)}
        className="-m-0.5 inline-flex rounded p-0.5 text-slate-500 transition-colors hover:text-slate-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-600 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <Info aria-hidden className="h-5 w-5" />
      </button>
      {open && (
        <div
          ref={noteRef}
          role="note"
          style={{ transform: `translateX(calc(-50% + ${shift}px))` }}
          className="absolute left-1/2 top-full z-30 mt-2 w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-lg shadow-slate-900/5 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** Inline confirm rendered in place of the triggering row action. */
export function ConfirmInline({
  message,
  onConfirm,
  onCancel,
  confirmLabel,
  confirmVariant = "danger",
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  confirmVariant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className="text-slate-700 dark:text-slate-300">{message}</span>
      <Button variant={confirmVariant} onClick={onConfirm}>
        {confirmLabel ?? t("Delete")}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        {t("Cancel")}
      </Button>
    </span>
  );
}

/** Centered confirmation modal (backdrop + Escape/backdrop-click cancel).
 *  Same props as ConfirmInline; use where an inline confirm would break the
 *  surrounding layout (e.g. room cards, #30). */
export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel,
  confirmVariant = "danger",
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  confirmVariant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const { t } = useTranslation();
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-slate-700 dark:text-slate-200">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel ?? t("Delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A "⋮" button opening a small dropdown of actions. Closes on outside
 * click, on Escape, and after any click inside (menu items act on click). */
export function MoreMenu({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      {/* Accent-colored so the actions behind it are noticed (#22). */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ?? t("More actions")}
        title={label ?? t("More actions")}
        onClick={() => setOpen((value) => !value)}
        className="rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300 dark:hover:bg-brand-900/40"
      >
        <EllipsisVertical aria-hidden className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          onClick={() => setOpen(false)}
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-slate-900/5 dark:border-slate-700 dark:bg-slate-900"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** One row inside a MoreMenu. */
export function MenuItem({
  onClick,
  children,
  danger = false,
}: {
  onClick?: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800 ${
        danger
          ? "text-red-700 dark:text-red-400"
          : "text-slate-700 dark:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 px-6 py-12 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-300">
        <Icon aria-hidden strokeWidth={1.75} className="h-7 w-7" />
      </div>
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{children}</div>
    </div>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** Equal-width segmented control with an animated sliding thumb. Supports
 *  click, keyboard (the segments are real buttons) and pointer-drag: the
 *  thumb follows the finger and snaps to the nearest segment on release. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className = "",
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const n = options.length;
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState<number | null>(null); // thumb px offset while dragging
  // Pointer state. `startX` marks a pressed pointer; `dragging` flips only
  // once it moves past DRAG_THRESHOLD — until then it's a plain press, so we
  // do NOT capture the pointer and let the native click reach the button
  // (capturing eagerly would redirect the click to the track and kill taps).
  const startXRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const DRAG_THRESHOLD = 4; // px of travel before a press becomes a drag

  function seg() {
    const track = trackRef.current!;
    const inner = track.clientWidth - 4; // p-0.5 = 2px each side
    return { left: track.getBoundingClientRect().left, inner, w: inner / n };
  }
  function thumbLeftFrom(clientX: number) {
    const { left, inner, w } = seg();
    return Math.min(inner - w, Math.max(0, clientX - left - 2 - w / 2));
  }
  function indexFrom(left: number) {
    return Math.min(n - 1, Math.max(0, Math.round(left / seg().w)));
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (disabled) return;
    startXRef.current = e.clientX;
    draggingRef.current = false;
    movedRef.current = false;
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (startXRef.current === null) return;
    if (!draggingRef.current) {
      if (Math.abs(e.clientX - startXRef.current) < DRAG_THRESHOLD) return;
      // Real drag begins: now capture the pointer so it keeps tracking even
      // if the finger leaves the control, and suppress the trailing click.
      draggingRef.current = true;
      movedRef.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDragX(thumbLeftFrom(e.clientX));
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const wasDrag = draggingRef.current;
    startXRef.current = null;
    draggingRef.current = false;
    if (!wasDrag) return; // a plain tap: let the button's onClick handle it
    setDragX(null);
    const picked = options[indexFrom(thumbLeftFrom(e.clientX))].value;
    if (picked !== value) onChange(picked);
  }

  const thumbStyle: CSSProperties = {
    width: `calc((100% - 4px) / ${n})`,
    transform:
      dragX !== null ? `translateX(${dragX}px)` : `translateX(${activeIndex * 100}%)`,
    transition: dragX !== null ? "none" : undefined,
  };

  return (
    <div
      ref={trackRef}
      role="group"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        startXRef.current = null;
        draggingRef.current = false;
        setDragX(null);
      }}
      style={{ touchAction: "none" }}
      className={`relative grid grid-flow-col auto-cols-[minmax(0,1fr)] items-center rounded-full border border-slate-200 p-0.5 text-xs dark:border-slate-700 ${disabled ? "opacity-50" : ""} ${className}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 rounded-full bg-brand-100 duration-150 dark:bg-brand-900"
        style={thumbStyle}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => {
            if (movedRef.current) {
              movedRef.current = false; // ignore the click synthesized after a drag
              return;
            }
            if (o.value !== value) onChange(o.value);
          }}
          // Too narrow (phones, #179): the label is cut with an ellipsis
          // instead of breaking mid-word; the full text stays in the title.
          title={typeof o.label === "string" ? o.label : undefined}
          className={`relative z-10 inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full px-1.5 py-1 text-center transition-colors sm:px-2.5 ${o.value === value ? "text-brand-800 dark:text-brand-200" : "text-slate-500 dark:text-slate-400"}`}
        >
          <span className="min-w-0 truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A sliding on/off switch — the unambiguous shape for a boolean whose two
 * states carry equal weight (unlike a checkbox, whose "off" reads as "not
 * yet done"). The thumb position and the brand fill both signal the state,
 * so no "on/off" wording is needed (see #98). Pass an optional leading
 * `icon` to keep a control recognizable (e.g. Shuffle for random order).
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  icon: Icon,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 rounded text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300"
    >
      <span
        aria-hidden
        className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors ${
          checked ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
          }`}
        />
      </span>
      {Icon && <Icon aria-hidden className="h-4 w-4 flex-none" />}
      <span className="text-left">{label}</span>
    </button>
  );
}
