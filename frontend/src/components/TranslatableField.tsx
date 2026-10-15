// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Thin Abstimmbar wrapper around @basicbar/ui's TranslatableField.
 *
 * Keeps the tool's own conventions on top of the shared component: the
 * map-based value contract (`LocalizedText` + `onChange(next)`), the
 * rich-text variant (the shared RichTextEditor from @basicbar/ui, plugged
 * in via `renderInput`), easy mode (#52: non-staff simple users author in a single
 * canonical language; staff are always Pro) and the prominent form label. */
import { useRef, type ReactNode } from "react";
import {
  TranslatableField as BaseTranslatableField,
  localizedMap,
  setLocalizedLang,
  type LocalizedText,
} from "@basicbar/ui";
import { RichTextEditor } from "@basicbar/ui/rich-text-editor";
import { useEasyMode } from "../App";
import { api } from "../api";

/** Rich-text image upload for the shared editor: stores the file in our media
 *  storage and returns its relative /media/… URL (the only kind the backend
 *  sanitizer keeps). */
async function uploadEditorImage(file: File): Promise<string> {
  const { url } = await api.uploadImage(file);
  return url;
}

/** The shared RichTextEditor is controlled: whenever its `value` prop changes
 *  it compares it (in a passive effect) with the editor's current HTML and
 *  calls `setContent` on a mismatch. Our own edits come back as `value` one
 *  React render later — and under load the user can type another character
 *  between that render and its effect, so the echo is already stale: the
 *  editor is reset to the older text (dropping the newest keystroke), and a
 *  stale echo ending in a space loses that space for good (ProseMirror's
 *  parser strips trailing block whitespace). This wrapper only hands the
 *  editor values that did NOT originate from it, so echoes of its own edits
 *  (current or stale) never trigger a reset; external changes (language tab,
 *  translation pre-fill, reload, a form reset) still apply — one equal to
 *  what the editor was last given remounts it. */
function RichTextInput({
  value,
  onChange,
  labelledBy,
  describedBy,
}: {
  value: string;
  onChange: (html: string) => void;
  labelledBy?: string;
  describedBy?: string;
}) {
  // Bookkeeping lives in a ref and is updated during render on purpose: the
  // decision "own echo or outside value?" must be made for the very value
  // this render hands to the editor. Every step is idempotent for a given
  // `value` (a repeated render — StrictMode, unrelated re-render — sees
  // `value === own.prop` and changes nothing).
  const own = useRef({
    // The `value` prop of the previous render.
    prop: value,
    // Last value handed to the editor from outside (what it shows unless the
    // user has typed since).
    shown: value,
    // Latest HTML the editor emitted, and every emission the parent hasn't
    // caught up with yet (any of them may still come back as `value`).
    latest: null as string | null,
    pending: new Set<string>(),
    // Remount counter: an outside value equal to `shown` would not change
    // the editor's prop (so its sync effect would not run) — remount instead.
    version: 0,
  }).current;
  if (value !== own.prop) {
    own.prop = value;
    if (value === own.latest) {
      // Caught up with the newest emission: older ones can no longer come back.
      own.pending.clear();
    } else if (!own.pending.has(value)) {
      // Outside change (reset, reload, other question, translation pre-fill).
      if (value === own.shown) own.version += 1;
      own.shown = value;
      own.latest = null;
      own.pending.clear();
    }
  }
  return (
    <RichTextEditor
      key={own.version}
      value={own.shown}
      onChange={(html) => {
        own.latest = html;
        own.pending.add(html);
        onChange(html);
      }}
      labelledBy={labelledBy}
      describedBy={describedBy}
      onUploadImage={uploadEditorImage}
    />
  );
}

export type TranslatableFieldVariant = "input" | "rich";

const INPUT_CLASS =
  "w-full rounded-lg border border-field bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-slate-950 dark:bg-slate-900 dark:text-slate-100";

interface TranslatableFieldProps {
  /** The field's current value — a legacy plain string or a `{de, en}` map. */
  value: LocalizedText;
  onChange: (next: LocalizedText) => void;
  label?: string;
  /** Accessible name when there is no visible `label` (e.g. a list row). */
  ariaLabel?: string;
  variant?: TranslatableFieldVariant;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  labelAddon?: ReactNode;
  /** Extra classes appended to the input; ignored for the rich variant. */
  inputClassName?: string;
  onBlur?: () => void;
  onActiveLangChange?: (lang: "de" | "en") => void;
  /** Language codes whose translation is outdated (#91): amber tab dot +
   *  hint, and enables the per-field re-translate button even when the
   *  field is non-empty. */
  stale?: readonly string[];
  /** Renders "Mark as up to date" on a stale tab. */
  onMarkSynced?: () => void;
  /** Fires right after a machine-translation pre-fill (languages now in
   *  sync). */
  onTranslated?: (lang: string, text: string) => void;
}

export default function TranslatableField({
  value,
  onChange,
  variant = "input",
  inputClassName = "",
  onActiveLangChange,
  className = "",
  ...rest
}: TranslatableFieldProps) {
  const easyMode = useEasyMode();
  return (
    <BaseTranslatableField
      {...rest}
      // Space the label/language-tab row off the input so the input's focus
      // ring doesn't crowd the DE/EN tags above it.
      className={`space-y-1.5 ${className}`.trim()}
      values={localizedMap(value)}
      onChange={(lang, text) => onChange(setLocalizedLang(value, lang, text))}
      singleLanguage={easyMode}
      format={variant === "rich" ? "html" : "text"}
      inputClass={`${INPUT_CLASS} ${inputClassName}`.trim()}
      labelClassName="text-sm font-medium text-slate-700 dark:text-slate-300"
      onActiveLangChange={
        onActiveLangChange
          ? (lang) => onActiveLangChange(lang as "de" | "en")
          : undefined
      }
      renderInput={
        variant === "rich"
          ? ({ lang, value: html, onChange: set, labelId, describedBy }) => (
              <div>
                <RichTextInput
                  key={lang}
                  value={html}
                  onChange={set}
                  labelledBy={labelId}
                  describedBy={describedBy}
                />
              </div>
            )
          : undefined
      }
    />
  );
}
