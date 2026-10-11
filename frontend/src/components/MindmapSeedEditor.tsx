// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Outline editor for a mindmap question's predefined branches (stage 1).
 * Mirrors the participant interaction model: an indented list below the
 * root, "+" adds a child term, × removes a term (with its sub-branches).
 * Terms (max. 60 characters) and descriptions are bilingual `{de, en}` maps:
 * one DE | EN switch (styled like TranslatableField's tabs) flips every input
 * to that language; a missing translation shows the canonical text as
 * placeholder, and "Translate" pre-fills empty fields of the active language
 * via the translation service. Each field also registers with the global
 * "translate all" pill. Levels count from the root's children (1) down to
 * the question's depth. */
import { useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { Languages, Plus, X } from "lucide-react";
import {
  MAX_TRANSLATE_LENGTH,
  SUPPORTED_LANGUAGES,
  defaultContentLangLabel,
  getDefaultContentLang,
  isTranslationEnabled,
  localizedMap,
  useTranslationForm,
  type TranslatableEntry,
} from "@basicbar/ui";
import { useEasyMode } from "../App";
import type { MindmapSeedNode } from "../api";
import { Button } from "./ui";

export const MINDMAP_TEXT_MAX = 60;
export const MINDMAP_DESCRIPTION_MAX = 200;
export const MINDMAP_SEED_MAX_NODES = 100;

/** Per-language values of one seed field (every content language present). */
export type SeedTexts = Record<string, string>;

/** Editor-side node: a stable client id for React keys and focus. */
export interface EditableSeedNode {
  id: number;
  text: SeedTexts;
  description: SeedTexts;
  children: EditableSeedNode[];
}

type SeedField = "text" | "description";

let nextSeedId = 1;

function contentLangs(): string[] {
  const langs = SUPPORTED_LANGUAGES.map((l) => l.code);
  return langs.length ? langs : [getDefaultContentLang()];
}

/** A `{de, en}` map (or legacy plain string = canonical) with every content
 * language present. */
function fullMap(value: MindmapSeedNode["text"] | undefined): SeedTexts {
  const map = localizedMap(value);
  return Object.fromEntries(contentLangs().map((lang) => [lang, map[lang] ?? ""]));
}

function emptyMap(): SeedTexts {
  return Object.fromEntries(contentLangs().map((lang) => [lang, ""]));
}

export function toEditableSeed(nodes: MindmapSeedNode[] | undefined): EditableSeedNode[] {
  return (nodes ?? []).map((node) => ({
    id: nextSeedId++,
    text: fullMap(node.text),
    description: fullMap(node.description),
    children: toEditableSeed(node.children),
  }));
}

function hasText(node: EditableSeedNode): boolean {
  return Object.values(node.text).some((v) => v.trim() !== "") || node.children.some(hasText);
}

function mapValues(values: SeedTexts, fn: (v: string) => string): SeedTexts {
  return Object.fromEntries(Object.entries(values).map(([lang, v]) => [lang, fn(v)]));
}

/** API shape; blank rows (in every language) without filled sub-branches are
 * dropped (like a blank trailing answer option). */
export function fromEditableSeed(nodes: EditableSeedNode[]): MindmapSeedNode[] {
  return nodes.filter(hasText).map((node) => ({
    text: mapValues(node.text, (v) => v.trim().replace(/\s+/g, " ")),
    description: mapValues(node.description, (v) => v.trim()),
    children: fromEditableSeed(node.children),
  }));
}

export function countSeed(nodes: EditableSeedNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countSeed(node.children), 0);
}

/** Deepest level used by filled terms (0 = no predefined branches). */
export function seedDepth(nodes: MindmapSeedNode[], level = 1): number {
  return nodes.reduce(
    (max, node) => Math.max(max, level, seedDepth(node.children, level + 1)),
    0,
  );
}

/** First client-side problem of a (serialized) seed, as an English source
 * string for t(), or null. Mirrors backend rooms/mindmap.clean_seed. */
export function seedProblem(
  nodes: MindmapSeedNode[],
  depth: number,
): { key: string; values?: Record<string, string> } | null {
  if (seedDepth(nodes) > depth) {
    return { key: "The predefined branches are deeper than the allowed depth." };
  }
  const canonical = getDefaultContentLang();
  const walk = (list: MindmapSeedNode[]): { key: string; values?: Record<string, string> } | null => {
    const seen = new Set<string>();
    for (const node of list) {
      // The canonical term is required and is the merge key (backend
      // rooms/mindmap.clean_seed); translations are optional.
      const texts = localizedMap(node.text);
      const term = texts[canonical] ?? "";
      if (!term) {
        return Object.values(texts).some(Boolean)
          ? {
              key: "Every predefined branch needs a term in {{language}}.",
              values: { language: defaultContentLangLabel() },
            }
          : { key: "Every predefined branch needs a term." };
      }
      const key = term.toLocaleLowerCase();
      if (seen.has(key)) {
        return { key: "“{{term}}” appears twice at the same place.", values: { term } };
      }
      seen.add(key);
      const inner = walk(node.children);
      if (inner) return inner;
    }
    return null;
  };
  return walk(nodes);
}

function mapTree(
  nodes: EditableSeedNode[],
  fn: (node: EditableSeedNode) => EditableSeedNode | null,
): EditableSeedNode[] {
  return nodes.flatMap((node) => {
    const next = fn(node);
    if (next === null) return [];
    return [{ ...next, children: mapTree(next.children, fn) }];
  });
}

/** Registers one seed field with the global "translate all" pill (like a
 * TranslatableField does); renders nothing. */
function RegisterSeedField({
  values,
  onChange,
}: {
  values: SeedTexts;
  onChange: (lang: string, value: string) => void;
}) {
  const form = useTranslationForm();
  const holder = useRef<TranslatableEntry>({ values, onChange, format: "text" });
  holder.current = { values, onChange, format: "text" };
  const register = form?.register;
  const unregister = form?.unregister;
  const id = useId();
  useEffect(() => {
    if (!register || !unregister) return;
    register(id, holder as MutableRefObject<TranslatableEntry>);
    return () => unregister(id);
  }, [register, unregister, id]);
  return null;
}

export default function MindmapSeedEditor({
  value,
  onChange,
  depth,
  descriptions,
  rootLabel,
}: {
  value: EditableSeedNode[];
  onChange: (next: EditableSeedNode[]) => void;
  depth: number;
  descriptions: boolean;
  rootLabel: string;
}) {
  const { t, i18n } = useTranslation();
  const easyMode = useEasyMode();
  const form = useTranslationForm();
  const canonical = getDefaultContentLang();
  const langs = SUPPORTED_LANGUAGES;
  // Like TranslatableField: start in the UI language (easy mode: canonical
  // only, no tabs).
  const uiLang = (i18n.resolvedLanguage ?? "").split("-")[0];
  const [lang, setLang] = useState(
    !easyMode && langs.some((l) => l.code === uiLang) ? uiLang : canonical,
  );
  const activeLang = easyMode ? canonical : lang;
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const focusId = useRef<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const full = countSeed(value) >= MINDMAP_SEED_MAX_NODES;
  // Latest tree, also between a commit and the parent's re-render: async
  // translation writes land one after another and must not drop each other.
  const latest = useRef(value);
  latest.current = value;

  // "Show all fields in …" / after "translate all": follow the forced language.
  const forcedNonce = form?.forced.nonce;
  useEffect(() => {
    if (form?.forced.lang && !easyMode) setLang(form.forced.lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedNonce]);

  // Focus a freshly added row once it is rendered.
  useEffect(() => {
    if (focusId.current == null) return;
    inputs.current.get(focusId.current)?.focus();
    focusId.current = null;
  });

  function newNode(): EditableSeedNode {
    const node = { id: nextSeedId++, text: emptyMap(), description: emptyMap(), children: [] };
    focusId.current = node.id;
    return node;
  }

  function commit(next: EditableSeedNode[]) {
    latest.current = next;
    onChange(next);
  }

  function setText(id: number, field: SeedField, language: string, text: string) {
    commit(
      mapTree(latest.current, (node) =>
        node.id === id ? { ...node, [field]: { ...node[field], [language]: text } } : node,
      ),
    );
  }

  /** Empty fields of the active language whose canonical text is filled. */
  function missing(): { id: number; field: SeedField; source: string }[] {
    if (activeLang === canonical) return [];
    const result: { id: number; field: SeedField; source: string }[] = [];
    const walk = (list: EditableSeedNode[]) =>
      list.forEach((node) => {
        const fields: SeedField[] = descriptions ? ["text", "description"] : ["text"];
        for (const field of fields) {
          const source = (node[field][canonical] ?? "").trim();
          if (source && !(node[field][activeLang] ?? "").trim()) {
            result.push({ id: node.id, field, source });
          }
        }
        walk(node.children);
      });
    walk(value);
    return result;
  }

  const showTabs = !easyMode && langs.length > 1;
  const toTranslate = showTabs && form && isTranslationEnabled() ? missing() : [];

  async function translateMissing() {
    if (!form) return;
    const target = activeLang;
    setTranslating(true);
    setTranslateError(null);
    let failures = 0;
    for (const item of toTranslate) {
      try {
        const translated = await form.translate(
          item.source.slice(0, MAX_TRANSLATE_LENGTH),
          canonical,
          target,
          "text",
        );
        const limit = item.field === "text" ? MINDMAP_TEXT_MAX : MINDMAP_DESCRIPTION_MAX;
        setText(item.id, item.field, target, translated.slice(0, limit));
      } catch {
        failures += 1;
      }
    }
    if (failures) setTranslateError(t("Some fields could not be translated."));
    setTranslating(false);
  }

  /** Every filled term (resp. description) has this language. */
  function complete(language: string): boolean {
    const walk = (list: EditableSeedNode[]): boolean =>
      list.every(
        (node) =>
          (!hasText(node) || (node.text[language] ?? "").trim() !== "") &&
          walk(node.children),
      );
    return value.some(hasText) && walk(value);
  }

  function addChild(id: number) {
    if (full) return;
    commit(
      mapTree(value, (node) =>
        node.id === id ? { ...node, children: [...node.children, newNode()] } : node,
      ),
    );
  }

  function addSiblingAfter(id: number) {
    if (full) return;
    const insert = (list: EditableSeedNode[]): EditableSeedNode[] => {
      const index = list.findIndex((node) => node.id === id);
      if (index >= 0) return [...list.slice(0, index + 1), newNode(), ...list.slice(index + 1)];
      return list.map((node) => ({ ...node, children: insert(node.children) }));
    };
    commit(insert(value));
  }

  function remove(id: number) {
    commit(mapTree(value, (node) => (node.id === id ? null : node)));
  }

  /** The canonical text as placeholder while a translation is missing. */
  function placeholder(values: SeedTexts, fallback: string): string {
    return (activeLang !== canonical && values[canonical]?.trim()) || fallback;
  }

  function renderRows(nodes: EditableSeedNode[], level: number) {
    return nodes.map((node) => (
      <li key={node.id}>
        {showTabs && (
          <RegisterSeedField
            values={node.text}
            onChange={(language, text) =>
              setText(node.id, "text", language, text.slice(0, MINDMAP_TEXT_MAX))
            }
          />
        )}
        {showTabs && descriptions && (
          <RegisterSeedField
            values={node.description}
            onChange={(language, text) =>
              setText(node.id, "description", language, text.slice(0, MINDMAP_DESCRIPTION_MAX))
            }
          />
        )}
        <div className="flex items-start gap-1.5 py-1">
          <span
            aria-hidden
            className="mt-2.5 h-2 w-2 shrink-0 rounded-full bg-brand-400 dark:bg-brand-600"
            style={{ opacity: Math.max(0.35, 1 - (level - 1) * 0.15) }}
          />
          <div className="grid min-w-0 flex-1 gap-1">
            <input
              ref={(element) => {
                if (element) inputs.current.set(node.id, element);
                else inputs.current.delete(node.id);
              }}
              type="text"
              lang={activeLang}
              value={node.text[activeLang] ?? ""}
              maxLength={MINDMAP_TEXT_MAX}
              placeholder={placeholder(node.text, t("Term"))}
              aria-label={t("Term (level {{level}})", { level })}
              onChange={(event) => setText(node.id, "text", activeLang, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addSiblingAfter(node.id);
                }
              }}
              className="w-full rounded-lg border border-field bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 dark:bg-slate-900 dark:text-slate-100"
            />
            {descriptions && (
              <input
                type="text"
                lang={activeLang}
                value={node.description[activeLang] ?? ""}
                maxLength={MINDMAP_DESCRIPTION_MAX}
                placeholder={placeholder(node.description, t("Description (optional)"))}
                aria-label={t("Description (optional)")}
                onChange={(event) =>
                  setText(node.id, "description", activeLang, event.target.value)
                }
                className="w-full rounded-lg border border-field bg-white px-2.5 py-1 text-xs text-slate-700 placeholder:text-slate-400 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none dark:bg-slate-900 dark:text-slate-300"
              />
            )}
          </div>
          {level < depth && (
            <Button
              variant="ghost"
              aria-label={t("Add sub-term")}
              title={t("Add sub-term")}
              disabled={full}
              onClick={() => addChild(node.id)}
            >
              <Plus aria-hidden className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            aria-label={t("Delete term")}
            title={
              node.children.length
                ? t("Delete term with its sub-terms")
                : t("Delete term")
            }
            onClick={() => remove(node.id)}
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </div>
        {node.children.length > 0 && (
          <ul className="ml-3 border-l border-slate-200 pl-3 dark:border-slate-700">
            {renderRows(node.children, level + 1)}
          </ul>
        )}
      </li>
    ));
  }

  return (
    <div>
      <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
        {/* "+" sits right behind the root, like behind every other term. */}
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <span className="inline-block rounded-full bg-brand-100 px-2.5 py-0.5 text-sm font-semibold text-brand-800 dark:bg-brand-950 dark:text-brand-200">
            {rootLabel || t("Root (question text)")}
          </span>
          <Button
            variant="ghost"
            aria-label={t("Add branch")}
            title={t("Add branch")}
            disabled={full}
            onClick={() => {
              if (!full) commit([...value, newNode()]);
            }}
          >
            <Plus aria-hidden className="h-4 w-4" />
          </Button>
          {full && (
            <span className="text-xs text-slate-400">
              {t("At most {{max}} predefined terms.", { max: MINDMAP_SEED_MAX_NODES })}
            </span>
          )}
          {showTabs && (
            <div
              className="ml-auto flex gap-1"
              role="tablist"
              aria-label={t("Language of the predefined branches")}
            >
              {langs.map((l) => {
                const isActive = l.code === activeLang;
                const filled = complete(l.code);
                const status = filled ? t("translated") : t("not translated");
                return (
                  <button
                    key={l.code}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setLang(l.code)}
                    title={`${l.label} — ${status}`}
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase transition-colors ${
                      isActive
                        ? "bg-brand-400 text-slate-900"
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`inline-block h-1.5 w-1.5 rounded-full border ${
                        filled ? "border-emerald-500 bg-emerald-500" : "border-current opacity-40"
                      }`}
                    />
                    {l.code}
                    <span className="sr-only"> — {status}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {value.length > 0 && (
          <ul className="ml-3 border-l border-slate-200 pl-3 dark:border-slate-700">
            {renderRows(value, 1)}
          </ul>
        )}
      </div>
      {toTranslate.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void translateMissing()}
            disabled={translating}
            className="inline-flex items-center gap-1.5 rounded-full border border-brand-300 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100 disabled:opacity-50 dark:border-brand-400/40 dark:bg-brand-400/10 dark:text-brand-200 dark:hover:bg-brand-400/20"
          >
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
            {translating
              ? t("Translating…")
              : t("Translate from {{language}}", { language: defaultContentLangLabel() })}
          </button>
        </div>
      )}
      {translateError && <p className="mt-1 text-xs text-danger">{translateError}</p>}
    </div>
  );
}
