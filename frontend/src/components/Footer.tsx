// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Global footer: admin-managed page links plus a fixed credit line. Shown
 * on every page of the app shell (including the pre-login landing). */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type FooterPageLink } from "../api";
import { localizedText } from "@basicbar/ui";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "../version";

export default function Footer() {
  const { t } = useTranslation();
  const [pages, setPages] = useState<FooterPageLink[]>([]);

  useEffect(() => {
    void api.getFooterPages().then(setPages).catch(() => setPages([]));
  }, []);

  return (
    <footer className="mt-16 border-t border-slate-200 dark:border-slate-800">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
        {pages.map((page) => (
          <Link
            key={page.slug}
            to={`/pages/${page.slug}`}
            className="hover:text-brand-700 dark:hover:text-brand-300"
          >
            {localizedText(page.title)}
          </Link>
        ))}
        <a
          href="https://github.com/virtUOS/abstimmbar"
          target="_blank"
          rel="noopener noreferrer"
          title={t("abstimmBAR on GitHub")}
          className="ml-auto hover:text-brand-700 dark:hover:text-brand-300"
        >
          abstimm<span className="font-semibold">BAR</span>
        </a>
        <span className="text-xs">
          {t("Version {{version}}", { version: APP_VERSION })}
        </span>
      </div>
    </footer>
  );
}
