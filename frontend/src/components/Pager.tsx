// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Client-side pager, sits below a list (like Ausleihbar's Pager): a
 * "from–to von count" summary, a page-size dropdown, and prev/next controls
 * with an editable page field. Renders nothing when no paging is needed
 * (count ≤ pageSize). */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

export function Pager({
  page,
  pageSize,
  count,
  onPage,
  onPageSize,
  options = PAGE_SIZE_OPTIONS,
}: {
  page: number;
  pageSize: number;
  count: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  options?: number[];
}) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const [pageInput, setPageInput] = useState(String(page));
  useEffect(() => setPageInput(String(page)), [page]);

  if (count <= pageSize) return null; // no paging necessary

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, count);

  function commit() {
    const value = parseInt(pageInput, 10);
    if (Number.isNaN(value)) {
      setPageInput(String(page));
      return;
    }
    onPage(Math.min(Math.max(1, value), totalPages));
  }

  const arrow =
    "inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-30 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800";

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500 dark:text-slate-400">
      <div className="flex items-center gap-3">
        <span>{t("{{from}}–{{to}} of {{count}}", { from, to, count })}</span>
        <select
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
          aria-label={t("Entries per page")}
          className="rounded-md border border-field bg-white px-2 py-1 text-slate-700 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none dark:bg-slate-900 dark:text-slate-200"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {t("{{count}} per page", { count: option })}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label={t("Previous page")}
          className={arrow}
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </button>
        <span className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
          {t("Page")}
          <input
            type="number"
            min={1}
            max={totalPages}
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            aria-label={t("Jump to page")}
            className="w-12 rounded-md border border-field px-1 py-1 text-center text-slate-900 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none dark:bg-slate-800 dark:text-slate-100"
          />
          / {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          aria-label={t("Next page")}
          className={arrow}
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
