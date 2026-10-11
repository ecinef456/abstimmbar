// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Wiring for @basicbar/ui's app-wide `TranslationFormProvider` (main.tsx). */
import type { TranslateFn } from "@basicbar/ui";
import { api } from "./api";

/** Machine-translation pre-fill via our backend (`POST /api/translate/`). */
export const translateContent: TranslateFn = (text, source, target, format) =>
  api.translate(text, source, target, format).then((r) => r.translated);

/** `translation-controls` is an unstyled hook for the e2e tests; set on both
 *  the floating and the docked variant of the controls. */
export const TRANSLATION_CONTROLS_HOOK = "translation-controls";
