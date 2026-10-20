// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Public content page at /pages/:slug (Impressum, Datenschutz, free pages).
 * For the privacy slug it appends the auto-generated data-collection table
 * from the backend registry below the admin-authored prose. */
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { FileQuestion } from "lucide-react";
import { api, type DataCollection, type PageDetail } from "../api";
import ScrollFade from "../components/ScrollFade";
import { EmptyState } from "../components/ui";
import { localizedText, RichText } from "@basicbar/ui";

const PRIVACY_SLUG = "datenschutz";

export default function PageView() {
  const { t } = useTranslation();
  const { slug } = useParams();
  const [page, setPage] = useState<PageDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [data, setData] = useState<DataCollection | null>(null);
  const [tableScrolls, setTableScrolls] = useState(false);

  useEffect(() => {
    setPage(null);
    setMissing(false);
    void api.getPage(slug!).then(setPage).catch(() => setMissing(true));
    if (slug === PRIVACY_SLUG) {
      void api.getDataCollection().then(setData).catch(() => setData(null));
    }
  }, [slug]);

  if (missing) {
    return (
      <EmptyState icon={FileQuestion} title={t("Page not found")}>
        {t("This page no longer exists.")}
      </EmptyState>
    );
  }
  if (!page) return null;

  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-3xl font-bold">{localizedText(page.title)}</h1>
      <RichText html={localizedText(page.body)} />

      {slug === PRIVACY_SLUG && data && (
        <section className="mt-8">
          <h2 className="mb-3 text-xl font-bold">{t("Overview of processed data")}</h2>
          {/* Scrolls sideways on phones (#65); the fade and hint make that
              visible (#179). */}
          {tableScrolls && (
            <p className="mb-2 text-xs text-slate-500 sm:hidden dark:text-slate-400">
              {t("Swipe sideways to see the whole table.")}
            </p>
          )}
          <ScrollFade
            scrollerClassName="rounded-2xl border border-slate-200 dark:border-slate-800"
            onScrollableChange={setTableScrolls}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("Category")}</th>
                  <th className="px-4 py-2 font-medium">{t("Data")}</th>
                  <th className="px-4 py-2 font-medium">{t("Purpose")}</th>
                  <th className="px-4 py-2 font-medium">{t("Legal basis")}</th>
                  <th className="px-4 py-2 font-medium">{t("Retention period")}</th>
                </tr>
              </thead>
              <tbody>
                {data.collected.map((item) => (
                  <tr
                    key={item.category}
                    className="border-t border-slate-200 align-top dark:border-slate-800"
                  >
                    <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">
                      {item.category}
                    </td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{item.data}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{item.purpose}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                      {item.legal_basis}
                    </td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                      {item.retention}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFade>

          <h3 className="mb-2 mt-6 font-semibold">{t("What we don't collect")}</h3>
          <ul className="list-disc space-y-1 pl-6 text-sm text-slate-600 dark:text-slate-300">
            {data.not_collected.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
