# About this fork

A fork of [virtUOS/abstimmbar](https://github.com/virtUOS/abstimmbar),
used for physics exercise classes at ETH Zurich. It follows upstream
closely: the `custom` branch is upstream `main` plus the changes below,
rebased regularly. Licence unchanged (Apache-2.0).

## Changes

### Math in questions and answer options (Typst by default, LaTeX too)

Rendered with [KaTeX](https://katex.org); Typst is converted to LaTeX with
[tex2typst](https://github.com/qwinsi/tex2typst). Works on the presenter
view, the results pages and the participant page.

| Input | Result |
|---|---|
| `$omega = sqrt(k/m)$` | Typst, inline |
| `$ E = 1/2 k x^2 $` (spaces inside both dollars) | Typst, displayed |
| `$\omega = \sqrt{k/m}$` | LaTeX (detected by backslash commands) |
| `\(…\)`, `\[…\]`, `$$…$$` | LaTeX, inline / displayed |
| `\$5` | a literal dollar sign |

- Texts without math render exactly as before.
- The participant page loads the math code (~100 kB compressed) only when
  a question actually contains math.
- Formulas that cannot be converted stay visible as raw text.
- Limitation: math split by bold/italic formatting is not rendered.

Code: `frontend/src/mathCore.ts` (shared logic), `frontend/src/math.tsx`
(React), `frontend/src/participantMath.ts` (bundle for the participant
page, built by `npm run build`), plus small hooks in `PresentPage.tsx`,
`ResultsPage.tsx`, `OrderingResult.tsx`, `participant.html` and the
`Dockerfile`.

### Centred images in question texts

Images in question texts are centred on their own line, on the beamer and
on phones (`live/base.html`, `PresentPage.tsx`).

## Deployment

As upstream (`docs/deployment.md`), but build the image from this branch
instead of pulling the released one:

    git clone -b custom https://github.com/ecinef456/abstimmbar.git
    docker compose -f docker-compose.prod.yml up -d --build

Do not run `docker compose pull` for the `app` service: it would replace
the custom build with the upstream image.
