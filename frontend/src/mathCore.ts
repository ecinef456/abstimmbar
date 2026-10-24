// SPDX-License-Identifier: Apache-2.0
/**
 * Math in authored content (question texts, answer options), shared by the
 * presenter SPA (math.tsx) and the framework-free participant page
 * (participantMath.ts, bundled separately).
 *
 * Syntax:
 * - Typst (default): `$omega = sqrt(k/m)$` inline; with spaces just inside
 *   both dollars (`$ E = 1/2 k x^2 $`) it is displayed on its own line, as in
 *   Typst. Converted to LaTeX with tex2typst, then typeset by KaTeX.
 * - LaTeX: `\(…\)` inline, `\[…\]` or `$$…$$` displayed. A `$…$` whose body
 *   contains a backslash command (`$\omega$`) is also read as LaTeX, so
 *   LaTeX-style content keeps working.
 * - `\$` is a literal dollar sign; a lone `$` (e.g. a price) stays text.
 *
 * Only text inside a single text node is considered (math split by bold or
 * italic formatting stays raw). Broken input stays visible as raw text.
 */
import renderMathInElement from "katex/contrib/auto-render";
import type { RenderMathInElementOptions } from "katex/contrib/auto-render";
import { typst2tex } from "tex2typst";

const KATEX_OPTIONS: RenderMathInElementOptions = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
  ],
  ignoredClasses: ["katex"],
  // Typos show as red source text instead of breaking the page.
  throwOnError: false,
  // Bound the output size of hostile or broken input (e.g. huge \rule).
  maxSize: 20,
  maxExpand: 200,
  trust: false,
};

const IGNORED_TAGS = new Set(["SCRIPT", "NOSCRIPT", "STYLE", "TEXTAREA", "PRE", "CODE", "OPTION"]);
const MATH_HINT = /\$|\\\(|\\\[/;
const LATEX_COMMAND = /\\[a-zA-Z]/;
// An escaped `\$` becomes WORD JOINER + "$": invisible, and the scanner
// treats a "$" right after it as text, so re-runs stay no-ops.
const LITERAL_MARK = "⁠";

/** Cheap pre-check: could this text contain math at all? */
export function hasMath(text: string | null | undefined): boolean {
  return !!text && MATH_HINT.test(text);
}

// Typst escapes like `\/` (an inline slash instead of a fraction) or `\*`
// are not understood by tex2typst, so they travel through the conversion as
// marker strings and are put back as the literal character afterwards.
const ESCAPED = /\\([^\sA-Za-z0-9])/g;
const MARKER = /\\text\{zqesc(\d+)zq\}/g;
const LATEX_LITERAL: Record<string, string> = {
  "\\": "\\backslash ", "{": "\\{", "}": "\\}", "_": "\\_", "$": "\\$",
  "#": "\\#", "%": "\\%", "&": "\\&", "^": "\\hat{}", "~": "\\sim ",
};

function typstToLatex(body: string): string | null {
  const marked = body.replace(ESCAPED, (_, ch: string) => ` "zqesc${ch.codePointAt(0)}zq" `);
  try {
    return typst2tex(marked).replace(MARKER, (_, code: string) => {
      const ch = String.fromCodePoint(Number(code));
      return LATEX_LITERAL[ch] ?? ch;
    });
  } catch {
    return null;
  }
}

/** Rewrite `$…$` (Typst, or LaTeX if it has backslash commands) as
 *  \(…\) / \[…\] for KaTeX's auto-render; everything else is kept. */
export function convertDollars(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && src[i + 1] === "$") {
      out += LITERAL_MARK + "$";
      i += 2;
    } else if (ch === "$" && src[i - 1] === LITERAL_MARK) {
      out += ch;
      i += 1;
    } else if (src.startsWith("$$", i)) {
      // LaTeX display math: left for auto-render as is.
      const end = src.indexOf("$$", i + 2);
      if (end < 0) return out + src.slice(i);
      out += src.slice(i, end + 2);
      i = end + 2;
    } else if (ch === "$") {
      let end = i + 1;
      while (
        end < src.length &&
        !(src[end] === "$" && src[end - 1] !== "\\" && src[end - 1] !== LITERAL_MARK)
      ) end++;
      if (end >= src.length) return out + src.slice(i);
      const body = src.slice(i + 1, end);
      let tex: string | null;
      let display = false;
      if (LATEX_COMMAND.test(body)) {
        tex = body;
      } else {
        display = /^\s/.test(body) && /\s$/.test(body);
        tex = body.trim() ? typstToLatex(body.trim()) : null;
      }
      out += tex === null ? src.slice(i, end + 1) : display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
      i = end + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function skipped(node: Node, root: Element): boolean {
  for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
    if (IGNORED_TAGS.has(el.tagName) || el.classList.contains("katex")) return true;
  }
  return false;
}

/** Typeset all math inside `root` in place. Safe to call repeatedly. */
export function renderMathIn(root: HTMLElement): void {
  if (!hasMath(root.textContent)) return;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.includes("$") && !skipped(n, root)) texts.push(n as Text);
  }
  for (const t of texts) {
    const converted = convertDollars(t.data);
    if (converted !== t.data) t.data = converted;
  }
  renderMathInElement(root, KATEX_OPTIONS);
}
