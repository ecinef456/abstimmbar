// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): a question's translations (en/de/fr) in the editor.
 *
 *  The question's own text stays the original; a translation is shown when
 *  the room (or the viewer) uses that language. Collapsed by default. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { RichTextEditor } from "@basicbar/ui/rich-text-editor";
import { localizedText, stripHtml, type LocalizedText } from "@basicbar/ui";
import { api, type QuestionTranslations } from "../api";
import { TextInput } from "../components/ui";

export const TRANSLATION_LANGS = ["en", "de", "fr"] as const;
export type TranslationLang = (typeof TRANSLATION_LANGS)[number];

/** Editor state: per language, the text and the options keyed by clientId. */
export type TranslationState = Record<
  TranslationLang,
  { text: string; options: Record<number, { text: string; justification: string }> }
>;

const LANG_NAMES: Record<TranslationLang, string> = { en: "English", de: "Deutsch", fr: "Français" };

export function emptyTranslations(): TranslationState {
  return { en: { text: "", options: {} }, de: { text: "", options: {} }, fr: { text: "", options: {} } };
}

/** From the API (options in position order) to editor state. */
export function translationsFromApi(
  data: QuestionTranslations | undefined,
  clientIds: number[],
): TranslationState {
  const state = emptyTranslations();
  for (const lang of TRANSLATION_LANGS) {
    const item = data?.[lang];
    if (!item) continue;
    state[lang].text = item.text ?? "";
    item.options?.forEach((option, index) => {
      const id = clientIds[index];
      if (id !== undefined) {
        state[lang].options[id] = { text: option.text ?? "", justification: option.justification ?? "" };
      }
    });
  }
  return state;
}

/** Editor state to the API, the options in the order they are saved. */
export function translationsToApi(state: TranslationState, clientIds: number[]): QuestionTranslations {
  const out: QuestionTranslations = {};
  for (const lang of TRANSLATION_LANGS) {
    out[lang] = {
      text: state[lang].text,
      options: clientIds.map((id) => state[lang].options[id] ?? { text: "", justification: "" }),
    };
  }
  return out;
}

function filled(state: TranslationState, lang: TranslationLang) {
  const item = state[lang];
  return Boolean(stripHtml(item.text).trim() || item.text.includes("<img")) ||
    Object.values(item.options).some((o) => o.text.trim() || o.justification.trim());
}

export default function TranslationsPanel({
  value,
  onChange,
  options,
}: {
  value: TranslationState;
  onChange: (next: TranslationState) => void;
  /** The question's answer options (none for free-text kinds). */
  options: { clientId: number; text: LocalizedText }[];
}) {
  const { t } = useTranslation();
  const present = TRANSLATION_LANGS.filter((lang) => filled(value, lang));
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<TranslationLang>(present[0] ?? "en");
  const current = value[lang];

  function update(patch: Partial<TranslationState[TranslationLang]>) {
    onChange({ ...value, [lang]: { ...current, ...patch } });
  }
  function updateOption(clientId: number, patch: Partial<{ text: string; justification: string }>) {
    const before = current.options[clientId] ?? { text: "", justification: "" };
    update({ options: { ...current.options, [clientId]: { ...before, ...patch } } });
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
      className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        <Languages aria-hidden className="h-4 w-4" />
        {t("Translations")}
        <span className="text-xs font-normal text-slate-500">
          {present.length ? present.map((l) => l.toUpperCase()).join(" · ") : t("none yet")}
        </span>
      </summary>
      <div className="mt-3 grid gap-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t(
            "The text above is the original. A translation is shown instead when the room is set to that language; empty fields fall back to the original.",
          )}
        </p>
        <div className="flex gap-1.5" role="tablist">
          {TRANSLATION_LANGS.map((code) => (
            <button
              key={code}
              type="button"
              role="tab"
              aria-selected={lang === code}
              onClick={() => setLang(code)}
              className={`rounded-lg border px-3 py-1 text-sm ${
                lang === code
                  ? "border-brand-600 bg-brand-50 font-semibold text-brand-800 dark:bg-brand-950/40 dark:text-brand-200"
                  : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"
              }`}
            >
              {LANG_NAMES[code]}
              {filled(value, code) && <span className="ml-1 text-brand-700">●</span>}
            </button>
          ))}
        </div>
        <div className="grid gap-1">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
            {t("Question text")} ({LANG_NAMES[lang]})
          </span>
          <RichTextEditor
            key={lang}
            value={current.text}
            onChange={(html: string) => update({ text: html })}
            onUploadImage={async (file: File) => (await api.uploadImage(file)).url}
          />
        </div>
        {options.length > 0 && (
          <div className="grid gap-2">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{t("Answer options")}</span>
            {options.map((option, index) => {
              const item = current.options[option.clientId] ?? { text: "", justification: "" };
              const original = localizedText(option.text);
              return (
                <div key={option.clientId} className="grid gap-1 rounded-lg bg-slate-50 p-2 dark:bg-slate-900/50">
                  <span className="text-xs text-slate-500">
                    {String.fromCharCode(65 + index)} · {original || "—"}
                  </span>
                  <TextInput
                    value={item.text}
                    onChange={(event) => updateOption(option.clientId, { text: event.target.value })}
                    placeholder={original}
                    aria-label={`${t("Answer")} ${String.fromCharCode(65 + index)} (${LANG_NAMES[lang]})`}
                  />
                  <TextInput
                    value={item.justification}
                    onChange={(event) => updateOption(option.clientId, { justification: event.target.value })}
                    placeholder={t("Why right / wrong (translation)")}
                    aria-label={`${t("Why right / wrong (translation)")} ${String.fromCharCode(65 + index)}`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}
