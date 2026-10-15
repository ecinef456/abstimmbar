// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Presenter footer (icon bar): only what fits the current state, one view
 *  switcher for everything the beamer can show for the question, keys in the
 *  tooltips. Every control carries `data-help="<id>"`; `PRESENTER_HELP` has
 *  its name, a short sentence and its key (the "?" help overlay renders them). */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  BrushCleaning,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Cloud,
  Gauge,
  Grid2x2,
  LayoutGrid,
  List,
  ListOrdered,
  MessageSquare,
  Network,
  Play,
  QrCode,
  Quote,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";

/** One label card of the "?" help: English i18n keys (translate with `t`). */
export interface HelpEntry {
  name: string;
  text: string;
  keys?: string;
}

/** Name, sentence and key of every footer control and right-edge handle, by
 *  its `data-help` id. View segments: `view.<kind>.<view>`. */
export const PRESENTER_HELP: Record<string, HelpEntry> = {
  position: { name: "Position", text: "Which question is on screen — click to jump to another one." },
  qr: { name: "QR code", text: "Shows the QR code and join link.", keys: "Q" },
  "view.question": { name: "Question", text: "Shows the question without results." },
  "view.results": { name: "Results", text: "Shows the results.", keys: "E" },
  "view.solution": { name: "Solution", text: "Marks the correct answers.", keys: "L" },
  "view.wc.raw": { name: "Original", text: "The word cloud as submitted." },
  "view.wc.consolidated": {
    name: "Cleaned up (AI)",
    text: "Variants and synonyms merged by AI.",
  },
  "view.wc.grouped": { name: "Grouped (AI)", text: "Terms sorted into themes by AI." },
  "view.ft.raw": { name: "Answers", text: "The submitted answers." },
  "view.ft.results": { name: "Evaluation", text: "How the AI rated the answers." },
  "view.ft.consolidated": {
    name: "Key statements",
    text: "The main points, summarised by AI.",
  },
  "view.ft.grouped": { name: "Grouped", text: "Answers sorted into themes by AI." },
  "view.mm.raw": { name: "Mind map", text: "The collected terms as a map." },
  "view.mm.ranking": { name: "Ranking", text: "The rated terms, best first." },
  "view.mx.raw": { name: "Matrix", text: "The cards on the four-field board." },
  "mm.rate": { name: "Start rating", text: "Participants rate the collected terms." },
  "mm.collect": {
    name: "Back to collecting",
    text: "Participants add terms again; the ratings are kept.",
  },
  toggle: { name: "Start / Stop", text: "Opens or closes voting on this question.", keys: "S" },
  end: {
    name: "Leave presentation",
    text: "The survey stays open; end it in the set overview.",
    keys: "Esc",
  },
  prev: { name: "Previous question", text: "Goes back one question.", keys: "←" },
  next: { name: "Next question", text: "Moves on to the next question.", keys: "→" },
  help: { name: "Help", text: "Labels every control.", keys: "? / H" },
  "handle.moderate": { name: "Moderate", text: "Hide, merge or restore entries." },
  "handle.ai": { name: "AI settings", text: "AI on/off and how it merges or groups." },
  "handle.mm-ai": { name: "AI mind map", text: "Let AI tidy up the mind map." },
  "handle.zoom": { name: "Zoom", text: "Zoom, fit, compact or detailed.", keys: "+ − 0" },
  "handle.mx-edit": {
    name: "Add card",
    text: "Add your own card; show hidden cards again.",
  },
  "handle.mx-zoom": {
    name: "Display",
    text: "Compact or detailed; zoom the whole board (wheel, drag to pan, Shift+arrows) or fit it.",
    keys: "+ − 0",
  },
  "mx.focus": {
    name: "Zoom into a field",
    text: "Fills the screen with this field; , and . (or [ and ]) step through the fields, Esc returns to the overview.",
    keys: ", / .",
  },
  "mx.prev-field": { name: "Previous field", text: "Shows the field before this one (reading order).", keys: ", / [" },
  "mx.next-field": { name: "Next field", text: "Shows the next field (reading order).", keys: ". / ]" },
  "mx.overview": { name: "Overview", text: "Back to the whole board.", keys: "Esc / 0" },
  "mx.legend": { name: "Categories", text: "Click a category to hide or show its cards." },
};

