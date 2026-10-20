// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, Navigate, Outlet, useNavigate, useOutletContext } from "react-router";
import {
  BarChart3,
  Info,
  Settings,
  Unplug,
  X,
} from "lucide-react";
import { api, loginUrl, logoutUrl, silentLoginUrl, type SitePublic, type Whoami } from "./api";
import {
  AppearanceControl,
  LanguageOptions,
  PreferencesMenu,
  localizedText,
  setDefaultContentLang,
  setTranslationEnabled,
  RichText,
} from "@basicbar/ui";
import BetaBadge from "./components/BetaBadge";
import Footer from "./components/Footer";
import GenerationStatusBar from "./components/GenerationStatusBar";
import HelpMenu from "./components/HelpMenu";
import JoinByCode from "./components/JoinByCode";
import { applyLangPref } from "./i18n";
import { EmptyState, SegmentedControl } from "./components/ui";
import RoomsPage from "./pages/RoomsPage";
import { useTour } from "./tour/TourController";
import WelcomeDialog from "./tour/WelcomeDialog";

// --- Silent SSO + deep-link restore (#19, adopted from Ausleihbar) ----------
// Where to send the user once signed in; survives the full-page OIDC round-trip
// via sessionStorage (per-tab), consumed on the first authenticated load so a
// shared deep link like /sets/5/present still lands there after sign-in.
const REDIRECT_KEY = "postLoginRedirect";

/** Remember an in-app destination to return to after sign-in. The landing page
 *  ("/" and its ?sso markers) is never a destination. */
function rememberRedirect(path: string): void {
  if (path && path !== "/" && !path.startsWith("/?")) {
    sessionStorage.setItem(REDIRECT_KEY, path);
  }
}

function takeRedirect(): string | null {
  const target = sessionStorage.getItem(REDIRECT_KEY);
  if (target) sessionStorage.removeItem(REDIRECT_KEY);
  return target;
}

const currentPath = () => window.location.pathname + window.location.search;

/** Try the silent SSO login at most once per tab, and never right after a
 *  silent attempt or a logout (both marked via the ?sso= param). */
function shouldTrySilentLogin(): boolean {
  if (new URLSearchParams(window.location.search).has("sso")) return false;
  return !sessionStorage.getItem("ssoTried");
}

/** Full-page logout that also ends the Keycloak session; the ssoTried flag
 *  stops silent SSO from logging the user straight back in (#19). */
function doLogout(): void {
  sessionStorage.setItem("ssoTried", "1");
  window.location.assign(logoutUrl);
}

function UserMenu({ whoami }: { whoami: Whoami }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const name = whoami.first_name || whoami.username || "?";
  const displayName =
    [whoami.first_name, whoami.last_name].filter(Boolean).join(" ") ||
    whoami.username;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("User menu")}
        className="flex items-center rounded-full p-1 transition-colors duration-150 hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-400 text-sm font-bold text-slate-900">
          {name[0].toUpperCase()}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          // Phones (#179): the header wraps, so the avatar's position varies —
          // span the viewport (below the button) instead of hanging off it.
          className="absolute right-0 z-30 mt-2 w-56 overflow-hidden max-sm:fixed max-sm:left-4 max-sm:right-4 max-sm:w-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-slate-900/5 dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="px-3 py-2 text-xs text-slate-400">
            <p className="truncate">
              {t("Signed in as")}{" "}
              <span className="font-medium text-slate-600 dark:text-slate-300">
                {displayName}
              </span>
            </p>
            {whoami.is_staff && (
              <span className="mt-1 inline-block rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 dark:bg-brand-900 dark:text-brand-200">
                {t("Admin")}
              </span>
            )}
          </div>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          {/* Picks go through applyLangPref: abstimmbar_lang stays authoritative at
              startup, and signed-in picks are also saved on the account. */}
          <LanguageOptions onChange={(lang) => applyLangPref(lang as "de" | "en", true)} />
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <AppearanceControl />
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button
            type="button"
            onClick={doLogout}
            role="menuitem"
            className="block w-full px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {t("Sign out")}
          </button>
        </div>
      )}
    </div>
  );
}

