// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Colours of the four-field matrix categories (Okabe–Ito, colour-blind safe).
 *  Keys mirror backend rooms/matrix.MATRIX_PALETTE. Colour is never the only
 *  cue: always show `number` next to it. The framework-free participant page
 *  carries its own copy of this map. */
export type MatrixColor = "blue" | "orange" | "green" | "red" | "purple" | "sky";

export const MATRIX_PALETTE: { key: MatrixColor; hex: string; number: number }[] = [
  { key: "blue", hex: "#0072B2", number: 1 },
  { key: "orange", hex: "#E69F00", number: 2 },
  { key: "green", hex: "#009E73", number: 3 },
  { key: "red", hex: "#D55E00", number: 4 },
  { key: "purple", hex: "#CC79A7", number: 5 },
  { key: "sky", hex: "#56B4E9", number: 6 },
];

/** The palette entry of a category key (undefined for an unknown key). */
export function paletteEntry(key: string) {
  return MATRIX_PALETTE.find((entry) => entry.key === key);
}