/** What a view segment shows: the question, a results view or the solution. */
export type ViewLevel = "question" | "results" | "solution";

export interface ViewSegment<V extends string = string> {
  /** Also the `data-help` id (see PRESENTER_HELP). */
  id: string;
  level: ViewLevel;
  /** The word cloud / free text / mind map view this segment selects. */
  view?: V;
  icon: LucideIcon;
}

const RESULT_ICONS: Record<string, Record<string, LucideIcon>> = {
  wc: { raw: Cloud, consolidated: BrushCleaning, grouped: LayoutGrid },
  ft: { raw: List, results: Gauge, consolidated: Quote, grouped: LayoutGrid },
  mm: { raw: Network, ranking: ListOrdered },
  mx: { raw: Grid2x2 },
};

/** The ordered view list of a question: Question · results view(s) ·
 *  Solution. `views` are the available result views of a word cloud
 *  (`wc`), free text (`ft`) or mind map (`mm`), in display order; other
 *  kinds pass `group: null` and get one "Results" segment. */
export function buildViewSegments<V extends string>(opts: {
  group: "wc" | "ft" | "mm" | "mx" | null;
  views: V[];
  solution: boolean;
}): ViewSegment<V>[] {
  const segs: ViewSegment<V>[] = [
    { id: "view.question", level: "question", icon: MessageSquare },
  ];
  if (opts.group) {
    const icons = RESULT_ICONS[opts.group];
    for (const v of opts.views) {
      segs.push({ id: `view.${opts.group}.${v}`, level: "results", view: v, icon: icons[v] ?? BarChart3 });
    }
  } else {
    segs.push({ id: "view.results", level: "results", icon: BarChart3 });
  }
  if (opts.solution) segs.push({ id: "view.solution", level: "solution", icon: ClipboardCheck });
  return segs;
}

/** The direct key of a segment: E on the first results view, L on the
 *  solution; "" on the rest (A cycles the whole list, it jumps nowhere). */
export function segmentKey(segs: ViewSegment[], seg: ViewSegment): string {
  if (seg.level === "solution") return "L";
  if (seg.level === "results" && segs.find((s) => s.level === "results") === seg) return "E";
  return "";
}

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
const ICON_BTN = `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border disabled:opacity-50 ${FOCUS}`;
/** Default look; a `className` with its own colours replaces it. */
const ICON_BTN_PLAIN = "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-800";

/** Mouse clicks drop the focus (a clicker's Enter/Space must advance the
 *  presentation, not re-press the button); keyboard activation keeps it. */
function blurOnMouse(e: MouseEvent<HTMLButtonElement>) {
  if (e.detail > 0) e.currentTarget.blur();
}

/** Icon button: `aria-label` = name, `title` = name (key). */
export function FooterIconButton({
  help,
  label,
  keys,
  icon: Icon,
  onClick,
  className = "",
  disabled,
  pressed,
  testId,
  tour,
  detail,
  nextStep,
}: {
  help: string;
  /** `data-tour` anchor of a tour step. */
  tour?: string;
  label: string;
  keys?: string;
  icon: LucideIcon;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
  testId?: string;
  /** Extra tooltip sentence after the name. */
  detail?: string;
  /** The suggested next step (green); marked for tests/help. */
  nextStep?: boolean;
}) {
  const title = keys ? `${label} (${keys})` : label;
  return (
    <button
      type="button"
      data-help={help}
      data-tour={tour}
      data-testid={testId}
      data-next-step={nextStep || undefined}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={keys && keys.length === 1 ? keys : undefined}
      title={detail ? `${title} — ${detail}` : title}
      disabled={disabled}
      onClick={(e) => {
        blurOnMouse(e);
        onClick();
      }}
      className={`${ICON_BTN} ${className || ICON_BTN_PLAIN}`}
    >
      <Icon aria-hidden className="h-[18px] w-[18px]" />
    </button>
  );
}

