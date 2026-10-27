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

### One content language per room, French interface

- **No more DE/EN tabs.** Every text (questions, answers, sets, rooms) is
  written once, in a single field. It is stored in the canonical language
  column; editing a field clears the other language's column, so an old
  "translation" can never show instead of it. Text that so far existed
  only in the other language is shown (and moved over on the next save).
- **Room language** (room settings): Deutsch, English, Français, or
  Automatic (each person's own language, as upstream). It decides the
  language of the participant pages and of the beamer while presenting
  that room; a participant's own pick in the 🌐 menu still wins.
- **French** as a third interface language: the whole app
  (`frontend/src/locales/fr/translation.json`) and the participant pages
  (`backend/locale/fr/`). French is an interface language only, so
  `settings.LANGUAGES` (which also defines the content columns) stays de/en;
  `quizbar.languages.ParticipantLanguageMiddleware` adds fr for `/p/`, `/c/`
  and `/r/`.

Code: `components/TranslatableField.tsx`, `quizbar/languages.py` (table
`RoomLanguage`), hooks in `RoomSerializer`, `live/state.py`, `RoomPage.tsx`,
`PresentPage.tsx`, `i18n.ts`, `participant.html`.

### Folders of question sets, numbered order, "Next quiz"

- **Folders inside a room** (e.g. one per week): chips above the set list —
  *All sets*, each folder, *Not in a folder*, *+ New folder*. Move a set
  with the folder icon on its card. A set created or imported while a
  folder is open lands in it; a duplicate goes right after its original.
- **Numbered order** (per folder, on by default): the sets are shown as
  "1 – …", "2 – …" and reordered with the ↑/↓ buttons on the cards.
  Off: the folder uses the room's normal sort.
- **Next quiz:** in a numbered folder, the presenter's closing slide offers
  "Next quiz: 2 – …" (or press **N**). It ends the current quiz and opens
  the next one's start screen (QR code), skipping self-checks and empty
  sets. Participants' phones follow by themselves (same room code).
- Deleting a folder keeps its sets (they become "not in a folder").

Code: `quizbar/folders.py` (tables `SetFolder`, `SetPlacement`, endpoints
under `/api/quizbar/rooms|folders|sets/…`), `frontend/src/quizbar/Folders.tsx`,
hooks in `RoomPage.tsx`, `PresentPage.tsx` and the set `duplicate` view.
The room page now also loads all of a room's sets (upstream stopped at 25).

### Self-checks filled automatically, course rooms, duplicating a room

- **Fill automatically from:** a self-check's page has a box listing the
  other sets of its folder (*Show all sets of this room* for the rest).
  Tick sets and their questions are copied into the self-check, one
  section per set, and kept up to date: edit a question in its own set and
  the self-check follows the next time it is opened (by you or a student).
  Only kinds a self-check supports are copied (single/multiple choice,
  ordering, free text). Questions you add to the self-check by hand stay,
  after the copied ones. Copies keep their ids, so attempt statistics
  survive edits.
- **Course rooms:** a management command creates a room with folders
  *Week 1 … Week N*, each with five sets in numbered order: *Activators
  PRE* (live poll, answers never revealed), *Quiz 1*, *Quiz 2*, *Activators
  POST* (live polls) and a *Self-check* filled from Quiz 1, Quiz 2 and
  Activators POST of that week. Room language English unless
  `--language de|fr|none`.

  ```bash
  sudo docker exec abstimmbar_app python manage.py quizbar_course \
      --owner <username> --title "0000 - TEMPLATE" --archived
  sudo docker exec abstimmbar_app python manage.py quizbar_course \
      --owner <username> --title "HS26 - TA - Physics"        # --weeks 14 is the default
  ```
- **Duplicate room** (room ⋮ menu, also for archived rooms): copies
  settings, language, folders, every set with its questions and the
  self-check links, which then point to the copy's own sets. The copy is
  called "… (copy)" and is not archived; rename it in the room settings.
  Keep an archived "0000 - TEMPLATE" and duplicate it for each new course.

Code: `quizbar/selfcheck.py`, `quizbar/course.py`,
`quizbar/management/commands/quizbar_course.py` (tables `SelfCheckSource`,
`SyncedQuestion`, `SyncedSection`, `SelfCheckState`),
`frontend/src/quizbar/SelfCheckSources.tsx`; hooks in `live/views.py`
(sync before a student loads the self-check), `SetPage.tsx`, `RoomPage.tsx`.

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
