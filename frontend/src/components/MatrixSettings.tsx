// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Settings panel of the four-field matrix question (axes, edges,
 *  description, cards per person, categories) with a small live preview. */
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { getDefaultContentLang, localizedMap, localizedText, type LocalizedText } from "@basicbar/ui";
import type { MatrixCategory, MatrixCategoryMode } from "../api";
import { MATRIX_PALETTE, paletteEntry } from "../matrixPalette";
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

export const MATRIX_MAX_CATEGORIES = MATRIX_PALETTE.length;
const MATRIX_MIN_CATEGORIES = 2;
const AXIS_LABEL_MAX = 40;
const NAME_MAX = 40;

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

function Swatch({ colorKey }: { colorKey: string }) {
  const entry = paletteEntry(colorKey);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-4 w-4 flex-none rounded-full border border-slate-900/20 dark:border-white/30"
        style={{ backgroundColor: entry?.hex }}
      />
      <span className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-300">
        {entry?.number}
      </span>
    </span>
  );
}

function Preview({ value }: { value: MatrixSettingsValue }) {
  const { t } = useTranslation();
  const label = "absolute max-w-[40%] truncate text-xs text-slate-600 dark:text-slate-400";
  const dot = "absolute h-2 w-2 rounded-full bg-slate-400 dark:bg-slate-500";
  return (
    <div className="grid gap-3" data-testid="matrix-preview">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{t("Preview")}</span>
      <div className="px-16 pb-5 pt-5">
        <div
          aria-hidden
          className="relative aspect-square w-full max-w-[12rem] rounded-md border border-slate-400 dark:border-slate-500"
        >
          <span className="absolute left-1/2 top-0 h-full border-l border-slate-300 dark:border-slate-600" />
          <span className="absolute left-0 top-1/2 w-full border-t border-slate-300 dark:border-slate-600" />
          <span className={`${label} left-1/2 top-0 -translate-x-1/2 -translate-y-full`}>
            {localizedText(value.yTo)}
          </span>
          <span className={`${label} bottom-0 left-1/2 -translate-x-1/2 translate-y-full`}>
            {localizedText(value.yFrom)}
          </span>
          <span className={`${label} right-full top-1/2 -translate-y-1/2 pr-1`}>
            {localizedText(value.xFrom)}
          </span>
          <span className={`${label} left-full top-1/2 -translate-y-1/2 pl-1`}>
            {localizedText(value.xTo)}
          </span>
          {value.edges && (
            <>
              <span className={`${dot} left-1/2 top-0 -translate-x-1/2 -translate-y-1/2`} />
              <span className={`${dot} bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2`} />
              <span className={`${dot} left-0 top-1/2 -translate-x-1/2 -translate-y-1/2`} />
              <span className={`${dot} right-0 top-1/2 translate-x-1/2 -translate-y-1/2`} />
            </>
          )}
        </div>
      </div>
      {value.categoryMode !== "off" && value.categories.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t("Categories")}>
          {value.categories.map((category) => (
            <li
              key={category.key}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-2.5 py-1 dark:border-slate-600"
            >
              <Swatch colorKey={category.key} />
              {value.categoryMode === "named" && (
                <span className="text-sm text-slate-700 dark:text-slate-300">
                  {localizedText(category.name)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MatrixSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: MatrixSettingsValue;
  onChange: (value: MatrixSettingsValue) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const patch = (changes: Partial<MatrixSettingsValue>) => onChange({ ...value, ...changes });

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
  ) => (
    <TranslatableField
      label={label}
      value={value[id]}
      onChange={(next) => patch({ [id]: clamp(next, AXIS_LABEL_MAX) })}
      inputClassName="max-w-xs"
    />
  );

  const problem = matrixProblem(value);
  const numberInput =
    "w-20 rounded-lg border border-field bg-white px-2 py-1 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none";

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
        <div className="grid gap-3 sm:grid-cols-2">
          {axis("xFrom", t("x-axis from"))}
          {axis("xTo", t("x-axis to"))}
          {axis("yFrom", t("y-axis from"))}
          {axis("yTo", t("y-axis to"))}
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
          label={t("Description")}
        />
        <p className="pl-[2.875rem] text-xs text-slate-500 dark:text-slate-400">
          {t("Participants add a title and an optional description to each card.")}
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
        {t("Cards per person")}
        <input
          type="number"
          min={1}
          max={100}
          value={String(value.maxPerPerson)}
          onChange={(event) =>
            patch({ maxPerPerson: Math.min(100, Math.max(1, Number(event.target.value) || 1)) })
          }
          className={numberInput}
        />
      </label>

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
                <li key={category.key} className="flex items-end gap-3">
                  <span className="flex h-9 w-12 flex-none items-center">
                    <Swatch colorKey={category.key} />
                  </span>
                  {value.categoryMode === "named" && (
                    <TranslatableField
                      label={t("Name of category {{n}}", { n: index + 1 })}
                      value={category.name}
                      onChange={(name) =>
                        patch({
                          categories: value.categories.map((c, i) =>
                            i === index ? { ...c, name: clamp(name, NAME_MAX) } : c,
                          ),
                        })
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

      <Preview value={value} />
    </fieldset>
  );
}