/** Segmented view switcher (icons only; name + key in the tooltip). */
export function ViewSwitcher({
  segments,
  active,
  disabled,
  disabledReason,
  onSelect,
}: {
  segments: ViewSegment[];
  active: string;
  /** Segment ids that can't be chosen right now (e.g. "Question" while a
   *  live cloud is on screen). */
  disabled?: Set<string>;
  /** Tooltip sentence on a disabled segment (why it can't be chosen). */
  disabledReason?: string;
  onSelect: (seg: ViewSegment) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-tour="present.reveal"
      role="radiogroup"
      aria-label={t("View")}
      className="flex items-center gap-0.5 rounded-full border border-slate-200 p-0.5"
    >
      {segments.map((seg) => {
        const on = seg.id === active;
        const off = disabled?.has(seg.id) ?? false;
        const label = t(PRESENTER_HELP[seg.id]?.name ?? seg.id);
        const key = segmentKey(segments, seg);
        const Icon = seg.icon;
        return (
          <button
            key={seg.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            aria-disabled={off || undefined}
            title={off && disabledReason ? `${label} — ${disabledReason}` : key ? `${label} (${key})` : label}
            data-help={seg.id}
            data-testid={`view-${seg.id}`}
            onClick={(e) => {
              blurOnMouse(e);
              if (!off) onSelect(seg);
            }}
            className={`flex h-8 w-9 items-center justify-center rounded-full transition-colors ${FOCUS} ${
              on
                ? "bg-brand-100 text-brand-800"
                : off
                  ? "cursor-default text-slate-300"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            }`}
          >
            <Icon aria-hidden className="h-[18px] w-[18px]" />
          </button>
        );
      })}
    </div>
  );
}

export function Footer(props: {
  phase: string;
  index: number;
  count: number;
  variant?: "question" | "section";
  onPrev: () => void;
  onNext: () => void;
  onToggle?: () => void;
  /** The question's view list (from "preview" on) and the active segment. */
  views?: ViewSegment[];
  activeView?: string;
  disabledViews?: Set<string>;
  disabledViewReason?: string;
  onSelectView?: (seg: ViewSegment) => void;
  /** ✕ / Esc: leave the presentation without ending the survey. */
  onLeave: () => void;
  joinShown?: boolean;
  onToggleJoin?: () => void;
  /** "?" help (labels every control); hidden until wired. */
  onHelp?: () => void;
  helpShown?: boolean;
  /** Question-specific action icons left of Start/Stop (mind-map rating). */
  extra?: ReactNode;
  /** Plain-text titles of all questions: makes "3/12" a jump menu. */
  questionTitles?: string[];
  onJump?: (index: number) => void;
}) {
  const { t } = useTranslation();
  const isSection = props.variant === "section";
  const name = (id: string) => t(PRESENTER_HELP[id].name);
  const position = isSection
    ? t("Section")
    : props.index >= 0
      ? `${props.index + 1}/${props.count}`
      : t("Start");
  const positionLabel =
    !isSection && props.index >= 0
      ? t("Question {{current}}/{{total}}", { current: props.index + 1, total: props.count })
      : position;
  const startLabel = props.phase === "open" ? t("Stop") : t("Start", { context: "action" });
  // Colour guidance: the one next step is green — Start before voting, Stop
  // while it runs; once a question is closed/shown, "→" (next question).
  const done = props.phase === "closed" || props.phase === "results";
  const nextIsNext = isSection || done || !props.onToggle;
  const GREEN = "border-brand-400 bg-brand-400 text-slate-900 hover:bg-brand-500";
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-3 text-sm text-slate-500">
      <div className="flex min-w-0 items-center gap-3">
        {props.questionTitles && props.onJump && props.questionTitles.length > 1 ? (
          <JumpMenu
            label={positionLabel}
            position={position}
            titles={props.questionTitles}
            current={props.index}
            onJump={props.onJump}
          />
        ) : (
          <span data-help="position" title={positionLabel} aria-label={positionLabel} className="tabular-nums">
            {position}
          </span>
        )}
        {!isSection && props.onToggleJoin && (
          <FooterIconButton
            help="qr"
            label={name("qr")}
            keys="Q"
            icon={QrCode}
            pressed={props.joinShown}
            onClick={props.onToggleJoin}
            className={props.joinShown ? "border-brand-300 bg-brand-100 text-brand-800" : ""}
          />
        )}
        {!isSection && props.phase !== "lobby" && props.views && props.onSelectView && (
          <ViewSwitcher
            segments={props.views}
            active={props.activeView ?? "view.question"}
            disabled={props.disabledViews}
            disabledReason={props.disabledViewReason}
            onSelect={props.onSelectView}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!isSection && props.extra}
        {!isSection && props.onToggle && (
          <button
            type="button"
            data-tour="present.toggle"
            data-help="toggle"
            data-next-step={!nextIsNext || undefined}
            aria-keyshortcuts="S"
            title={`${startLabel} (S)`}
            onClick={(e) => {
              blurOnMouse(e);
              props.onToggle!();
            }}
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 font-semibold ${
              nextIsNext
                ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                : "border-brand-400 bg-brand-400 text-slate-900 hover:bg-brand-500"
            } ${FOCUS}`}
          >
            {props.phase === "open" ? (
              <Square aria-hidden className="h-4 w-4" fill="currentColor" />
            ) : (
              <Play aria-hidden className="h-4 w-4" fill="currentColor" />
            )}
            {startLabel}
          </button>
        )}
        <div data-tour="present.nav" className="flex items-center gap-2">
          <FooterIconButton help="prev" label={name("prev")} keys="←" icon={ChevronLeft} onClick={props.onPrev} />
          <FooterIconButton
            help="next"
            label={name("next")}
            keys="→"
            icon={ChevronRight}
            onClick={props.onNext}
            className={nextIsNext ? GREEN : undefined}
            nextStep={nextIsNext}
          />
        </div>
        {props.onHelp && (
          <FooterIconButton
            help="help"
            tour="present.help"
            label={name("help")}
            keys="?"
            icon={CircleHelp}
            onClick={props.onHelp}
            pressed={props.helpShown}
          />
        )}
        {/* Leave sits last, set apart in red (the survey itself stays open). */}
        <FooterIconButton
          help="end"
          label={name("end")}
          keys="Esc"
          detail={t(PRESENTER_HELP.end.text)}
          icon={X}
          onClick={props.onLeave}
          className="ml-2 border-red-600 bg-red-600 text-white hover:bg-red-700"
        />
      </div>
    </footer>
  );
}

/** "3/12" as a button: a list of all questions above the footer to jump to
 *  one directly. Keys inside the menu never reach the presenter shortcuts
 *  (Esc closes the menu, ↑/↓ move, Enter picks). */
function JumpMenu({
  label,
  position,
  titles,
  current,
  onJump,
}: {
  label: string;
  position: string;
  titles: string[];
  current: number;
  onJump: (index: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[Math.max(0, current)]?.focus();
    itemRefs.current[Math.max(0, current)]?.scrollIntoView({ block: "nearest" });
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, current]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The presenter listens on window: keep every key in here.
    e.stopPropagation();
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
      items[next]?.focus();
    }
  };

  return (
    <div ref={ref} className="relative" onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={buttonRef}
        type="button"
        data-help="position"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} — ${t("Jump to a question")}`}
        title={`${label} — ${t("Jump to a question")}`}
        onClick={(e) => {
          blurOnMouse(e);
          setOpen((v) => !v);
        }}
        className={`inline-flex h-9 items-center rounded-lg px-2 tabular-nums hover:bg-slate-100 hover:text-slate-800 ${open ? "bg-slate-100 text-slate-800" : ""} ${FOCUS}`}
      >
        {position}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("Jump to a question")}
          className="absolute bottom-full left-0 z-40 mb-2 max-h-[60vh] w-[min(28rem,calc(100vw-3rem))] overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {titles.map((title, i) => (
            <button
              key={i}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              aria-current={i === current ? "true" : undefined}
              onClick={() => {
                setOpen(false);
                if (i !== current) onJump(i);
              }}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 focus:bg-slate-100 focus:outline-none ${i === current ? "font-semibold text-brand-800" : "text-slate-700"}`}
            >
              <span className="w-6 shrink-0 text-right tabular-nums text-slate-500">{i + 1}</span>
              <span className="min-w-0 truncate">{title || t("Question {{n}}", { n: i + 1 })}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
