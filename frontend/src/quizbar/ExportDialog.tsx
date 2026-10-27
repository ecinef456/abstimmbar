// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): export single- and multiple-choice questions as PDF
 *  (a room, a folder, or the questions the library shows). The server
 *  typesets them with Typst: one PDF, or a zip with a folder per language
 *  (PDFs with and without solutions, and the .typ sources). */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown } from "lucide-react";
import { quizbar, requestDetail, type ExportRequest } from "../api";
import { Button } from "../components/ui";
import Modal from "./Modal";
import { TRANSLATION_LANGS, type TranslationLang } from "./Translations";

const LANG_NAMES: Record<TranslationLang, string> = { en: "English", de: "Deutsch", fr: "Français" };

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function ExportDialog({
  title,
  target,
  count,
  defaultLang,
  onClose,
}: {
  /** What is exported, e.g. the room or folder name. */
  title: string;
  target: Pick<ExportRequest, "scope" | "id" | "entries" | "label">;
  /** Number of questions, when known (the library). */
  count?: number;
  defaultLang?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const initial = [defaultLang, i18n.language?.slice(0, 2), "en"].find(
    (lang): lang is TranslationLang => TRANSLATION_LANGS.includes(lang as TranslationLang),
  )!;
  const [langs, setLangs] = useState<TranslationLang[]>([initial]);
  const [blank, setBlank] = useState(true);
  const [solutions, setSolutions] = useState(true);
  const [versions, setVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const variants = Number(blank) + Number(solutions);
  const files = variants ? langs.length * (variants * (versions ? 2 : 1) + (versions ? 1 : 0)) : 0;
  const toggle = (lang: TranslationLang) =>
    setLangs((current) =>
      current.includes(lang) ? current.filter((l) => l !== lang) : TRANSLATION_LANGS.filter((l) => l === lang || current.includes(l)),
    );

  async function run() {
    setBusy(true);
    setError("");
    try {
      const { blob, filename } = await quizbar.exportPdf({ ...target, langs, blank, solutions, versions });
      download(blob, filename);
      onClose();
    } catch (err) {
      const detail = requestDetail(err);
      setError(detail ? t(detail) : t("The export failed."));
    } finally {
      setBusy(false);
    }
  }

  const box = "h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500";
  return (
    <Modal title={t("Export as PDF")} onClose={onClose}>
      <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
        {title}
        {count !== undefined && <> · {t("{{count}} questions", { count })}</>}
        <br />
        <span className="text-xs">{t("Single- and multiple-choice questions only.")}</span>
      </p>
      <fieldset className="mb-4">
        <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{t("Languages")}</legend>
        <div className="flex flex-wrap gap-4">
          {TRANSLATION_LANGS.map((lang) => (
            <label key={lang} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className={box} checked={langs.includes(lang)} onChange={() => toggle(lang)} />
              {LANG_NAMES[lang]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mb-4 grid gap-2">
        <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{t("Versions")}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className={`${box} mt-0.5`} checked={blank} onChange={(e) => setBlank(e.target.checked)} />
          <span>
            {t("Without solutions")}
            <span className="block text-xs text-slate-500">{t("Empty boxes to tick: ○ one answer, □ several answers")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className={`${box} mt-0.5`}
            checked={solutions}
            onChange={(e) => setSolutions(e.target.checked)}
          />
          <span>
            {t("With solutions")}
            <span className="block text-xs text-slate-500">{t("Correct answers marked, with the explanation of every answer")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 border-t border-slate-200 pt-2 text-sm dark:border-slate-800">
          <input
            type="checkbox"
            className={`${box} mt-0.5`}
            checked={versions}
            onChange={(e) => setVersions(e.target.checked)}
          />
          <span>
            {t("Exam versions A and B")}
            <span className="block text-xs text-slate-500">
              {t("Same questions, answers in a different order in B, plus an answer key for both")}
            </span>
          </span>
        </label>
      </fieldset>
      <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
        {files === 0
          ? t("Choose at least one language and one version.")
          : files === 1
            ? t("You get one PDF.")
            : t("You get a zip: one folder per language, {{n}} PDFs in all, plus the Typst sources.", {
                n: files,
              })}
      </p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={files === 0 || busy}
          onClick={() => void run()}
          className="inline-flex items-center gap-1.5"
        >
          <FileDown aria-hidden className="h-4 w-4" />
          {busy ? t("Typesetting…") : t("Export")}
        </Button>
      </div>
    </Modal>
  );
}
