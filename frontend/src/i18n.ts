// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Wires the tool's catalogs into @basicbar/ui's i18n and owns the language
 *  preference (abstimmbar_lang: auto|de|en|fr), authoritative over i18next's
 *  own detector cache. "auto" follows the browser language.
 *  quizbar (fork): French added (fr/translation.json). */
import { i18n, initI18n } from "@basicbar/ui";
import { api } from "./api";
import de from "./locales/de/translation.json";
import en from "./locales/en/translation.json";
import fr from "./locales/fr/translation.json";

initI18n({
  resources: { en, de, fr },
  languages: [
    { code: "en", label: "English" },
    { code: "de", label: "Deutsch" },
    { code: "fr", label: "Français" },
  ],
});

export type LangPref = "auto" | "de" | "en" | "fr";
const LANG_KEY = "abstimmbar_lang";

export function browserLang(): "de" | "en" | "fr" {
  const nav = (navigator.language || "en").split("-")[0];
  return nav === "de" || nav === "fr" ? nav : "en";
}

export function getLangPref(): LangPref {
  const v = localStorage.getItem(LANG_KEY);
  return v === "de" || v === "en" || v === "fr" ? v : "auto";
}

export function applyLangPref(pref: LangPref, authenticated = false): void {
  if (pref === "auto") {
    localStorage.removeItem(LANG_KEY);
    void i18n.changeLanguage(browserLang());
  } else {
    localStorage.setItem(LANG_KEY, pref);
    void i18n.changeLanguage(pref);
    // The backend keeps de/en only (fr is a UI language of this fork).
    if (authenticated && pref !== "fr") api.setLanguage(pref).catch(() => {});
  }
}

// Apply the stored pref now, so it wins over the detector's cached "lang".
applyLangPref(getLangPref());

export { SUPPORTED_LANGUAGES, i18n as default } from "@basicbar/ui";
