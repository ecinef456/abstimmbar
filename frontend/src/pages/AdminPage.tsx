// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Staff-only site administration: branding (logo + landing text) and the
 * footer page CMS (Impressum, Datenschutz, free pages). Guarded by is_staff;
 * every endpoint is additionally server-side gated (accounts.IsAdmin). */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronUp, FileText, Lock, Radio, Trash2 } from "lucide-react";
import { api, type AdminStats, type LtiPlatform, type LtiToolInfo, type ManagePage, type ManageSite } from "../api";
import { useApp } from "../App";
import { localizedText, type LocalizedText, TranslationControlsSlot } from "@basicbar/ui";
import Donut, { type DonutSegment } from "../components/Donut";
import HomeCrumb from "../components/HomeCrumb";
import MiniChart, { type ChartSeries } from "../components/MiniChart";
import TranslatableField from "../components/TranslatableField";
import { Button, ConfirmInline, EmptyState, Field, InfoHint, Select, SegmentedControl, TextInput } from "../components/ui";
import { proTour, RESTORE_STEP } from "../tour/steps";

const SET_TYPE_LABELS: Record<string, string> = {
  live_poll: "Live poll",
  self_paced: "Self-paced quiz",
  self_check: "Self-check",
};
/** Tour step id → title key, for the "aborted at step" table. */
const TOUR_STEP_TITLES = new Map([...proTour, RESTORE_STEP].map((s) => [s.id, s.titleKey]));
const KIND_LABELS: Record<string, string> = {
  single_choice: "Single Choice",
  multiple_choice: "Multiple Choice",
  word_cloud: "Word cloud",
  likert: "Likert scale",
  open_text: "Free text",
  priorities: "Priorities",
  ordering: "Ordering",
  mindmap: "Mind map",
};
// Literal Tailwind colour classes (so the JIT emits them) for chart segments.
const PALETTE = [
  { stroke: "stroke-brand-500", dot: "bg-brand-500", fill: "fill-brand-500" },
  { stroke: "stroke-sky-500", dot: "bg-sky-500", fill: "fill-sky-500" },
  { stroke: "stroke-amber-500", dot: "bg-amber-500", fill: "fill-amber-500" },
  { stroke: "stroke-violet-500", dot: "bg-violet-500", fill: "fill-violet-500" },
  { stroke: "stroke-rose-500", dot: "bg-rose-500", fill: "fill-rose-500" },
  { stroke: "stroke-emerald-500", dot: "bg-emerald-500", fill: "fill-emerald-500" },
  { stroke: "stroke-orange-500", dot: "bg-orange-500", fill: "fill-orange-500" },
  { stroke: "stroke-teal-500", dot: "bg-teal-500", fill: "fill-teal-500" },
];

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[äàá]/g, "a").replace(/[öòó]/g, "o").replace(/[üùú]/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export default function AdminPage() {
  const { t } = useTranslation();
  const { whoami } = useApp();
  if (!whoami) return null;
  if (!whoami.is_staff) {
    return (
      <EmptyState icon={Lock} title={t("No access")}>
        {t("This area is only for administrators.")}
      </EmptyState>
    );
  }
  return <AdminTabs />;
}

const SETTINGS_SECTIONS = ["appearance", "texts", "pages", "ai", "lms"] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

function AdminTabs() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "settings" ? "settings" : "stats";
  const sectionParam = searchParams.get("section");
  const section: SettingsSection =
    SETTINGS_SECTIONS.find((id) => id === sectionParam) ?? "appearance";

  function selectTab(next: "stats" | "settings") {
    if (next === "settings") setSearchParams({ tab: "settings", section });
    else setSearchParams({});
  }

  function selectSection(id: SettingsSection) {
    setSearchParams({ tab: "settings", section: id }, { replace: true });
  }

  const items: { id: SettingsSection; label: string }[] = [
    { id: "appearance", label: t("Appearance") },
    { id: "texts", label: t("Texts") },
    { id: "pages", label: t("Pages") },
    { id: "ai", label: t("AI") },
    { id: "lms", label: t("LMS (LTI)") },
  ];

  return (
    <div className="space-y-8">
      <div>
        <nav className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          <HomeCrumb /> / {t("Manage website")}
        </nav>
        <h1 className="mb-4 text-2xl font-bold">{t("Manage website")}</h1>
        <SegmentedControl
          ariaLabel={t("Admin section")}
          value={tab}
          onChange={(v) => selectTab(v)}
          options={[
            { value: "stats", label: t("Statistics") },
            { value: "settings", label: t("Settings") },
          ]}
        />
      </div>
      {tab === "stats" ? (
        <StatsSection />
      ) : (
        <div className="md:grid md:grid-cols-[12rem_1fr] md:gap-8">
          <nav aria-label={t("Settings sections")} className="mb-6 md:mb-0">
            <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={section === item.id ? "page" : undefined}
                    onClick={() => selectSection(item.id)}
                    className={`w-full whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                      section === item.id
                        ? "bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-200"
                        : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    }`}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="min-w-0">
            {section === "appearance" && <AppearanceSettings />}
            {section === "texts" && <TextsSettings />}
            {section === "pages" && <PagesSection />}
            {section === "ai" && <AiSettings />}
            {section === "lms" && <LtiPlatformsSection />}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white/60 p-4 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
      <div className="text-sm text-slate-600 dark:text-slate-300">{label}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

/** Tile showing two related counts (created vs conducted). */
function DualTile({
  label,
  a,
  aLabel,
  b,
  bLabel,
}: {
  label: string;
  a: number;
  aLabel: string;
  b: number;
  bLabel: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white/60 p-4 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">{label}</div>
      <div className="flex gap-5">
        <div>
          <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">{a}</div>
          <div className="text-xs text-slate-400">{aLabel}</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">{b}</div>
          <div className="text-xs text-slate-400">{bLabel}</div>
        </div>
      </div>
    </div>
  );
}

function toSegments(
  data: Record<string, number>,
  labels: Record<string, string>,
  t: (k: string) => string,
): DonutSegment[] {
  return Object.entries(data).map(([key, value], i) => ({
    label: labels[key] ? t(labels[key]) : key,
    value,
    strokeClass: PALETTE[i % PALETTE.length].stroke,
    dotClass: PALETTE[i % PALETTE.length].dot,
  }));
}

function StatsSection() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [days, setDays] = useState(30);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const opts = from ? { from, to: to || undefined } : { days };
    void api.adminStats(opts).then(setStats).catch(() => setStats(null));
  }, [days, from, to]);

  if (!stats) return null;
  const { totals, daily } = stats;
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const createdSets = sum(totals.sets_by_type);
  const presentedSets = sum(totals.runs_by_type);
  const createdQuestions = sum(totals.questions_by_kind);
  const tourStarts = sum(totals.tour.started);
  const tourCompleted = sum(totals.tour.completed);

  const bar = (points: { date: string; n: number }[], c = PALETTE[0]): ChartSeries[] => [
    { label: "", fillClass: c.fill, dotClass: c.dot, points: points.map((p) => ({ date: p.date, value: p.n })) },
  ];

  return (
    <div className="space-y-8">
      {/* All-time totals — not affected by the time range below. */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">{t("Overview (all time)")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Tile label={t("Rooms")} value={totals.rooms} sub={t("of which via LTI: {{n}}", { n: totals.rooms_lti })} />
          <Tile label={t("Users")} value={totals.users} />
          <DualTile
            label={t("Sets")}
            a={createdSets}
            aLabel={t("created")}
            b={presentedSets}
            bLabel={t("conducted")}
          />
          <DualTile
            label={t("Questions")}
            a={createdQuestions}
            aLabel={t("created")}
            b={totals.questions_run}
            bLabel={t("conducted")}
          />
          <Tile label={t("Participants")} value={totals.participants} />
        </div>
        <div className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
          <Donut title={t("Created sets by type")} segments={toSegments(totals.sets_by_type, SET_TYPE_LABELS, t)} />
          <Donut title={t("Created questions by kind")} segments={toSegments(totals.questions_by_kind, KIND_LABELS, t)} />
          <Donut title={t("Presented sets by type")} segments={toSegments(totals.runs_by_type, SET_TYPE_LABELS, t)} />
          <Donut
            title={t("Sessions by mode")}
            segments={[
              { label: t("Simple"), value: totals.sessions_by_mode.easy, strokeClass: PALETTE[0].stroke, dotClass: PALETTE[0].dot },
              { label: t("Expert"), value: totals.sessions_by_mode.pro, strokeClass: PALETTE[1].stroke, dotClass: PALETTE[1].dot },
            ]}
          />
        </div>
      </section>

      {/* Guided tour usage (all time) — anonymous TourEvent counts. */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">{t("Guided tour")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile
            label={t("Starts")}
            value={tourStarts}
            sub={t("Simple {{easy}} · Expert {{pro}}", totals.tour.started)}
          />
          <Tile
            label={t("Completed")}
            value={tourCompleted}
            sub={tourStarts > 0 ? t("{{percent}} % of starts", { percent: Math.round((100 * tourCompleted) / tourStarts) }) : undefined}
          />
          <Tile label={t("Aborted")} value={sum(totals.tour.aborted)} />
          <Tile label={t("Users who know the tour")} value={totals.tour.users_seen} sub={t("started or dismissed")} />
        </div>
        <div className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2">
          <Donut
            title={t("Tour starts by source")}
            segments={[
              { label: t("Welcome dialog"), value: totals.tour.by_source.welcome, strokeClass: PALETTE[0].stroke, dotClass: PALETTE[0].dot },
              { label: t("? menu"), value: totals.tour.by_source.help, strokeClass: PALETTE[1].stroke, dotClass: PALETTE[1].dot },
            ]}
          />
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{t("Tour aborted at step")}</h3>
            {totals.tour.aborted_at.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t("No aborts yet")}</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {totals.tour.aborted_at.map((row) => {
                    const titleKey = TOUR_STEP_TITLES.get(row.step);
                    return (
                      <tr key={row.step} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-1.5">{titleKey ? t(titleKey) : row.step}</td>
                        <td className="py-1.5 text-right tabular-nums">{row.n}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {/* Time series — windowed by the range control. */}
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-lg font-semibold">{t("Over time")}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {[30, 90].map((d) => (
              <Button
                key={d}
                variant={!from && days === d ? "primary" : "ghost"}
                onClick={() => {
                  setFrom("");
                  setTo("");
                  setDays(d);
                }}
              >
                {t("Last {{days}} days", { days: d })}
              </Button>
            ))}
            <label className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
              {t("From")}
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
              {t("To")}
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>
        </div>
        <div className="space-y-6">
          <MiniChart title={t("New rooms per day")} series={bar(daily.rooms, PALETTE[0])} />
          <MiniChart title={t("New users per day")} series={bar(daily.users, PALETTE[1])} />
          <MiniChart title={t("Questions run per day")} series={bar(daily.questions_run, PALETTE[2])} />
          <MiniChart title={t("Participants per day")} series={bar(daily.participants, PALETTE[3])} />
          <MiniChart
            title={t("Presented sets per day")}
            series={[
              { label: t("Live poll"), fillClass: PALETTE[0].fill, dotClass: PALETTE[0].dot, points: daily.runs_by_type.map((p) => ({ date: p.date, value: p.live_poll })) },
              { label: t("Self-paced quiz"), fillClass: PALETTE[1].fill, dotClass: PALETTE[1].dot, points: daily.runs_by_type.map((p) => ({ date: p.date, value: p.self_paced })) },
              { label: t("Self-check"), fillClass: PALETTE[2].fill, dotClass: PALETTE[2].dot, points: daily.runs_by_type.map((p) => ({ date: p.date, value: p.self_check })) },
            ]}
          />
          <MiniChart
            title={t("Guided tour per day")}
            series={[
              // Stacked: completed + started-not-completed = starts (header total).
              { label: t("Completed"), fillClass: PALETTE[1].fill, dotClass: PALETTE[1].dot, points: daily.tour.map((p) => ({ date: p.date, value: p.completed })) },
              { label: t("Started, not completed"), fillClass: PALETTE[0].fill, dotClass: PALETTE[0].dot, points: daily.tour.map((p) => ({ date: p.date, value: Math.max(0, p.started - p.completed) })) },
            ]}
          />
        </div>
      </section>
    </div>
  );
}

function SavedRow({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button variant="primary" onClick={onSave}>
        {t("Save")}
      </Button>
      <span aria-live="polite" className="text-xs text-brand-700 dark:text-brand-300">
        {saved ? t("Saved.") : ""}
      </span>
    </div>
  );
}

function AppearanceSettings() {
  const { t } = useTranslation();
  const [site, setSite] = useState<ManageSite | null>(null);
  const [betaEnabled, setBetaEnabled] = useState(false);
  const [betaNotice, setBetaNotice] = useState<LocalizedText>("");
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.getManageSite().then((data) => {
      setSite(data);
      setBetaEnabled(data.beta_label_enabled);
      setBetaNotice(data.beta_notice);
    });
  }, []);

  async function save() {
    const updated = await api.updateSite({
      beta_label_enabled: betaEnabled,
      beta_notice: betaNotice,
    });
    setSite(updated);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  async function upload(file: File) {
    setSite(await api.uploadLogo(file));
  }

  async function removeLogo() {
    await api.deleteLogo();
    setSite(site ? { ...site, logo: null } : site);
  }

  if (!site) return null;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">{t("Appearance")}</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {t("Logo and optional Beta label in the header.")}
      </p>

      <Field label={t("Logo (shown top left; PNG, JPG or SVG)")}>
        <div className="flex flex-wrap items-center gap-4">
          {site.logo ? (
            <img
              src={site.logo}
              alt={t("Current logo")}
              className="h-10 w-auto max-w-[180px] rounded border border-slate-200 bg-white p-1 dark:border-slate-700"
            />
          ) : (
            <span className="text-sm text-slate-400">{t("No logo — “abstimmBAR” wordmark")}</span>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.svg"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
          <Button onClick={() => fileInput.current?.click()}>
            {site.logo ? t("Replace logo") : t("Upload logo")}
          </Button>
          {site.logo && (
            <Button variant="danger" onClick={() => void removeLogo()}>
              {t("Remove")}
            </Button>
          )}
        </div>
      </Field>

      <div className="mt-6 max-w-2xl">
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={betaEnabled}
            onChange={(event) => setBetaEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
          />
          {t("Show beta label")}
        </label>
        {betaEnabled && (
          <div className="mt-3">
            {/* Phones: the translation controls dock here instead of floating. */}
            <TranslationControlsSlot className="mb-2" />
            <TranslatableField
              label={t("Beta label notice (optional)")}
              value={betaNotice}
              onChange={setBetaNotice}
              placeholder={t("e.g. Trial operation — please report problems to …")}
              hint={t("Shown when the Beta badge in the header is clicked. Leave empty for a plain badge.")}
            />
          </div>
        )}
        <SavedRow onSave={() => void save()} saved={saved} />
      </div>
    </section>
  );
}

function TextsSettings() {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState<LocalizedText>("");
  const [closing, setClosing] = useState<LocalizedText>("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.getManageSite().then((data) => {
      setText(data.landing_text);
      setClosing(data.closing_info);
      setLoaded(true);
    });
  }, []);

  async function save() {
    await api.updateSite({ landing_text: text, closing_info: closing });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  if (!loaded) return null;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">{t("Texts")}</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {t("Texts shown before login and to participants after every vote.")}
      </p>
      <TranslationControlsSlot className="mb-4" />
      <div className="max-w-2xl">
        <div className="mb-4">
          <TranslatableField
            variant="rich"
            label={t("Landing page text before login")}
            value={text}
            onChange={setText}
          />
        </div>
        <TranslatableField
          variant="rich"
          label={t("Closing info for all rooms")}
          value={closing}
          onChange={setClosing}
          placeholder={t("Shown to participants after every vote — e.g. contact, feedback link …")}
        />
        <SavedRow onSave={() => void save()} saved={saved} />
      </div>
    </section>
  );
}

function AiSettings() {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [aiNotice, setAiNotice] = useState<LocalizedText>("");
  const [aiNoticePage, setAiNoticePage] = useState("");
  const [aiNoticeUrl, setAiNoticeUrl] = useState("");
  const [selfCheckAiPerMinute, setSelfCheckAiPerMinute] = useState(30);
  const [pages, setPages] = useState<ManagePage[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.getManageSite().then((data) => {
      setAiNotice(data.ai_notice);
      setAiNoticePage(data.ai_notice_page ?? "");
      setAiNoticeUrl(data.ai_notice_url);
      setSelfCheckAiPerMinute(data.self_check_ai_per_minute ?? 30);
      setLoaded(true);
    });
    void api.listManagePages().then(setPages);
  }, []);

  async function save() {
    await api.updateSite({
      ai_notice: aiNotice,
      ai_notice_page: aiNoticePage || null,
      ai_notice_url: aiNoticeUrl,
      self_check_ai_per_minute: selfCheckAiPerMinute,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  if (!loaded) return null;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">{t("AI")}</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {t("Privacy notice and limits for the AI features.")}
      </p>
      <TranslationControlsSlot className="mb-4" />
      <div className="max-w-2xl">
        <TranslatableField
          label={t("AI privacy notice")}
          value={aiNotice}
          onChange={setAiNotice}
          placeholder={t("e.g. An external model processes uploaded material.")}
          hint={t("Shown as a one-time banner while the AI features are available. Leave empty for no banner.")}
        />
        <div className="mt-3">
          <Field label={t("Privacy policy page (internal)")}>
            <Select
              value={aiNoticePage}
              onChange={(event) => setAiNoticePage(event.target.value)}
            >
              <option value="">{t("— none —")}</option>
              {pages
                .filter((page) => page.is_published)
                .map((page) => (
                  <option key={page.slug} value={page.slug}>
                    {localizedText(page.title)}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="mt-3">
          <Field label={t("…or external privacy policy URL")}>
            <TextInput
              type="url"
              value={aiNoticeUrl}
              onChange={(event) => setAiNoticeUrl(event.target.value)}
              placeholder="https://…"
              disabled={!!aiNoticePage}
            />
          </Field>
        </div>
        <div className="mt-3">
          {/* Explanation behind an (i) button: the label alone doesn't say
              what is limited or what learners see beyond the limit. */}
          <div className="mb-1 flex items-center gap-1.5">
            <label
              htmlFor="ai-limit"
              className="text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              {t("AI gradings per minute per self-check (0 = unlimited)")}
            </label>
            <InfoHint
              text={t(
                "Limits how many free-text answers the AI assesses per self-check within 60 seconds. Beyond that, learners see the model solution instead of an AI assessment. Useful for paid external AI services; 0 = unlimited (fine for a local model).",
              )}
            />
          </div>
          <TextInput
            id="ai-limit"
            type="number"
            min={0}
            value={String(selfCheckAiPerMinute)}
            onChange={(event) =>
              setSelfCheckAiPerMinute(Math.max(0, parseInt(event.target.value, 10) || 0))
            }
            className="!w-32"
          />
        </div>
        <SavedRow onSave={() => void save()} saved={saved} />
      </div>
    </section>
  );
}

function PagesSection() {
  const { t } = useTranslation();
  const [pages, setPages] = useState<ManagePage[] | null>(null);
  const [editing, setEditing] = useState<ManagePage | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const reload = () => api.listManagePages().then(setPages);
  useEffect(() => {
    void reload();
  }, []);

  async function move(index: number, delta: number) {
    if (!pages) return;
    const next = [...pages];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setPages(next);
    await api.reorderPages(next.map((p) => p.id));
  }

  async function handleDelete(id: number) {
    await api.deletePage(id);
    setConfirmDelete(null);
    await reload();
  }

  if (!pages) return null;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("Pages (footer)")}</h2>
        {editing === null && (
          <div className="flex items-center gap-2">
            <InfoHint
              text={t(
                "Info pages shown in the site footer (e.g. imprint or privacy policy). They belong to the whole site — not to a single room, question set or question.",
              )}
            />
            <Button variant="primary" onClick={() => setEditing("new")}>
              + {t("New page")}
            </Button>
          </div>
        )}
      </div>

      {editing !== null && (
        <PageForm
          page={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}

      {pages.length === 0 ? (
        <EmptyState icon={FileText} title={t("No pages yet")}>
          {t(
            "Legal notice and privacy policy are created as drafts on first start — edit and publish them here.",
          )}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {pages.map((page, index) => (
            <li key={page.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex flex-col">
                <button
                  type="button"
                  aria-label={t("Move up")}
                  disabled={index === 0}
                  onClick={() => void move(index, -1)}
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                >
                  <ChevronUp aria-hidden className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={t("Move down")}
                  disabled={index === pages.length - 1}
                  onClick={() => void move(index, 1)}
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                >
                  <ChevronDown aria-hidden className="h-4 w-4" />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {localizedText(page.title)}
                </span>
                <span className="ml-2 font-mono text-xs text-slate-400">/{page.slug}</span>
                <div className="mt-0.5 flex gap-1.5">
                  <Badge on={page.is_published} on_label={t("Published")} off_label={t("Draft")} />
                </div>
              </div>
              <Button onClick={() => setEditing(page)}>{t("Edit")}</Button>
              {confirmDelete === page.id ? (
                <ConfirmInline
                  message={t("Delete page?")}
                  onConfirm={() => void handleDelete(page.id)}
                  onCancel={() => setConfirmDelete(null)}
                />
              ) : (
                <Button
                  variant="ghost"
                  aria-label={t("Delete {{title}}", { title: localizedText(page.title) })}
                  onClick={() => setConfirmDelete(page.id)}
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** LTI 1.3 platform registration (M4): connect LMS instances that may
 * launch into abstimmbar. Modeled on PagesSection (list + add/edit form +
 * delete confirm), plus a read-only panel with this deployment's endpoints. */
function LtiPlatformsSection() {
  const { t } = useTranslation();
  const [platforms, setPlatforms] = useState<LtiPlatform[] | null>(null);
  const [toolInfo, setToolInfo] = useState<LtiToolInfo | null>(null);
  const [editing, setEditing] = useState<LtiPlatform | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const reload = () => api.listLtiPlatforms().then((data) => setPlatforms(data.results));
  useEffect(() => {
    void reload();
    void api.getLtiToolInfo().then(setToolInfo);
  }, []);

  async function handleDelete(id: number) {
    await api.deleteLtiPlatform(id);
    setConfirmDelete(null);
    await reload();
  }

  async function toggleActive(platform: LtiPlatform) {
    await api.updateLtiPlatform(platform.id, { is_active: !platform.is_active });
    await reload();
  }

  if (!platforms) return null;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("LTI platforms")}</h2>
        {editing === null && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            + {t("Add platform")}
          </Button>
        )}
      </div>

      {toolInfo && (
        <div className="mb-4 max-w-2xl rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
          <h3 className="mb-2 font-semibold">{t("Tool endpoints")}</h3>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            {t("Enter these URLs in your LMS (see the guide).")}
          </p>
          <div className="grid gap-2">
            <Field label={t("Initiate login URL")}>
              <TextInput readOnly value={toolInfo.login_url} onFocus={(e) => e.target.select()} />
            </Field>
            <Field label={t("Launch URL")}>
              <TextInput readOnly value={toolInfo.launch_url} onFocus={(e) => e.target.select()} />
            </Field>
            <Field label={t("Keyset URL")}>
              <TextInput readOnly value={toolInfo.jwks_url} onFocus={(e) => e.target.select()} />
            </Field>
            <Field label={t("Icon URL")}>
              <TextInput readOnly value={toolInfo.icon_url} onFocus={(e) => e.target.select()} />
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {t("Enter as the tool's icon URL in your LMS.")}
              </p>
            </Field>
          </div>
        </div>
      )}

      {editing !== null && (
        <LtiPlatformForm
          platform={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}

      {platforms.length === 0 ? (
        <EmptyState icon={Radio} title={t("No platforms yet")}>
          {t("Register the LMS instances that may launch into abstimmbar here.")}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {platforms.map((platform) => (
            <li key={platform.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {platform.name}
                </span>
                <span className="ml-2 font-mono text-xs text-slate-400">{platform.issuer}</span>
                <div className="mt-0.5 flex gap-1.5">
                  <Badge on={platform.is_active} on_label={t("Active")} off_label={t("Inactive")} />
                  {platform.link_by_email && (
                    <Badge on on_label={t("Link users by email")} off_label="" />
                  )}
                </div>
              </div>
              {/* Keep the actions on their own line on mobile and let them keep
                  their natural width instead of being squeezed thin (#64). */}
              <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                <Button className="whitespace-nowrap" onClick={() => void toggleActive(platform)}>
                  {platform.is_active ? t("Deactivate") : t("Activate")}
                </Button>
                <Button className="whitespace-nowrap" onClick={() => setEditing(platform)}>{t("Edit")}</Button>
                {confirmDelete === platform.id ? (
                  <ConfirmInline
                    message={t("Delete platform?")}
                    onConfirm={() => void handleDelete(platform.id)}
                    onCancel={() => setConfirmDelete(null)}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    aria-label={t("Delete {{title}}", { title: platform.name })}
                    onClick={() => setConfirmDelete(platform.id)}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LtiPlatformForm({
  platform,
  onCancel,
  onSaved,
}: {
  platform: LtiPlatform | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(platform?.name ?? "");
  const [issuer, setIssuer] = useState(platform?.issuer ?? "");
  const [clientId, setClientId] = useState(platform?.client_id ?? "");
  const [authLoginUrl, setAuthLoginUrl] = useState(platform?.auth_login_url ?? "");
  const [authTokenUrl, setAuthTokenUrl] = useState(platform?.auth_token_url ?? "");
  const [keySetUrl, setKeySetUrl] = useState(platform?.key_set_url ?? "");
  const [deploymentIds, setDeploymentIds] = useState(
    platform?.deployment_ids.join(", ") ?? "",
  );
  // On add, default to true — but the warning below makes the trade-off clear.
  const [linkByEmail, setLinkByEmail] = useState(platform?.link_by_email ?? true);
  const [isActive, setIsActive] = useState(platform?.is_active ?? true);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const data = {
      name,
      issuer,
      client_id: clientId,
      auth_login_url: authLoginUrl,
      auth_token_url: authTokenUrl,
      key_set_url: keySetUrl,
      deployment_ids: deploymentIds.split(",").map((s) => s.trim()).filter(Boolean),
      link_by_email: linkByEmail,
      is_active: isActive,
    };
    try {
      if (platform) await api.updateLtiPlatform(platform.id, data);
      else await api.createLtiPlatform(data);
      onSaved();
    } catch (err) {
      try {
        const parsed = JSON.parse((err as Error).message);
        const value = parsed.detail ?? Object.values(parsed)[0];
        setError(Array.isArray(value) ? value[0] : String(value));
      } catch {
        setError(String(err));
      }
    }
  }

  return (
    <div className="mb-6 max-w-2xl rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-900 dark:bg-brand-950/40">
      <h3 className="mb-3 font-semibold">{platform ? t("Edit platform") : t("Add platform")}</h3>
      <div className="grid gap-3">
        <Field label={t("Name")}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label={t("Issuer")}>
          <TextInput value={issuer} onChange={(e) => setIssuer(e.target.value)} required />
        </Field>
        <Field label={t("Client ID")}>
          <TextInput value={clientId} onChange={(e) => setClientId(e.target.value)} required />
        </Field>
        <Field label={t("Auth login URL")}>
          <TextInput value={authLoginUrl} onChange={(e) => setAuthLoginUrl(e.target.value)} required />
        </Field>
        <Field label={t("Auth token URL")}>
          <TextInput value={authTokenUrl} onChange={(e) => setAuthTokenUrl(e.target.value)} required />
        </Field>
        <Field label={t("Keyset URL")}>
          <TextInput value={keySetUrl} onChange={(e) => setKeySetUrl(e.target.value)} required />
        </Field>
        <Field label={t("Deployment IDs (comma-separated)")}>
          <TextInput value={deploymentIds} onChange={(e) => setDeploymentIds(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={linkByEmail}
            onChange={(event) => setLinkByEmail(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
          />
          {t("Link users by email")}
        </label>
        {linkByEmail && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t(
              "The LMS becomes the authority for account matching — enable only for trusted LMS.",
            )}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
          />
          {t("Active")}
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void save()}>
            {t("Save")}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t("Cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Badge({
  on,
  on_label,
  off_label,
}: {
  on: boolean;
  on_label: string;
  off_label: string;
}) {
  const label = on ? on_label : off_label;
  if (!label) return null;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        on
          ? "bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-200"
          : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
      }`}
    >
      {label}
    </span>
  );
}

function PageForm({
  page,
  onCancel,
  onSaved,
}: {
  page: ManagePage | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState<LocalizedText>(page?.title ?? "");
  const [slug, setSlug] = useState(page?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(page !== null);
  const [body, setBody] = useState<LocalizedText>(page?.body ?? "");
  const [published, setPublished] = useState(page?.is_published ?? false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const data = {
      title,
      slug: (slugTouched ? slug : slugify(localizedText(title))).trim(),
      body,
      is_published: published,
      // In Abstimmbar every info page is a footer page (#62): there are no
      // other page kinds, so this is always true rather than a UI toggle.
      show_in_footer: true,
    };
    try {
      if (page) await api.updatePage(page.id, data);
      else await api.createPage(data);
      onSaved();
    } catch (err) {
      try {
        const parsed = JSON.parse((err as Error).message);
        const value = parsed.detail ?? Object.values(parsed)[0];
        setError(Array.isArray(value) ? value[0] : String(value));
      } catch {
        setError(String(err));
      }
    }
  }

  return (
    <div className="mb-6 max-w-2xl rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-900 dark:bg-brand-950/40">
      <h3 className="mb-3 font-semibold">{page ? t("Edit page") : t("New page")}</h3>
      <div className="grid gap-3">
        <TranslationControlsSlot />
        <TranslatableField
          label={t("Title")}
          required
          value={title}
          onChange={(next) => {
            setTitle(next);
            if (!slugTouched) setSlug(slugify(localizedText(next)));
          }}
        />
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              {t("Address (slug)")}
            </span>
            <InfoHint
              text={t(
                "The web address the page is reached under (e.g. …/imprint). Use short lowercase words without spaces — it is filled in from the title automatically.",
              )}
            />
          </div>
          <TextInput
            value={slug}
            onChange={(event) => {
              setSlugTouched(true);
              setSlug(event.target.value);
            }}
            placeholder={t("e.g. imprint")}
          />
        </div>
        <TranslatableField
          variant="rich"
          label={t("Content")}
          value={body}
          onChange={setBody}
        />
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={published}
              onChange={(event) => setPublished(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
            />
            {t("Published (otherwise draft only, not visible to the public)")}
          </label>
          <InfoHint
            text={t(
              "Only published pages are visible to visitors in the footer. Leave this off to keep the page as a draft while you work on it.",
            )}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void save()}>
            {t("Save")}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t("Cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
