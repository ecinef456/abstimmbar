// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Tour → app signals (#onboarding). Some steps need the app to be in a state
 *  a click would normally produce (the type menu open, the presenter on the
 *  first question). Instead of simulating clicks, the tour emits a signal and
 *  the page runs its OWN handler. Handlers must be idempotent: the controller
 *  re-emits until the step's target appears (the page may still be mounting). */
import { useEffect, useRef } from "react";

export type TourSignal =
  | "open-question-menu"
  | "close-question-menu"
  | "present-first"
  | "present-lobby";

const EVENT = "abstimmbar:tour-signal";

export function emitTourSignal(signal: TourSignal) {
  window.dispatchEvent(new CustomEvent<TourSignal>(EVENT, { detail: signal }));
}

/** Run `handler` whenever the tour emits `signal`. */
export function useTourSignal(signal: TourSignal, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const onSignal = (event: Event) => {
      if ((event as CustomEvent<TourSignal>).detail === signal) handlerRef.current();
    };
    window.addEventListener(EVENT, onSignal);
    return () => window.removeEventListener(EVENT, onSignal);
  }, [signal]);
}
