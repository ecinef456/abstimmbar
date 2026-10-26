# About this fork

A fork of [virtUOS/abstimmbar](https://github.com/virtUOS/abstimmbar),
used for physics exercise classes at ETH Zurich. The `custom` branch is
upstream `main` plus the changes below; upstream is merged in regularly.
Licence unchanged (Apache-2.0).

Features that need their own data live in the backend app `quizbar`
(`backend/quizbar/`), in its own tables linked to upstream's by foreign
keys, so upstream migrations and ours never collide. Upstream files only
carry small hooks, each marked with a `quizbar (fork)` comment.

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

### Justifications: why an answer is right or wrong (key J)

Single- and multiple-choice options have an optional **justification**
(editor: the field under each answer; Typst/LaTeX math works).

- **Live poll:** after the vote, press **J** on the beamer. The correct
  answers are marked and every answer shows its justification, on the
  beamer and on the participants' phones (if the set shows results to
  participants). J again hides them; E (plain results) or moving to
  another question hides them too.
- **Self-paced quiz and self-check:** the justifications appear under the
  answers together with the instant right/wrong feedback (not while a
  self-check withholds results until its summary).
- Copied, duplicated, exported and imported with the question.

Code: `backend/quizbar/` (tables `OptionJustification`,
`RunJustification`, endpoint `POST /api/quizbar/runs/<id>/justification/`),
hooks in `rooms/serializers.py`, `rooms/transfer.py`, `live/state.py`,
`live/views.py`, `participant.html`, `QuestionPage.tsx`, `PresentPage.tsx`.

### A–Z as the default sort

Rooms and question sets open sorted by title; numbers sort naturally
(Woche 2 before Woche 10).

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

## Operating this fork

Layout on the server:

| Path | Branch | What |
|---|---|---|
| `/opt/abstimmbar` | `custom` | live instance (public via Tailscale Funnel) |
| `/opt/abstimmbar-test` | `next` | test instance, a git worktree of the same repository |
| `~/abstimmbar-backups/` | – | database + image backups (newest 30 kept) |

The test instance has its own containers, database and image and is
reachable only inside the tailnet, at `https://<server>.ts.net:8443/`.

Scripts (in `fork/`):

| Script | Does |
|---|---|
| `test-setup.sh` | once: creates the test worktree, `.env.test`, and the tailnet-only HTTPS |
| `backup.sh` | backs up the live database and uploaded images |
| `test-up.sh` | loads a fresh copy of the live data into the test instance and (re)builds it; `--keep-data` skips the copy |
| `deploy.sh` | backup, then fast-forwards `custom` to `next`, rebuilds the live instance, pushes to GitHub |
| `update-upstream.sh` | merges virtUOS's latest `main` into `next` (stops without changes on conflicts) |
| `restore.sh <db-backup>` | puts a backup back into the live instance (asks first) |

Workflow for a change:

1. In `/opt/abstimmbar-test`: apply it (`git am change.patch`) or run
   `fork/update-upstream.sh`.
2. `fork/test-up.sh`, then try it at `https://<server>.ts.net:8443/`.
3. Good: `/opt/abstimmbar/fork/deploy.sh`.
   Bad: `git reset --hard HEAD~1` in the test worktree (or ask for a fix).

Going back after a bad deploy: in `/opt/abstimmbar`, `git reset --hard
<previous commit>`, rebuild, and restore the backup `deploy.sh` made right
before (`fork/restore.sh ~/abstimmbar-backups/db-<stamp>.sql.gz`): code and
database must go back together.