export interface AppContext {
  whoami: Whoami | null;
  site: SitePublic | null;
  setEasyMode: (easyMode: boolean) => void;
}

export function useApp() {
  return useOutletContext<AppContext>();
}

/** Easy mode (#52): a UI preference that simplifies the UI. The backend
 * reports the effective mode per role default (non-staff start in "simple",
 * staff start in "pro"), but any signed-in user may toggle between them. */
export function useEasyMode(): boolean {
  return useApp().whoami?.easy_mode ?? false;
}

/** Layout shell: header (logo/login), routed content, global footer. */
/** One-time, dismissible AI privacy notice (GitLab #80). Shown when the admin
 *  configured a notice (SiteConfig, translatable) and AI is available;
 *  dismissal is stored per browser, keyed by the notice so an edit re-shows. */
function AiNoticeBanner({ site, whoami }: { site: SitePublic; whoami: Whoami }) {
  const { t } = useTranslation();
  const notice = whoami.ai_enabled ? localizedText(site.ai_notice).trim() : "";
  // Keyed by the raw (all-language) notice so an edit re-surfaces it, but a
  // mere UI-language switch does not.
  const key = "abstimmbar_ai_notice_seen";
  const stamp = notice ? JSON.stringify(site.ai_notice).slice(0, 120) : "";
  const [dismissed, setDismissed] = useState(
    () => !notice || localStorage.getItem(key) === stamp,
  );
  if (!notice || dismissed) return null;
  return (
    <div className="border-b border-brand-200 bg-brand-50/60 dark:border-brand-900 dark:bg-brand-950/40">
      <div className="mx-auto flex w-full max-w-5xl items-start gap-2 px-4 py-2 text-sm sm:gap-3 sm:py-2.5 text-slate-700 dark:text-slate-200">
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand-700 dark:text-brand-300" />
        <p className="min-w-0 flex-1">
          {notice}
          {/* An internal content page takes precedence over an external URL. */}
          {site.ai_notice_page ? (
            <>
              {" "}
              <Link
                to={`/pages/${site.ai_notice_page}`}
                className="font-medium text-brand-700 underline dark:text-brand-300"
              >
                {t("Privacy policy")}
              </Link>
            </>
          ) : site.ai_notice_url ? (
            <>
              {" "}
              <a
                href={site.ai_notice_url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand-700 underline dark:text-brand-300"
              >
                {t("Privacy policy")}
              </a>
            </>
          ) : null}
        </p>
        <button
          type="button"
          aria-label={t("Dismiss")}
          onClick={() => {
            localStorage.setItem(key, stamp);
            setDismissed(true);
          }}
          className="-mr-1 shrink-0 rounded-lg p-1 text-slate-500 transition-colors hover:bg-brand-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-brand-900/50"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [whoami, setWhoami] = useState<Whoami | null>(null);
  const [site, setSite] = useState<SitePublic | null>(null);
  const [error, setError] = useState(false);
  const navigate = useNavigate();
  const { active: tourActive, startTour } = useTour();
  const [showWelcome, setShowWelcome] = useState(false);
  const wasTourActiveRef = useRef(false);
  const easyMode = whoami?.easy_mode ?? false;

  const setEasyMode = (easyMode: boolean) => {
    void api
      .setMode(easyMode)
      .then((res) => {
        setWhoami((prev) => (prev ? { ...prev, easy_mode: res.easy_mode } : prev));
      })
      .catch(() => {});
  };

  /** First-login onboarding (#onboarding): mark the tour seen — backend POST
   *  plus a local flag update so neither the welcome dialog nor this effect
   *  re-triggers within the session. */
  const markTourSeen = () => {
    void api.markTourSeen().catch(() => {});
    setWhoami((prev) => (prev ? { ...prev, onboarding_tour_seen: true } : prev));
  };

  // Show the welcome dialog once per session for a signed-in user who has
  // never seen the tour. Once `markTourSeen` flips the flag locally, this
  // condition no longer holds, so it cannot reopen.
  useEffect(() => {
    if (whoami?.authenticated && whoami.onboarding_tour_seen === false) {
      setShowWelcome(true);
    }
  }, [whoami?.authenticated, whoami?.onboarding_tour_seen]);

  // The tour's own end (Finish / Esc / ✕) also counts as "seen", even when
  // started straight from the ? menu without the welcome dialog ever
  // showing. TourProvider is mounted above App (TourHost, main.tsx) so its
  // `onEnd` prop isn't reachable from here — watching the active→inactive
  // transition of useTour() achieves the same thing.
  useEffect(() => {
    if (wasTourActiveRef.current && !tourActive) markTourSeen();
    wasTourActiveRef.current = tourActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourActive]);

  /** Start the tour with FRESH example-room ids: the user may have deleted
   *  (or the tour restored) the example since whoami was loaded on mount.
   *  Falls back to the current whoami if the refetch fails. Used by both entry
   *  points (welcome dialog, ? menu), which pass their `source` for the usage
   *  statistics. */
  const startTourFresh = async (mode: "easy" | "pro", source: "welcome" | "help") => {
    const opts = (w: Whoami | null) => ({
      aiEnabled: w?.ai_enabled,
      exampleRoomId: w?.example_room_id ?? null,
      exampleSetId: w?.example_set_id ?? null,
      source,
    });
    try {
      const w = await api.whoami();
      // Keep a locally-set "tour seen" flag: the welcome dialog's markTourSeen
      // POST may not have landed yet, and a stale `false` would reopen it.
      setWhoami((prev) =>
        prev?.onboarding_tour_seen ? { ...w, onboarding_tour_seen: true } : w,
      );
      startTour(mode, opts(w));
    } catch {
      startTour(mode, opts(whoami));
    }
  };

  const handleWelcomeStart = () => {
    void startTourFresh(easyMode ? "easy" : "pro", "welcome");
    setShowWelcome(false);
    markTourSeen();
  };

  const handleWelcomeSkip = () => {
    setShowWelcome(false);
    markTourSeen();
  };

  useEffect(() => {
    api.getSite().then(setSite).catch(() => setSite(null));
    api
      .whoami()
      .then((data) => {
        // Silent SSO (#19): a visitor who already has a Keycloak session is
        // logged in automatically via a one-shot prompt=none redirect; if the
        // IdP has no session the backend bounces to "/?sso=failed" and we show
        // the landing. Guards (once-per-tab flag + ?sso marker, also set on
        // logout) prevent redirect loops and re-login right after logging out.
        if (!data.authenticated && shouldTrySilentLogin()) {
          sessionStorage.setItem("ssoTried", "1");
          rememberRedirect(currentPath());
          window.location.assign(silentLoginUrl);
          return; // navigating away — keep whoami null (loading)
        }
        setWhoami(data);
        // Content-i18n (#33 MR2): the canonical authoring language and
        // whether machine-translation pre-fill is on, for `localizedText`.
        setDefaultContentLang(data.content_default_language);
        setTranslationEnabled(data.content_translation_enabled);
        // Back from sign-in with a remembered deep link → go there, not "/".
        if (data.authenticated) {
          const target = takeRedirect();
          if (target && target !== currentPath()) navigate(target, { replace: true });
        }
      })
      .catch(() => setError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen flex-col overflow-x-clip bg-white font-sans text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-y-1 px-4 py-2 sm:gap-y-2 sm:py-3">
          <div className="flex items-center gap-2">
            <Link to="/" className="flex items-center gap-3">
              {site?.logo && (
                <>
                  <img
                    src={site.logo}
                    alt={t("Institution logo")}
                    className="h-8 w-auto max-w-[160px] object-contain"
                  />
                  <span
                    aria-hidden
                    className="h-7 w-px bg-slate-200 dark:bg-slate-700"
                  />
                </>
              )}
              <span className="text-xl font-extrabold tracking-tight">
                abstimm<span className="text-brand-700 dark:text-brand-300">BAR</span>
              </span>
            </Link>
            {site?.beta_label_enabled && (
              <BetaBadge notice={localizedText(site.beta_notice).trim()} />
            )}
          </div>
          {whoami?.authenticated ? (
            <div className="flex items-center gap-1">
              {whoami.is_staff && (
                <Link
                  to="/admin"
                  aria-label={t("Manage website")}
                  title={t("Manage website")}
                  className="rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  <Settings aria-hidden className="h-5 w-5" />
                </Link>
              )}
              <HelpMenu
                easyMode={easyMode}
                onStartTour={(mode) => void startTourFresh(mode, "help")}
              />
              <div data-tour="header.mode" className="shrink-0">
                <SegmentedControl
                  className="w-max"
                  ariaLabel={t("Mode")}
                  value={whoami.easy_mode ? "simple" : "pro"}
                  onChange={(v) => setEasyMode(v === "simple")}
                  options={[
                    { value: "simple", label: t("Simple") },
                    { value: "pro", label: t("Expert") },
                  ]}
                />
              </div>
              <UserMenu whoami={whoami} />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <a
                href={loginUrl}
                onClick={() => rememberRedirect(currentPath())}
                className="rounded-lg bg-brand-400 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-brand-500"
              >
                {t("Sign in")}
              </a>
              <PreferencesMenu onLanguageChange={(lang) => applyLangPref(lang as "de" | "en")} />
            </div>
          )}
        </div>
      </header>

      {whoami?.authenticated && site && <AiNoticeBanner site={site} whoami={whoami} />}
      {whoami?.authenticated && <GenerationStatusBar />}

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:py-8">
        {error ? (
          <EmptyState icon={Unplug} title={t("Backend unreachable")}>
            <Trans
              i18nKey="Is <code>docker compose up</code> running?"
              components={{ code: <code /> }}
            />
          </EmptyState>
        ) : (
          <Outlet context={{ whoami, site, setEasyMode }} />
        )}
      </main>

      <Footer />

      {showWelcome && (
        <WelcomeDialog onStart={handleWelcomeStart} onSkip={handleWelcomeSkip} />
      )}
    </div>
  );
}

/** Index route: rooms for signed-in staff, the landing page otherwise. */
export function Home() {
  const { t } = useTranslation();
  const { whoami, site } = useApp();
  if (!whoami) return null;
  if (whoami.authenticated) return <RoomsPage />;
  const landingText = localizedText(site?.landing_text);
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <JoinByCode />
      </div>
      {landingText ? (
        <RichText html={landingText} />
      ) : (
        <EmptyState icon={BarChart3} title={t("Live quizzes and polls for teaching")}>
          <p>
            {t(
              "abstimmBAR runs anonymous live votes in your lectures — single and multiple choice, word clouds, Likert scales, free text and ranking — shown live in presentation mode or worked through as a self-paced quiz.",
            )}
          </p>
          <p className="mt-2">
            {t(
              "Taking part never needs an account: join with a room code or QR code above. Sign in only to create your own rooms and question sets.",
            )}
          </p>
        </EmptyState>
      )}
    </div>
  );
}

/** Gate for the authoring pages: redirect anonymous visitors to the landing. */
export function RequireAuth() {
  const ctx = useApp();
  if (!ctx.whoami) return null; // still loading
  if (!ctx.whoami.authenticated) return <Navigate to="/" replace />;
  return <Outlet context={ctx} />;
}
