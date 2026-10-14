// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Settings panel of the four-field matrix question (axes around a drawn
 *  coordinate cross, edges, description, cards per person, categories). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { getDefaultContentLang, localizedMap, type LocalizedText } from "@basicbar/ui";
import type { MatrixCategory, MatrixCategoryMode } from "../api";
import { MATRIX_PALETTE, type MatrixColor } from "../matrixPalette";
import TranslatableField from "./TranslatableField";
import { SegmentedControl, ToggleSwitch } from "./ui";

export interface MatrixSettingsValue {
  xFrom: LocalizedText;
  xTo: LocalizedText;
  yFrom: LocalizedText;
  yTo: LocalizedText;
  edges: boolean;
  descriptions: boolean;
  maxPerPerson: number;
  categoryMode: MatrixCategoryMode;
  categories: MatrixCategory[];
}

export type MatrixUpdateFn = (prev: MatrixSettingsValue) => Partial<MatrixSettingsValue>;
export type MatrixUpdate = (prev: MatrixSettingsValue) => MatrixSettingsValue;

export const MATRIX_MAX_CATEGORIES = MATRIX_PALETTE.length;
const MATRIX_MIN_CATEGORIES = 2;
const AXIS_LABEL_MAX = 40;
const NAME_MAX = 40;

// English source strings of the colour names (translated in de/translation.json).
const COLOR_NAME: Record<MatrixColor, string> = {
  blue: "blue",
  orange: "orange",
  green: "green",
  red: "red",
  purple: "purple",
  sky: "sky blue",
};

const emptyName: LocalizedText = { de: "", en: "" };

/** Cut every language of a field to the backend's length limit. */
function clamp(text: LocalizedText, max: number): LocalizedText {
  const map = localizedMap(text);
  return Object.fromEntries(
    Object.entries(map).map(([lang, v]) => [lang, (v ?? "").slice(0, max)]),
  ) as LocalizedText;
}

/** Why the settings cannot be saved yet (English message key), or null.
 *  Mirrors backend QuestionSerializer.validate / rooms.matrix.clean_categories. */
export function matrixProblem(
  v: MatrixSettingsValue,
): { key: string; values?: Record<string, unknown> } | null {
  const lang = getDefaultContentLang() as "de" | "en";
  const canonical = (text: LocalizedText) => (localizedMap(text)[lang] ?? "").trim();
  if (![v.xFrom, v.xTo, v.yFrom, v.yTo].every((label) => canonical(label) !== "")) {
    return { key: "Please label both ends of both axes." };
  }
  if (v.categoryMode !== "off") {
    if (v.categories.length < MATRIX_MIN_CATEGORIES) return { key: "Add at least two categories." };
    if (v.categoryMode === "named" && v.categories.some((c) => canonical(c.name) === "")) {
      return { key: "Every category needs a name." };
    }
  }
  return null;
}

/** Radio row of the palette colours for one category. Colours taken by another
 *  category are disabled; the number is always shown (colour is never the only
 *  cue). Arrow keys move the selection to the next free colour. */
