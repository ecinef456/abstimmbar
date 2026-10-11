// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Copy page for a shared question set (v2 "Teilen & Zusammenarbeit"):
 * anyone logged in with the link sees a preview and copies the set into
 * one of their own rooms — editing stays with the owners. */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Link2 } from "lucide-react";
import { api, type Room, type SharedSet } from "../api";
import { Button, EmptyState, Field } from "../components/ui";
import { localizedText } from "@basicbar/ui";
import { licenseLabel } from "../licenses";

// Values are English catalog keys (translated at the render site), matching
// the words already used for these question kinds elsewhere in the UI.
const KIND_LABEL_KEYS: Record<string, string> = {
  single_choice: "Single Choice",
  multiple_choice: "Multiple Choice",
  word_cloud: "Word cloud",
  likert: "Likert scale",
  open_text: "Free text",
  priorities: "Priorities",
  ordering: "Ordering",
  mindmap: "Mind map",
};

export default function SharedPage() {
  const { t } = useTranslation();
  const { token } = useParams();
  const navigate = useNavigate();
  const [shared, setShared] = useState<SharedSet | null>(null);
  const [missing, setMissing] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void api
      .getSharedSet(token!)
      .then(setShared)
      .catch(() => setMissing(true));
    void api.listRooms().then((page) => {
      setRooms(page.results);
      if (page.results.length > 0) setTarget(page.results[0].id);
    });
  }, [token]);

  async function handleCopy() {
    if (target === null) return;
    setBusy(true);
    setError("");
    try {
      const copied = await api.copySharedSet(token!, target);
      navigate(`/sets/${copied.id}`);
    } catch (err) {
      setError(t("Copy failed: {{error}}", { error: String(err) }));
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <EmptyState icon={Link2} title={t("Invalid link")}>
        {t(
          "This share link no longer exists — sharing may have been ended. Please ask the person who shared the link.",
        )}
      </EmptyState>
    );
  }
  if (!shared) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <p className="mb-2 text-sm font-semibold text-brand-700 dark:text-brand-300">
        {t("Shared question set")}
      </p>
      <h1 className="text-2xl font-bold">{shared.title}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {t("by {{owners}}", { owners: shared.owners.join(", ") })} · {shared.question_count}{" "}
        {t("question", { count: shared.question_count })} ·{" "}
        {t("License: {{license}}", { license: licenseLabel(shared.license) })}
        {shared.license_holder && ` — ${shared.license_holder}`}
      </p>
      {shared.description && (
        <p className="mt-3 text-slate-700 dark:text-slate-300">{shared.description}</p>
      )}

      <ol className="mt-6 space-y-2">
        {shared.questions.map((question, index) => (
          <li
            key={index}
            className="rounded-xl border border-slate-200 px-4 py-2.5 dark:border-slate-800"
          >
            <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
              {question.text || t("(no text)")}
            </span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {KIND_LABEL_KEYS[question.kind] ? t(KIND_LABEL_KEYS[question.kind]) : question.kind}
            </span>
          </li>
        ))}
        {shared.question_count > shared.questions.length && (
          <li className="px-4 py-1 text-sm text-slate-400">
            {t("… and {{count}} more", {
              count: shared.question_count - shared.questions.length,
            })}
          </li>
        )}
      </ol>

      <div className="mt-8 flex flex-wrap items-end gap-3 rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-900 dark:bg-brand-950/40">
        {rooms.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t(
              "You don't have your own room yet — first create one on the homepage to take over the set.",
            )}
          </p>
        ) : (
          <>
            <Field label={t("Copy into which of your rooms?")}>
              <select
                value={target ?? undefined}
                onChange={(event) => setTarget(Number(event.target.value))}
                className="w-64 rounded-lg border border-field bg-white px-3 py-2 text-sm dark:bg-slate-900 dark:text-slate-100"
              >
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {localizedText(room.title)}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="primary" disabled={busy} onClick={() => void handleCopy()}>
              {busy ? t("Copied …") : t("Copy to my room")}
            </Button>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <p className="mt-3 text-xs text-slate-400">
        {t(
          "The copy is independent of the original — later changes don't affect each other.",
        )}
      </p>
    </div>
  );
}
