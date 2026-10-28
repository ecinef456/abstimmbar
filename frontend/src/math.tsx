// SPDX-License-Identifier: Apache-2.0
/**
 * Math in the presenter / results views (Typst by default, LaTeX too; syntax
 * in mathCore.ts).
 *
 * React-safe by construction: math is turned into an HTML string *before*
 * React injects it (RichText / dangerouslySetInnerHTML), never by rewriting
 * DOM nodes React owns. Texts without any delimiter pass through unchanged,
 * so existing content renders byte-identically.
 */
import "katex/dist/katex.min.css";
import { hasMath, renderMathIn } from "./mathCore";

export { hasMath };

// The presenter re-renders often (SSE ticks, countdown); cache the results.
const cache = new Map<string, string>();
// quizbar (fork): large enough for a whole question library (text, answers
// and justifications of a few hundred questions), else it is cleared on
// every render and all math is typeset again.
const CACHE_MAX = 5000;

/** Render math inside a (server-sanitized) HTML fragment; returns HTML. */
export function mathHtml(html: string): string {
  if (!hasMath(html)) return html;
  const hit = cache.get(html);
  if (hit !== undefined) return hit;
  // An inert document: nothing in the fragment loads or runs while parsing.
  const doc = document.implementation.createHTMLDocument("");
  const box = doc.createElement("div");
  box.innerHTML = html;
  let out = html;
  try {
    renderMathIn(box);
    out = box.innerHTML;
  } catch {
    // Keep the raw text if rendering fails unexpectedly.
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(html, out);
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text (e.g. an answer option) with math rendered. Without math it
 *  renders the bare string, exactly as before. */
export function MathText({ text }: { text: string | null | undefined }) {
  if (!text) return <>{text ?? ""}</>;
  if (!hasMath(text)) return <>{text}</>;
  return <span dangerouslySetInnerHTML={{ __html: mathHtml(escapeHtml(text)) }} />;
}