function ColorPicker({
  value,
  taken,
  label,
  onPick,
}: {
  value: string;
  taken: Set<string>;
  label: string;
  onPick: (key: MatrixColor) => void;
}) {
  const { t } = useTranslation();
  const free = MATRIX_PALETTE.filter((entry) => entry.key === value || !taken.has(entry.key));
  function onKeyDown(event: React.KeyboardEvent) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const at = free.findIndex((entry) => entry.key === value);
    const next = free[(at + step + free.length) % free.length];
    onPick(next.key);
    // Move focus with the selection (roving tabindex).
    const group = event.currentTarget as HTMLElement;
    requestAnimationFrame(() =>
      group.querySelector<HTMLElement>(`[data-color="${next.key}"]`)?.focus(),
    );
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="flex flex-wrap gap-1.5">
      {MATRIX_PALETTE.map((entry) => {
        const selected = entry.key === value;
        const unavailable = !selected && taken.has(entry.key);
        return (
          <button
            key={entry.key}
            type="button"
            role="radio"
            data-color={entry.key}
            aria-checked={selected}
            disabled={unavailable}
            tabIndex={selected ? 0 : -1}
            aria-label={t("Color {{n}} ({{name}})", { n: entry.number, name: t(COLOR_NAME[entry.key]) })}
            title={unavailable ? t("Already used by another category") : undefined}
            onClick={() => onPick(entry.key)}
            className={`inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-full border px-1.5 text-xs font-semibold tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 ${
              selected
                ? "border-slate-900 ring-2 ring-slate-900 dark:border-white dark:ring-white"
                : "border-slate-300 dark:border-slate-600"
            } ${unavailable ? "cursor-not-allowed opacity-35" : "hover:bg-slate-100 dark:hover:bg-slate-800"} text-slate-700 dark:text-slate-300`}
          >
            <span
              aria-hidden
              className="inline-block h-4 w-4 flex-none rounded-full border border-slate-900/20 dark:border-white/30"
              style={{ backgroundColor: entry.hex }}
            />
            <span aria-hidden>{entry.number}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Drawn coordinate cross with arrowheads at the four axis ends. Purely
 *  decorative: it shows where each label input ends up on the participant page. */
function AxesGraph() {
  return (
    <svg
      aria-hidden
      data-testid="matrix-axes-graph"
      viewBox="0 0 120 120"
      className="hidden h-36 w-36 flex-none text-slate-500 md:block dark:text-slate-400"
    >
      <rect
        x="12" y="12" width="96" height="96" rx="4"
        fill="none" stroke="currentColor" strokeOpacity="0.35" strokeDasharray="3 3"
      />
      <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <line x1="6" y1="60" x2="114" y2="60" />
        <line x1="60" y1="6" x2="60" y2="114" />
        <polyline points="12,54 6,60 12,66" />
        <polyline points="108,54 114,60 108,66" />
        <polyline points="54,12 60,6 66,12" />
        <polyline points="54,108 60,114 66,108" />
      </g>
    </svg>
  );
}

export default function MatrixSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: MatrixSettingsValue;
  /** Receives an updater, not a value: several fields can change in the same
   *  tick ("translate all fields"), and each update must see the result of the
   *  previous one instead of the render-time `value`. */
  onChange: (update: MatrixUpdate) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const patch = (changes: Partial<MatrixSettingsValue> | MatrixUpdateFn) =>
    onChange((prev) => ({
      ...prev,
      ...(typeof changes === "function" ? changes(prev) : changes),
    }));

  function setMode(mode: MatrixCategoryMode) {
    if (mode !== "off" && value.categories.length === 0) {
      patch({
        categoryMode: mode,
        categories: MATRIX_PALETTE.slice(0, 2).map((entry) => ({ key: entry.key, name: emptyName })),
      });
    } else {
      patch({ categoryMode: mode });
    }
  }

  function addCategory() {
    const used = new Set(value.categories.map((c) => c.key));
    const next = MATRIX_PALETTE.find((entry) => !used.has(entry.key));
    if (!next) return;
    patch({ categories: [...value.categories, { key: next.key, name: emptyName }] });
  }

  const axis = (
    id: "xFrom" | "xTo" | "yFrom" | "yTo",
    label: string,
    hint: string,
    place: string,
  ) => (
    <div className={`grid min-w-0 gap-1 ${place}`}>
      <span className="text-xs font-medium text-slate-500 md:hidden dark:text-slate-400">{hint}</span>
      <TranslatableField
        label={label}
        value={value[id]}
        onChange={(next) => patch({ [id]: clamp(next, AXIS_LABEL_MAX) })}
        inputClassName="max-w-xs"
      />
    </div>
  );

  const problem = matrixProblem(value);

  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-5 border-0 p-0" data-testid="matrix-settings">
      <p className="rounded-xl bg-brand-50 dark:bg-brand-950 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
        <strong>{t("Four-field matrix:")}</strong>{" "}
        {t(
          "Participants place cards in one of four fields between two axes. There are no answer options here.",
        )}
      </p>

      <div className="grid gap-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t("Axes")}</h3>
        {/* md+: label inputs around the drawn cross (top, left | graph | right,
            bottom). Below md the graph is hidden and the inputs stack in the
            order top, left, right, bottom, each with a short position hint. */}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-x-4">
          {axis("yTo", t("y-axis to"), t("top"), "md:col-span-3 md:justify-self-center md:w-full md:max-w-xs")}
          {axis("xFrom", t("x-axis from"), t("left"), "md:justify-self-end md:w-full md:max-w-xs")}
          <AxesGraph />
          {axis("xTo", t("x-axis to"), t("right"), "md:justify-self-start md:w-full md:max-w-xs")}
          {axis("yFrom", t("y-axis from"), t("bottom"), "md:col-span-3 md:justify-self-center md:w-full md:max-w-xs")}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("x runs from left to right, y from bottom to top.")}
        </p>
        {problem?.key === "Please label both ends of both axes." && (
          <p className="text-sm text-danger">{t(problem.key)}</p>
        )}
      </div>

      <div className="grid gap-1">
        <ToggleSwitch
          checked={value.edges}
          onChange={(edges) => patch({ edges })}
          label={t("Allow edges")}
        />
        <p className="pl-[2.875rem] text-xs text-slate-500 dark:text-slate-400">
          {t("Participants can also place a card between two fields.")}
        </p>
      </div>

      <div className="grid gap-1">
        <ToggleSwitch
          checked={value.descriptions}
          onChange={(descriptions) => patch({ descriptions })}
          label={t("Card descriptions")}
        />
        <p className="pl-[2.875rem] text-xs text-slate-500 dark:text-slate-400">
          {t("Participants add a title and an optional description to each card.")}
        </p>
      </div>

      <MaxPerPerson value={value.maxPerPerson} onCommit={(maxPerPerson) => patch({ maxPerPerson })} label={t("Cards per person")} />

      <div className="grid gap-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t("Categories")}</h3>
        <SegmentedControl
          className="max-w-md"
          ariaLabel={t("Categories")}
          value={value.categoryMode}
          onChange={setMode}
          options={[
            { value: "off", label: t("Off") },
            { value: "colors", label: t("Colors only") },
            { value: "named", label: t("With names") },
          ]}
        />
        {value.categoryMode !== "off" && (
          <div className="grid gap-2">
            <ul className="grid gap-2">
              {value.categories.map((category, index) => (
                <li key={category.key} className="flex flex-wrap items-end gap-x-3 gap-y-2">
                  <span className="flex h-9 flex-none items-center">
                    <ColorPicker
                      value={category.key}
                      taken={new Set(value.categories.map((c) => c.key))}
                      label={t("Color of category {{n}}", { n: index + 1 })}
                      onPick={(key) =>
                        patch((prev) => ({
                          categories: prev.categories.map((c) =>
                            c.key === category.key ? { ...c, key } : c,
                          ),
                        }))
                      }
                    />
                  </span>
                  {value.categoryMode === "named" && (
                    <TranslatableField
                      label={t("Name of category {{n}}", { n: index + 1 })}
                      value={category.name}
                      onChange={(name) =>
                        patch((prev) => ({
                          categories: prev.categories.map((c) =>
                            c.key === category.key ? { ...c, name: clamp(name, NAME_MAX) } : c,
                          ),
                        }))
                      }
                      className="min-w-0 flex-1"
                      inputClassName="max-w-xs"
                    />
                  )}
                  <button
                    type="button"
                    aria-label={t("Remove category {{n}}", { n: index + 1 })}
                    onClick={() =>
                      patch({ categories: value.categories.filter((_, i) => i !== index) })
                    }
                    className="mb-1 rounded-full p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <X aria-hidden className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <div>
              <button
                type="button"
                onClick={addCategory}
                disabled={value.categories.length >= MATRIX_MAX_CATEGORIES}
                className="inline-flex items-center gap-1.5 rounded-lg border border-field px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {t("+ Category")}
              </button>
            </div>
            {problem && problem.key !== "Please label both ends of both axes." && (
              <p className="text-sm text-danger">{t(problem.key, problem.values)}</p>
            )}
          </div>
        )}
      </div>

    </fieldset>
  );
}

const numberInput =
  "w-20 rounded-lg border border-field bg-white px-2 py-1 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none";

/** Number input with a local string draft: clearing it with backspace must not
 *  snap to 1 while typing; the value is clamped to 1–100 on blur. */
function MaxPerPerson({ value, onCommit, label }: { value: number; onCommit: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.min(100, Math.max(1, Math.round(Number(draft)) || 1));
    setDraft(String(n));
    onCommit(n);
  };
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
      {label}
      <input
        type="number"
        min={1}
        max={100}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const n = Number(event.target.value);
          if (event.target.value !== "" && n >= 1 && n <= 100) onCommit(Math.round(n));
        }}
        onBlur={commit}
        className={numberInput}
      />
    </label>
  );
}
