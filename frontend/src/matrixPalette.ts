// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

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

const COLOR_NAMES: Record<MatrixColor, { de: string; en: string }> = {
  blue: { de: "Blau", en: "Blue" },
  orange: { de: "Orange", en: "Orange" },
  green: { de: "Grün", en: "Green" },
  red: { de: "Rot", en: "Red" },
  purple: { de: "Violett", en: "Purple" },
  sky: { de: "Hellblau", en: "Sky blue" },
};

/** Display name of a palette colour in the given UI language. */
export function colorName(key: string, lang: "de" | "en"): string {
  return COLOR_NAMES[key as MatrixColor]?.[lang] ?? "";
}

/** Label of a category: `named` mode shows colour + name only; `colors` mode
 *  a letter by the category's POSITION in the list (A, B, ...), independent of
 *  its colour. `short` is the visible letter (empty in named mode), `name` the
 *  category name (named mode), `a11y` the accessible text. */
export function categoryLabel(
  categories: { key: string; name?: { de?: string; en?: string } }[],
  key: string,
  mode: "off" | "colors" | "named",
  lang: "de" | "en",
): { short: string; name: string; a11y: string } {
  const index = categories.findIndex((c) => c.key === key);
  if (mode === "colors" && index >= 0) {
    const short = String.fromCharCode(65 + index);
    return { short, name: "", a11y: (lang === "de" ? "Farbe " : "Colour ") + short };
  }
  if (mode === "named" && index >= 0) {
    const name = categories[index].name?.[lang] || categories[index].name?.de || categories[index].name?.en || "";
    return { short: "", name, a11y: name };
  }
  return { short: "", name: "", a11y: colorName(key, lang) };
}
