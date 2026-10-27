// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): ask students how sure they are (0–10, optional on the
 *  phone) after each single/multiple-choice answer of a live poll. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react";
import { quizbar } from "../api";
import { ToggleSwitch } from "../components/ui";

export default function ConfidencePanel({ setId }: { setId: number }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    void quizbar.confidence(setId).then(
      (data) => setEnabled(data.enabled),
      () => setEnabled(null),
    );
  }, [setId]);
  if (enabled === null) return null;
  return (
    <section className="mb-8 flex max-w-2xl items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <Gauge aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-slate-600 dark:text-slate-300" />
      <div className="grid gap-2">
        <ToggleSwitch
          checked={enabled}
          onChange={(on) => {
            setEnabled(on);
            void quizbar.setConfidence(setId, on).then((data) => setEnabled(data.enabled));
          }}
          label={t("Ask how sure students are")}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t(
            "After answering, phones show an optional row 0–10 (guessing … sure). The results show the average, separately for right and wrong answers. Peer instruction: press D on a question to let the class discuss and vote again.",
          )}
        </p>
      </div>
    </section>
  );
}
