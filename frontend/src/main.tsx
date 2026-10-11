// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import "@fontsource-variable/plus-jakarta-sans";
import "./index.css";
import "./i18n";
import { ThemeProvider } from "@basicbar/ui";
import App, { Home, RequireAuth } from "./App";
import AdminPage from "./pages/AdminPage";
import PageView from "./pages/PageView";
import PresentPage from "./pages/PresentPage";
import QuestionPage from "./pages/QuestionPage";
import ResultsPage from "./pages/ResultsPage";
import RoomPage from "./pages/RoomPage";
import SetPage from "./pages/SetPage";
import SharedPage from "./pages/SharedPage";
import { TranslationFormProvider } from "@basicbar/ui";
import { TRANSLATION_CONTROLS_HOOK, translateContent } from "./translation";
import { TourHost } from "./tour/TourController";

const router = createBrowserRouter([
  {
    // Pathless root layout: <TourProvider><Outlet/></TourProvider> wraps BOTH
    // the app shell and the fullscreen present/quiz routes, so the guided-tour
    // state + driver overlay survive navigation across that boundary.
    element: <TourHost />,
    children: [
      {
        path: "/",
        element: <App />,
        children: [
          { index: true, element: <Home /> },
          // Public content pages (footer links): reachable without login.
          { path: "pages/:slug", element: <PageView /> },
          // Authoring pages: require a signed-in account.
          {
            element: <RequireAuth />,
            children: [
              { path: "admin", element: <AdminPage /> },
              { path: "rooms/:roomId", element: <RoomPage /> },
              { path: "sets/:setId", element: <SetPage /> },
              { path: "sets/:setId/results", element: <ResultsPage /> },
              { path: "sets/:setId/questions/:questionId", element: <QuestionPage /> },
              { path: "shared/:token", element: <SharedPage /> },
            ],
          },
        ],
      },
      // Fullscreen, outside the app shell (no header) — beamer view.
      { path: "/sets/:setId/present", element: <PresentPage /> },
      // Self-paced quiz dashboard (concept §6.3), same fullscreen shell.
      { path: "/sets/:setId/quiz", element: <PresentPage mode="self_paced" /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Legacy storage key so existing visitors keep their stored choice. */}
    <ThemeProvider storageKey="abstimmbar_theme">
      <TranslationFormProvider
        translate={translateContent}
        // Floating pill (movable by its handle). On phones, forms with
        // translatable fields put a <TranslationControlsSlot /> at the top,
        // so the controls dock into the flow there instead of covering the
        // form (#179); where no slot is mounted the pill floats, lifted on
        // narrow screens to stay clear of sticky action bars.
        controlsClassName={`${TRANSLATION_CONTROLS_HOOK} fixed bottom-6 right-6 z-40 max-md:bottom-[5.5rem]`}
        slotControlsClassName={`${TRANSLATION_CONTROLS_HOOK} flex justify-end`}
      >
        <RouterProvider router={router} />
      </TranslationFormProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
