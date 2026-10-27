// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import { i18n, localizedMap, type LocalizedText } from "@basicbar/ui";

/** Colours of the four-field matrix categories (Okabe–Ito, colour-blind safe).
 *  Keys mirror backend rooms/matrix.MATRIX_PALETTE. Colour is never the only
 *  cue: named mode shows the name, colours mode a letter by list position
 *  (`categoryLabel`). The framework-free participant page carries its own copy
 *  of this map and rule. */
export type MatrixColor = "blue" | "orange" | "green" | "red" | "purple" | "sky";

export const MATRIX_PALETTE: { key: MatrixColor; hex: string }[] = [
  { key: "blue", hex: "#0072B2" },
  { key: "orange", hex: "#E69F00" },
  { key: "green", hex: "#009E73" },
  { key: "red", hex: "#D55E00" },
  { key: "purple", hex: "#CC79A7" },
  { key: "sky", hex: "#56B4E9" },
];

/** The palette entry of a category key (undefined for an unknown key). */
export function paletteEntry(key: string) {
  return MATRIX_PALETTE.find((entry) => entry.key === key);
}

// quizbar (fork): French names too.
const COLOR_NAMES: Record<MatrixColor, { de: string; en: string; fr: string }> = {
  blue: { de: "Blau", en: "Blue", fr: "Bleu" },
  orange: { de: "Orange", en: "Orange", fr: "Orange" },
  green: { de: "Grün", en: "Green", fr: "Vert" },
  red: { de: "Rot", en: "Red", fr: "Rouge" },
  purple: { de: "Violett", en: "Purple", fr: "Violet" },
  sky: { de: "Hellblau", en: "Sky blue", fr: "Bleu ciel" },
};

/** Display name of a palette colour in the given UI language. Callers pass
 *  "de" | "en"; quizbar (fork): a French UI gets the French name. */
export function colorName(key: string, lang: "de" | "en"): string {
  const ui = i18n.language?.startsWith("fr") ? "fr" : lang;
  return COLOR_NAMES[key as MatrixColor]?.[ui] ?? "";
}

/** Label of a category: `named` mode shows colour + name only; `colors` mode
 *  a letter by the category's POSITION in the list (A, B, ...), independent of
 *  its colour. `short` is the visible letter (empty in named mode), `name` the
 *  category name (named mode), `a11y` the accessible text — the one
 *  translated string ("Colour A"), hence the caller passes its `t`. */
export function categoryLabel(
  categories: { key: string; name?: LocalizedText }[],
  key: string,
  mode: "off" | "colors" | "named",
  lang: "de" | "en",
  t: (key: string, options?: Record<string, unknown>) => string,
): { short: string; name: string; a11y: string } {
  const index = categories.findIndex((c) => c.key === key);
  if (mode === "colors" && index >= 0) {
    const short = String.fromCharCode(65 + index);
    return { short, name: "", a11y: t("Colour {{letter}}", { letter: short }) };
  }
  if (mode === "named" && index >= 0) {
    const names = localizedMap(categories[index].name);
    const name = names[lang] || names.de || names.en || "";
    return { short: "", name, a11y: name };
  }
  return { short: "", name: "", a11y: colorName(key, lang) };
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** `ratio` of `hex` mixed into `base` (both "#rrggbb"), as a CSS colour —
 *  the light tint of a card body. */
export function mixHex(hex: string, base: string, ratio: number): string {
  const a = channels(hex);
  const b = channels(base);
  const [r, g, bl] = a.map((v, i) => Math.round(v * ratio + b[i] * (1 - ratio)));
  return `rgb(${r}, ${g}, ${bl})`;
}

/** WCAG relative luminance of "#rrggbb". */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const LETTER_LIGHT = "#ffffff";
const LETTER_DARK = "#111111";

/** Text colour for a letter on a full-colour tab: white or near-black,
 *  whichever contrasts more (≥ 4.5:1 for every palette colour). */
export function readableOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance(LETTER_DARK) + 0.05);
  return onWhite >= onDark ? LETTER_LIGHT : LETTER_DARK;
}
