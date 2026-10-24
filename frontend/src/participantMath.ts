// SPDX-License-Identifier: Apache-2.0
// Standalone bundle for the framework-free participant page: the template
// lazy-loads /static/katex/abstimmbar-math.js once a math delimiter appears
// and calls window.abstimmbarMath.render(<main>). Built by `npm run build`.
import { renderMathIn } from "./mathCore";

(window as unknown as { abstimmbarMath: { render: (el: HTMLElement) => void } }).abstimmbarMath = {
  render: renderMathIn,
};
