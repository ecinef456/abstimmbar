// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): the handbook inside the app (? menu → Handbook, /handbook).
 *  The server compiles backend/quizbar/handbook/handbook.typ to HTML; this
 *  page shows it with a table of contents that follows the reading position
 *  (chapters, and the sections of the current chapter). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronDown, FileDown, Loader2 } from "lucide-react";
import { API_BASE_URL, quizbar } from "../api";
import HomeCrumb from "../components/HomeCrumb";

type Heading = { id: string; text: string; level: 2 | 3; chapter: number };

function slug(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

const CSS = `
.hb-content { color: rgb(51 65 85); font-size: 0.95rem; line-height: 1.65; }
.dark .hb-content { color: rgb(203 213 225); }
.hb-content > * + * { margin-top: 0.75rem; }
.hb-content h2 { margin-top: 3rem; padding-bottom: 0.4rem; border-bottom: 2px solid #2c7a45;
  font-size: 1.5rem; font-weight: 700; color: #2c7a45; scroll-margin-top: 4rem; }
.dark .hb-content h2 { color: #8fd6a2; border-color: #2c7a45; }
.hb-content h2:first-of-type { margin-top: 1.5rem; }
.hb-content h3 { margin-top: 1.75rem; font-size: 1.1rem; font-weight: 650; color: rgb(15 23 42); scroll-margin-top: 4rem; }
@media (min-width: 1024px) { .hb-content h2, .hb-content h3 { scroll-margin-top: 1rem; } }
.dark .hb-content h3 { color: rgb(241 245 249); }
.hb-content h4 { margin-top: 1.25rem; font-weight: 650; color: #2c7a45; }
.dark .hb-content h4 { color: #8fd6a2; }
.hb-content strong { font-weight: 650; color: rgb(15 23 42); }
.dark .hb-content strong { color: rgb(241 245 249); }
.hb-content a { color: #2c7a45; text-decoration: underline; text-underline-offset: 2px; }
.dark .hb-content a { color: #8fd6a2; }
.hb-content ul, .hb-content ol { padding-left: 1.4rem; }
.hb-content ul { list-style: disc; } .hb-content ol { list-style: decimal; }
.hb-content li + li { margin-top: 0.25rem; }
.hb-content code { font-family: ui-monospace, "DejaVu Sans Mono", monospace; font-size: 0.85em;
  background: rgb(241 245 249); border-radius: 0.3rem; padding: 0.05rem 0.3rem; overflow-wrap: anywhere; }
.dark .hb-content code { background: rgb(30 41 59); }
.hb-content pre { background: rgb(248 250 252); border: 1px solid rgb(226 232 240); border-radius: 0.6rem;
  padding: 0.75rem 0.9rem; overflow-x: auto; font-size: 0.85rem; line-height: 1.5; }
.dark .hb-content pre { background: rgb(15 23 42); border-color: rgb(51 65 85); }
.dark .hb-content pre span { color: inherit !important; }
.hb-content pre code { background: none; padding: 0; overflow-wrap: normal; white-space: pre; }
.hb-content kbd { display: inline-block; min-width: 1.5em; padding: 0 0.35em; border: 1px solid rgb(203 213 225);
  border-bottom-width: 2px; border-radius: 0.35rem; background: rgb(248 250 252); text-align: center;
  font-family: ui-monospace, "DejaVu Sans Mono", monospace; font-size: 0.8em; font-weight: 700; color: rgb(30 41 59);
  line-height: 1.5; vertical-align: 0.05em; }
.dark .hb-content kbd { background: rgb(30 41 59); border-color: rgb(71 85 105); color: rgb(226 232 240); }
.hb-content table { width: 100%; border-collapse: collapse; font-size: 0.9rem; display: block; overflow-x: auto; }
.hb-content th, .hb-content td { border: 1px solid rgb(226 232 240); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
.dark .hb-content th, .dark .hb-content td { border-color: rgb(51 65 85); }
.hb-content th { background: rgb(248 250 252); font-weight: 650; color: rgb(15 23 42); }
.dark .hb-content th { background: rgb(15 23 42); color: rgb(241 245 249); }
.hb-content .hb-box { border-left: 3px solid; border-radius: 0.4rem; padding: 0.6rem 0.85rem; }
.hb-content .hb-tip { background: #eefaf1; border-color: #2c7a45; }
.hb-content .hb-tip > strong:first-child { color: #2c7a45; }
.hb-content .hb-warn { background: #fff4dc; border-color: #b45309; }
.hb-content .hb-warn > strong:first-child { color: #b45309; }
.hb-content .hb-danger { background: #fde8e8; border-color: #b91c1c; }
.hb-content .hb-danger > strong:first-child { color: #b91c1c; }
.dark .hb-content .hb-tip { background: #17291e; }
.dark .hb-content .hb-tip > strong:first-child { color: #8fd6a2; }
.dark .hb-content .hb-warn { background: #33250d; }
.dark .hb-content .hb-warn > strong:first-child { color: #f5c26b; }
.dark .hb-content .hb-danger { background: #3a1e1c; }
.dark .hb-content .hb-danger > strong:first-child { color: #f0a29b; }
.hb-content .hb-step { display: flex; gap: 0.6rem; align-items: flex-start; }
.hb-content .hb-num { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 1.5rem; height: 1.5rem; margin-top: 0.1rem; border-radius: 999px; background: #2c7a45; color: #fff;
  font-size: 0.8rem; font-weight: 700; }
.hb-content .hb-step > div { min-width: 0; }
.hb-content .hb-cover table td:first-child { white-space: nowrap; }
.hb-content .hb-cover { margin-top: 0; }
.hb-content .hb-cards { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.hb-content .hb-card { border-radius: 0.6rem; padding: 0.75rem 0.9rem; background: #eefaf1; line-height: 1.8; min-width: 0; }
.hb-content .hb-card.hb-warm { background: #fff4dc; }
.dark .hb-content .hb-card { background: #17291e; }
.dark .hb-content .hb-card.hb-warm { background: #33250d; }
`;

export default function HandbookPage() {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string>("");
  const [tocOpen, setTocOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    quizbar.handbook().then(
      (data) => setHtml(data.html),
      () => setError(true),
    );
  }, []);

  // Give every chapter (h2) and section (h3) an id and list them.
  useLayoutEffect(() => {
    const root = content.current;
    if (!root || html === null) return;
    const taken = new Set<string>();
    let chapter = 0;
    const found: Heading[] = [];
    root.querySelectorAll<HTMLHeadingElement>("h2, h3").forEach((el) => {
      const level = el.tagName === "H2" ? 2 : 3;
      if (level === 2) chapter += 1;
      const text = el.textContent?.trim() ?? "";
      el.id = slug(text, taken);
      found.push({ id: el.id, text, level, chapter });
    });
    root.querySelectorAll<HTMLAnchorElement>("a[href^='http']").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    setHeadings(found);
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) document.getElementById(hash)?.scrollIntoView();
  }, [html]);

  // Follow the reading position: the last heading above the top fifth.
  useEffect(() => {
    if (headings.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.2;
      let current = headings[0].id;
      for (const heading of headings) {
        const el = document.getElementById(heading.id);
        if (el && el.getBoundingClientRect().top <= line) current = heading.id;
        else if (el) break;
      }
      // At the very end the last headings can't reach the line: take the last.
      const scroller = document.scrollingElement ?? document.documentElement;
      if (window.innerHeight + window.scrollY >= scroller.scrollHeight - 4) {
        current = headings[headings.length - 1].id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [headings]);

  const activeChapter = headings.find((h) => h.id === active)?.chapter ?? 1;
  const chapters = useMemo(() => headings.filter((h) => h.level === 2), [headings]);

  function go(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    window.history.replaceState(null, "", `#${id}`);
    setTocOpen(false);
  }

  const toc = (
    <nav aria-label={t("Contents")}>
      <ol className="grid gap-0.5 text-sm">
        {chapters.map((chapter) => {
          const current = chapter.chapter === activeChapter;
          const sections = headings.filter((h) => h.level === 3 && h.chapter === chapter.chapter);
          return (
            <li key={chapter.id}>
              <button
                type="button"
                onClick={() => go(chapter.id)}
                aria-current={active === chapter.id ? "location" : undefined}
                className={`flex w-full gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  current
                    ? "bg-brand-50 font-semibold text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                }`}
              >
                <span className="w-4 shrink-0 text-right tabular-nums text-slate-400">{chapter.chapter}</span>
                <span className="min-w-0">{chapter.text}</span>
              </button>
              {current && sections.length > 0 && (
                <ol className="mb-1 ml-6 mt-0.5 grid gap-0.5 border-l border-slate-200 pl-2 dark:border-slate-700">
                  {sections.map((section) => (
                    <li key={section.id}>
                      <button
                        type="button"
                        onClick={() => go(section.id)}
                        aria-current={active === section.id ? "location" : undefined}
                        className={`w-full rounded-md px-2 py-1 text-left text-[0.8rem] leading-snug transition-colors ${
                          active === section.id
                            ? "font-semibold text-brand-700 dark:text-brand-300"
                            : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                        }`}
                      >
                        {section.text}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );

  return (
    <div>
      <style>{CSS}</style>
      <nav className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        <HomeCrumb /> / {t("Handbook")}
      </nav>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <BookOpen aria-hidden className="h-6 w-6 text-brand-600 dark:text-brand-400" />
          {t("Handbook")}
        </h1>
        <a
          href={`${API_BASE_URL}/api/quizbar/handbook/?pdf=1`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
        >
          <FileDown aria-hidden className="h-4 w-4" />
          {t("PDF")}
        </a>
      </div>

      {error && <p className="text-sm text-danger">{t("The handbook could not be loaded.")}</p>}
      {html === null && !error && (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          {t("Loading …")}
        </p>
      )}

      {/* phones / narrow windows: the contents fold away on top */}
      {chapters.length > 0 && (
        <div className="sticky top-0 z-10 -mx-4 mb-2 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-950/95">
          <button
            type="button"
            onClick={() => setTocOpen((open) => !open)}
            aria-expanded={tocOpen}
            className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium"
          >
            <span className="min-w-0 truncate">
              <span className="text-slate-400">{t("Contents")} · </span>
              {chapters.find((c) => c.chapter === activeChapter)?.text}
            </span>
            <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 transition-transform ${tocOpen ? "rotate-180" : ""}`} />
          </button>
          {tocOpen && <div className="mt-2 max-h-[60vh] overflow-y-auto pb-1">{toc}</div>}
        </div>
      )}

      <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
        <aside className="hidden lg:block">
          <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pb-6 pr-1">
            <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t("Contents")}
            </p>
            {toc}
          </div>
        </aside>
        <article
          ref={content}
          className="hb-content min-w-0 pb-24"
          // Our own handbook, compiled by our own server from the repository.
          dangerouslySetInnerHTML={html === null ? undefined : { __html: html }}
        />
      </div>
    </div>
  );
}
