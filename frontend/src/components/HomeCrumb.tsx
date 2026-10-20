// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Shared first breadcrumb crumb: a home icon linking back to the room
 * list, used by every page's breadcrumb trail (#69, #74) instead of a
 * "My rooms" text link. */
import { Home } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

export default function HomeCrumb() {
  const { t } = useTranslation();
  return (
    <Link
      to="/"
      aria-label={t("My rooms")}
      className="-m-1 inline-flex items-center rounded p-1 align-middle hover:text-brand-700 dark:hover:text-brand-300"
    >
      <Home aria-hidden className="h-4 w-4" />
    </Link>
  );
}
