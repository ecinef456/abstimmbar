// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** The four-field matrix's zone picker and category chips for the teacher's
 *  "add card" drawer on the beamer — a React mirror of the participant page
 *  (`live/templates/live/participant.html`, mx* code): a mini axis cross with
 *  the four fields as large buttons and, with edges, round buttons on the
 *  axis lines; every spot shows a "+" until it is chosen (then a check), its
 *  written-out zone name is the accessible name; the axis ends sit outside
 *  (x ends vertical). Category chips are a radio group (roving tabindex,
 *  arrow keys). The beamer is always light: no dark: classes. */
import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus } from "lucide-react";
import { localizedText } from "@basicbar/ui";
import type { MatrixSettingsPayload } from "../api";
import { categoryLabel, paletteEntry } from "../matrixPalette";

const QUADRANTS = ["q2", "q1", "q3", "q4"] as const;
const EDGES = ["e_top", "e_right", "e_bottom", "e_left"] as const;
/** Centre of an edge button on the axis cross (left, top). */
const EDGE_POS: Record<(typeof EDGES)[number], [string, string]> = {
  e_top: ["50%", "25%"],
  e_right: ["75%", "50%"],
  e_bottom: ["50%", "75%"],
  e_left: ["25%", "50%"],
};

const axisText = "text-xs font-bold leading-tight text-slate-600 [overflow-wrap:anywhere]";

export function MatrixZonePicker({
  settings,
  value,
  onChange,
  zoneName,
}: {
  settings: MatrixSettingsPayload;
  value: string;
  onChange(zone: string): void;
  zoneName(zone: string): string;
}) {
  const { t } = useTranslation();
  const edges = settings.edges && EDGES.every((e) => settings.zones.includes(e));
  const zones = settings.zones;
  const axis = (name: keyof MatrixSettingsPayload["axes"]) => localizedText(settings.axes[name]);
  return (
    <div>
      <p id="mx-picker-cap" className="font-medium text-slate-700">
        {t("Choose a field")}
      </p>
      <div
        className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5"
      >
        <span data-picker-axis="y_to" className={`${axisText} col-start-2 row-start-1 text-center`}>
          {axis("y_to")}
        </span>
        <span
          data-picker-axis="x_from"
          className={`${axisText} max-w-[2.2em] col-start-1 row-start-2 rotate-180 text-center [writing-mode:vertical-rl]`}
        >
          {axis("x_from")}
        </span>
        <div role="group" aria-labelledby="mx-picker-cap" className="relative col-start-2 row-start-2">
          <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-xl border-2 border-slate-300 bg-slate-300">
            {QUADRANTS.filter((z) => zones.includes(z)).map((zone) => {
              const on = value === zone;
              return (
                <button
                  key={zone}
                  type="button"
                  data-zone={zone}
                  aria-pressed={on}
                  aria-label={zoneName(zone)}
                  onClick={() => onChange(zone)}
                  className={`flex min-h-[44px] flex-col items-center justify-center gap-1 p-2 text-center text-xs font-semibold leading-tight text-slate-800 focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-brand-600 ${
                    edges ? "px-5" : ""
                  } ${on ? "bg-brand-50 outline outline-[3px] -outline-offset-[3px] outline-brand-700" : "bg-white hover:bg-slate-50"}`}
                >
                  {on ? (
                    <span data-icon="check" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-700 text-white">
                      <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={3} />
                    </span>
                  ) : (
                    <Plus data-icon="plus" aria-hidden className="h-5 w-5 text-slate-500" strokeWidth={2.4} />
                  )}
                  <span aria-hidden>{zoneName(zone)}</span>
                </button>
              );
            })}
          </div>
          {edges &&
            EDGES.map((zone) => {
              const on = value === zone;
              return (
                <button
                  key={zone}
                  type="button"
                  data-zone={zone}
                  aria-pressed={on}
                  aria-label={zoneName(zone)}
                  title={zoneName(zone)}
                  onClick={() => onChange(zone)}
                  style={{ left: EDGE_POS[zone][0], top: EDGE_POS[zone][1] }}
                  className={`absolute z-[2] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                    on ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {on ? (
                    <Check data-icon="check" aria-hidden className="h-4 w-4" strokeWidth={3} />
                  ) : (
                    <Plus data-icon="plus" aria-hidden className="h-[18px] w-[18px]" strokeWidth={2.4} />
                  )}
                </button>
              );
            })}
        </div>
        <span
          data-picker-axis="x_to"
          className={`${axisText} max-w-[2.2em] col-start-3 row-start-2 text-center [writing-mode:vertical-rl]`}
        >
          {axis("x_to")}
        </span>
        <span data-picker-axis="y_from" className={`${axisText} col-start-2 row-start-3 text-center`}>
          {axis("y_from")}
        </span>
      </div>
    </div>
  );
}

/** Category chips (radio group) as on the participant page: colour dot, the
 *  name (named mode) or the letter (colours mode, "Colour A" for screen
 *  readers), a check on the chosen one. */
export function MatrixCategoryChips({
  settings,
  value,
  onChange,
}: {
  settings: MatrixSettingsPayload;
  value: string;
  onChange(key: string): void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("de") ? "de" : "en";
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const keys = settings.categories.map((c) => c.key);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = keys[(keys.indexOf(key) + step + keys.length) % keys.length];
    onChange(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div>
      <p id="mx-chips-cap" className="font-medium text-slate-700">
        {t("Choose a category")}
      </p>
      <div role="radiogroup" aria-labelledby="mx-chips-cap" className="mt-1.5 flex flex-wrap gap-2">
        {settings.categories.map((c, i) => {
          const on = value === c.key;
          const label = categoryLabel(settings.categories, c.key, settings.category_mode, lang, t);
          return (
            <button
              key={c.key}
              ref={(el) => {
                if (el) refs.current.set(c.key, el);
                else refs.current.delete(c.key);
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={label.name || label.a11y}
              tabIndex={on || (!value && i === 0) ? 0 : -1}
              onClick={() => onChange(c.key)}
              onKeyDown={(e) => onKeyDown(e, c.key)}
              className={`inline-flex min-h-[44px] items-center gap-2 rounded-full border-2 px-3 py-1.5 text-sm font-medium text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                on ? "border-brand-700 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <span aria-hidden className="inline-block h-3.5 w-3.5 flex-none rounded-full" style={{ background: paletteEntry(c.key)?.hex }} />
              <span aria-hidden className={label.short ? "font-bold" : ""}>
                {label.name || label.short}
              </span>
              {on && (
                <span aria-hidden className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-brand-700 text-white">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
