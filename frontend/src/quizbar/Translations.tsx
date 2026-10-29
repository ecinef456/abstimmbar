// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): a question's translations (en/de/fr) in the editor.
 *
 *  The question's own text stays the original; a translation is shown when
 *  the room (or the viewer) uses that language. Collapsed by default. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages, Loader2, Sparkles } from "lucide-react";
import { RichTextEditor } from "@basicbar/ui/rich-text-editor";
import { localizedText, RichText, stripHtml, type LocalizedText } from "@basicbar/ui";
import { api, quizbar, requestDetail, type QuestionTranslations } from "../api";
import { Button, TextInput } from "../components/ui";
import { mathHtml } from "../math";

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

let translateStatus: Promise<boolean> | null = null;

/** Is a translation service set up on the server? (asked once per page) */
function useTranslateEnabled() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    translateStatus ??= quizbar.translateStatus().then(
      (data) => data.enabled,
      () => false,
    );
    void translateStatus.then(setEnabled);
  }, []);
  return enabled;
}

const clean = (html: string) => stripHtml(html).replace(/\s+/g, " ").trim();

export default function TranslationsPanel({
  value,
  onChange,
  options,
  originalText,
}: {
  value: TranslationState;
  onChange: (next: TranslationState) => void;
  /** The question's answer options (none for free-text kinds). */
  options: { clientId: number; text: LocalizedText; justification?: string }[];
  /** The question's own text (HTML), the source for "Translate". */
  originalText?: string;
}) {
  const { t } = useTranslation();
  const present = TRANSLATION_LANGS.filter((lang) => filled(value, lang));
  const [open, setOpen] = useState(false);
  const autoEnabled = useTranslateEnabled();
  const [from, setFrom] = useState<"original" | TranslationLang>("original");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoError, setAutoError] = useState("");

  async function translateAll() {
    const ids = options.map((o) => o.clientId);
    const source =
      from === "original"
        ? {
            text: originalText ?? "",
            options: options.map((o) => ({ text: localizedText(o.text), justification: o.justification ?? "" })),
          }
        : {
            text: value[from].text,
            options: ids.map((id, i) => ({
              text: value[from].options[id]?.text || localizedText(options[i].text),
              justification: value[from].options[id]?.justification ?? "",
            })),
          };
    const targets = TRANSLATION_LANGS.filter((lang) => lang !== from);
    setBusy(true);
    setAutoError("");
    try {
      const result = await quizbar.translate({ source: from === "original" ? "" : from, targets, ...source });
      const next: TranslationState = { ...value };
      for (const lang of targets) {
        const item = result[lang];
        // Same text back = the source was already in this language.
        if (!item || (from === "original" && clean(item.text) === clean(source.text))) continue;
        const current = next[lang];
        const optionsNext = { ...current.options };
        ids.forEach((id, i) => {
          const before = optionsNext[id] ?? { text: "", justification: "" };
          const got = item.options[i] ?? { text: "", justification: "" };
          optionsNext[id] = {
            text: overwrite || !before.text.trim() ? got.text : before.text,
            justification: overwrite || !before.justification.trim() ? got.justification : before.justification,
          };
        });
        next[lang] = {
          text: overwrite || !clean(current.text) ? item.text : current.text,
          options: optionsNext,
        };
      }
      onChange(next);
    } catch (err) {
      setAutoError(requestDetail(err) ?? t("The translation failed."));
    } finally {
      setBusy(false);
    }
  }
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
        {autoEnabled && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-900/50 dark:text-slate-300">
            <Sparkles aria-hidden className="h-4 w-4 text-brand-700" />
            <span>{t("Translate from")}</span>
            <select
              value={from}
              onChange={(event) => setFrom(event.target.value as "original" | TranslationLang)}
              aria-label={t("Translate from")}
              className="rounded-md border border-field bg-white px-2 py-1 text-sm dark:bg-slate-900"
            >
              <option value="original">{t("the original")}</option>
              {TRANSLATION_LANGS.filter((lang) => filled(value, lang)).map((lang) => (
                <option key={lang} value={lang}>
                  {LANG_NAMES[lang]}
                </option>
              ))}
            </select>
            <span>{t("into the other languages")}</span>
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 accent-brand-600"
              />
              {t("replace what is already there")}
            </label>
            <Button
              variant="secondary"
              className="ml-auto inline-flex items-center gap-1.5"
              disabled={busy}
              onClick={() => void translateAll()}
            >
              {busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
              {busy ? t("Translating…") : t("Translate")}
            </Button>
            {autoError && (
              <p role="alert" className="w-full text-xs text-red-700 dark:text-red-400">
                {autoError}
              </p>
            )}
            <p className="w-full text-xs text-slate-500">
              {t("A draft: check it before saving. Math stays as it is.")}
            </p>
          </div>
        )}
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
          {/* The original for reference, like "A · …" above each answer. */}
          {originalText && (stripHtml(originalText) || originalText.includes("<img")) && (
            <div className="max-h-32 overflow-y-auto rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-900/50 dark:text-slate-400 [&_img]:inline-block [&_img]:max-h-16 [&_img]:w-auto [&_p]:my-0">
              <span className="font-medium">{t("Original")}:</span>{" "}
              <RichText html={mathHtml(originalText)} />
            </div>
          )}
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
