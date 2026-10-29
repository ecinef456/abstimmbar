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

**No correct answer ticked?** Saving a single- or multiple-choice question
without any answer marked correct asks first ("Are you sure this question
has no correct answer?" — *Back to the answers* / *Save anyway*). Upstream
asked only in self-checks, in a box at the end of the form; now it is a
pop-up for every set.

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

- The matrix colour names and the guided tour are in French too (the
  tour's old "German/English tabs" step now explains the room language).

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
  PRE* (live poll, answers never revealed), *Quiz 1*, *Quiz 2* (live polls,
  the correct answer only on key press — "After closing, on key press"),
  *Activators POST* (live poll, answers with the results) and a
  *Self-check* filled from Quiz 1, Quiz 2 and Activators POST of that week.
  (Migration `quizbar 0013` switched the quizzes of existing course rooms to
  "on key press" too.) Room language English unless
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

### Question library with tags

- **Library** (book icon in the header, `/library`): every question you
  write in your rooms appears here **once**, however often it is copied
  (duplicating a question, set or room, inserting from the library and
  self-check copies all count as the same question). Filter by tag chip
  or type, and a **To sort** chip for questions without tags.
- **Statistics on each card:** runs, answers and % correct over every
  copy of the question and every run (all rooms, all semesters: each
  answer ever given counts once), plus the most chosen wrong answer. After
  peer instruction the *first* vote counts (before discussing); demo runs
  never count; self-check attempts are not included.
- **Selection:** ticked questions stay selected while you change the
  search; **Show only the selected** lists exactly them (to check before
  copying or exporting).
- **Tags tab:** the library has two tabs, *Questions* and *Tags*. *Tags*
  lists every tag A–Z (four per row) with its number of questions — click
  one to see its questions — and has **search and replace** for tag names:
  "Find" → "Replace with", inside every tag containing the text, or *whole
  tag only*. A preview shows old → new before anything changes; a tag that
  becomes an existing one is merged into it, a tag replaced by nothing is
  **deleted** (its questions keep their other tags).
- **Copying questions into a set:** *Add questions from another set …*
  has two tabs, *From a room* (every room, also archived ones — it used to
  show only the 25 most recently changed sets) and *From the library*.
- **Library-only questions** (imported, or whose sets were deleted) live in
  a hidden set and open in the normal editor from the library.
- **Fast with hundreds of questions:** 30 cards per page (60 / 120
  selectable) while search, tags and "select all found" always cover the
  whole library; the tag chips are folded behind *Show the tag list* (always
  folded when the page opens); the
  list follows typing a moment later instead of on every key; the server
  loads translations and justifications in bulk (300 questions: about
  2 s → 0.25 s), and typeset math is cached for the whole library.
- **Cards:** three per row on wide screens (two on tablets, one on
  phones); images in a card are at most 10rem high, and a long question is
  cut with **Show all** so it does not stretch its row.
- **Search:** with **Tags** ticked (default) type tags separated by commas
  (`waves, week-3`): questions with *all* of them are shown; a partial
  tag (`week`) matches every tag starting with it, and matching tags are
  offered to click. Untick **Tags** to search the text of questions,
  answers and tags instead.
- **Tags:** one spelling, lower case with dashes (`Week 3` → `week-3`),
  everywhere: editor, library page, Typst import. Set them in the question
  editor ("Keep this question in my library", ticked by default for new
  questions; untick to leave one out) or directly on the library page.
  Select several and add tags at once; rename or delete a tag from its
  chip (renaming onto an existing tag merges them). Tags made before this
  rule were converted (and merged) by migration `quizbar 0006`.
- **Reuse:** "From library" on a set page, or "Copy into a question set"
  on the library page. The copy is independent: change it freely in its
  set. The library keeps showing the original; the pencil edits that one.
- **Nothing gets lost:** deleting a set or room never removes a library
  question. If its last copy goes, the library keeps it in a hidden store
  ("Kept only in the library") until you copy it into a set again.
- **Existing questions** (written before this version) are added once with

  ```bash
  sudo docker exec abstimmbar_app python manage.py quizbar_library --owner <username>
  ```

  Identical questions (same type, text and answers) become one entry.

Code: `quizbar/library.py` (tables `LibraryEntry`, `LibraryTag`,
`QuestionLineage`, `LibraryVault`; signals in `quizbar/apps.py`),
`frontend/src/quizbar/Library.tsx`, `LibraryPage.tsx`; hooks in
`rooms/transfer.py` (`duplicate_question`), `rooms/serializers.py`
(`library` field of a question), `rooms/views.py` (hidden store never
listed), `QuestionPage.tsx`, `SetPage.tsx`, `App.tsx`, `main.tsx`.

### Questions in three languages (English, German, French)

- A question keeps its **own text** (the original) and can have
  **translations** for English, German and French — question text, answers
  and justifications.
- Wherever it is shown (beamer, phones, self-check, results) the room's
  language picks the translation; a missing one falls back to the original.
  Rooms without a language: each phone picks its own.
- The **library** shows English (the English translation, if the original
  is not English). Tags are English.
- Editor: a collapsed **Translations** box under the answers (tabs English /
  Deutsch / Français).
- Copies (library, duplicated sets/rooms, self-checks) keep the translations.
- From Typst: one file per language, imported together (see below).

Code: `quizbar/i18n.py` (tables `QuestionTranslation`, `OptionTranslation`),
`frontend/src/quizbar/Translations.tsx`; hooks in `live/state.py`,
`live/results.py`, `quizbar/justifications.py`, `rooms/transfer.py`,
`rooms/serializers.py` (`translations` field), `QuestionPage.tsx`.

### Automatic translation in the editor (DeepL or LibreTranslate)

The translation panel of the question editor gets a **Translate** row:
"Translate from [the original | English | Deutsch | Français] into the
other languages". It fills the empty fields of the other two languages
(question, answers, justifications); tick *replace what is already there*
to overwrite. Math (`$…$`, `\(…\)`) is never sent to the translator and
comes back unchanged. It is a draft: check it, then save.

Set up one service in the server's `.env` (then `fork/deploy.sh`):

- **DeepL** (best quality): `QUIZBAR_DEEPL_KEY=…` — a DeepL API key; free
  keys end in `:fx` (500,000 characters a month).
- **LibreTranslate** (free, private, runs on the server, weaker):
  `COMPOSE_PROFILES=translate` and
  `QUIZBAR_LIBRETRANSLATE_URL=http://libretranslate:5000`. The container
  (only EN/DE/FR) is part of `docker-compose.prod.yml`; the first start
  downloads its models (a few GB, a few minutes).

Without either, the row does not appear. Independent of upstream's own
de/en translation switch. Code: `quizbar/translate.py`, endpoint
`/api/quizbar/translate/`, `frontend/src/quizbar/Translations.tsx`.

### Quizzes written in Typst (quizbar.typ)

The package lives in `frontend/public/quizbar/` (`quizbar.typ`, `example.typ`,
`figures/wave.png`) and is downloadable from the library page. Keep
`quizbar.typ` next to your quiz files, like a preamble.

```typst
#import "quizbar.typ": *
#show: quizbar.with(title: "Week 3 – Quiz 1", type: "live", figures: "figures")

#question(
  [Speed of a wave with $lambda = 2$ m and $f = 3$ Hz?],
  kind: "SC",                                   // or "MC"
  answers: (
    answer(true,  [6 m/s],   why: [$v = lambda f$.]),
    answer(false, [1.5 m/s], why: [That is $lambda \/ f$.]),
  ),
  image: "wave.png",                            // optional, in figures/
  tags: ("waves", "week-3"),                    // optional
  time-limit-s: 60,                             // optional
  shuffle: false,                               // default
)
```

- `typst compile quiz.typ` → clean student PDF;
  `typst compile --input solutions=true quiz.typ` → with the correct answers,
  justifications, tags and time limits.
- **Import:** room ⋮ → *Import Typst quiz (.typ or .zip)*. Upload the `.typ`
  (plus its figures), or a `.zip` of the folder. `type:` is `"live"`,
  `"quiz"` (self-paced) or `"self-check"`. If the room has an **empty set
  with the same title and type** (e.g. from the course template), the
  questions go into it; otherwise a new set is made (in the open folder).
  The questions join the library with their tags.
- **Several languages:** `quiz.en.typ`, `quiz.de.typ`, `quiz.fr.typ` with
  `lang: "en"` / `"de"` / `"fr"` in the show rule (the PDF headings follow
  it), same questions and answers in the same order, imported together in
  one `.zip`: one set, each question once, the other files become its
  translations. The English file is the original (correct answers, images,
  tags, time limits come from it). Mismatched files are refused with the
  question number.
- Kept on import: math (as Typst math), paragraphs, `- lists`, `*bold*`,
  `_italic_`; answers and `why:` become plain text with math. Other markup
  is reduced to its text. The file is read, not run, so `#question(...)`
  calls must be written out (not generated by loops).

- **Many quizzes straight into the library:** library page → *Import Typst
  quizzes (.zip)*. One zip with any number of quizzes, each as
  `name.en.typ` / `name.de.typ` / `name.fr.typ` (same folder, same name)
  plus their figures, 150 MB at most. The questions go into the library
  only — no room, no set; they are edited from the library (pencil) like
  any other. Every question gets its own tags plus the file name as a tag
  (`kinematics`). Questions already in the library (same kind, text and
  answers) are not added again — they only get the tags. A quiz whose
  language versions do not match is skipped with a message; the others
  are imported.

Code: `quizbar/typst_import.py` (parser + import), endpoint
`/api/quizbar/rooms/<id>/import-typst/`, menu item in `RoomPage.tsx`.

### PDF export (Typst)

Single- and multiple-choice questions can be exported as PDF, typeset by the
server with Typst (Python package `typst`, no Typst install needed):

- **Room:** ⋮ → *Export quizzes as PDF* — the folders as chapters, their sets
  in folder order, then the sets outside folders ("Other quizzes").
- **Folder:** open the folder → *Export PDF* — its sets as chapters.
- **Library:** *Export shown as PDF* — exactly the questions the search /
  tag filter shows (or *Export selection as PDF* when questions are ticked).

The dialog has one checkbox per language (English, Deutsch, Français) and two
for the versions: **without solutions** (empty ○ one answer / □ several
answers, to tick on paper) and **with solutions** (correct answers filled
green, the "why" of every answer, tags). Question numbers restart in every
set. Texts come in the chosen language (the translation, else the
original). One language and one version → one PDF; otherwise a zip:

```
<name>/README.txt  quizbar.typ  figures/
<name>/en/<name>.typ  <name>.pdf  <name>-solutions.pdf
<name>/de/…  <name>/fr/…
```

**Exam versions A and B** (checkbox in the dialog): the same questions,
version A in the written answer order, version B with the answers in
another (fixed) order, plus `<name>-key.pdf`, a one-page answer key with
the correct letters of both versions, set by set.

The `.typ` files use the same `quizbar.typ` package (with `#section(...)`
headings) and can be edited and recompiled:
`typst compile --root . en/<name>.typ` (add `--input solutions=true`).
Math stays Typst math; LaTeX math and Typst math that does not compile are
printed as source code instead of failing the export; images from questions
and answers are copied into `figures/`. Word clouds, open questions etc. are
left out.

Code: `quizbar/export.py`, endpoint `POST /api/quizbar/export/`, dialog
`frontend/src/quizbar/ExportDialog.tsx`. The package is kept twice
(`frontend/public/quizbar/quizbar.typ` for download,
`backend/quizbar/typst/quizbar.typ` for the server); a test checks they are
identical.

### Peer instruction (key D) and confidence 0–10

- **Peer instruction:** on a single- or multiple-choice question of a live
  poll, after the class voted, press **D**: the first vote is kept, the
  question opens again and phones show "Vote 2" with a fresh form. The
  beamer's results (and the stored results) show **Vote 1** above
  **Vote 2** for every answer. Once per question; not in game mode.
- **Confidence:** set page → *Ask how sure students are* (off by default).
  After answering, phones show an optional scale 0–10 (guessing … sure)
  under the answer: one pill-shaped bar that fills up to the chosen number. Results show the average, separately for right
  and wrong answers ("wrong but sure" = a misconception).

Code: `quizbar/peer.py` (models `PeerRound`, `SetConfidence`,
`VoteConfidence`), phone part `quizbar/templates/quizbar/peer_participant.html`,
hooks in `live/state.py` and `live/results.py`; the phone's vote marker gets
a round suffix (`participant.html`).

### Statistics of a room or folder (CSV, PDF report)

Room page → **Statistics** (works with "All sets", a folder, or "Not in a
folder"):

- **Left:** the sets, compact, each with its share of correct answers and
  its questions underneath (one line each, with their %).
- **Right, overview:** **before and after** — sets whose titles differ only
  by *PRE* / *POST* (e.g. "1 – Activators PRE" / "4 – Activators POST") are
  compared, overall and question by question (questions matched through
  the library, else by position); then a table of all sets (date,
  participants, % correct). Click a set for its **detail**: every question
  with its answer bars (vote 1 above vote 2 after peer instruction), how
  sure the class was, a run selector (latest by default, or all runs
  combined) and a link to the full results page.
- **CSV:** one row per question (folder, set, date, participants, % correct,
  correct options, vote 1, confidence, count per option), semicolon
  separated for Excel.
- **PDF report** (Typst): per folder an overview of the sets, the
  PRE → POST comparison, then one page per set with every question's bars.
  Sets without answers are left out.

Numbers: the latest run of each set; a vote is correct when exactly the
correct options were chosen. Self-checks count completed attempts.

Code: `quizbar/stats.py`, `quizbar/report.py`,
`frontend/src/quizbar/RoomStatistics.tsx`; endpoints
`/api/quizbar/rooms/<id>/stats/` (`csv/`, `pdf/`) and
`/api/quizbar/sets/<id>/stats/?run=`.

### Game mode (Kahoot style)

- **Switch it on** per live poll: set page → *Game mode*. Duplicated sets
  and rooms keep it.
- **Options** (under the switch, both off by default):
  - *Students choose a nickname* — else every phone plays under a random
    funny name ("Chaotic Capybara", "Relativistic Beaver"; 68 adjectives ×
    63 animals), derived from the phone's anonymous token, so the same phone
    keeps its name; never twice in one game.
  - *Students choose an avatar* — else no avatars anywhere; the podium shows
    the medals only.
  With both off there is no join screen at all: phones are in as soon as they
  open the page.
- **Phones:** a pill at the bottom shows name, points and rank. Once the
  solution is shown (L, or the results when the set reveals "immediately"),
  "+850 points · Rank 3 of 25" or "No points this time". When the run ends:
  the final place (🥇🥈🥉).
- **Points:** single and multiple choice questions with a correct answer
  only (multiple choice: exactly the right choices). Correct = 500–1000
  points, 1000 at once, 500 at the time limit (no limit: a 20 s window).
  Points of the open question never appear before its solution is shown.
- **Beamer:** the lobby lists the players; **P** shows the leaderboard (top
  5 with this question's points); the closing slide becomes the **podium**
  (3rd, 2nd, drum roll, 1st, then places 4–9). **M** mutes.
- **Avatars:** the 30 built-in physicists (`<slug>.svg`, drawn by
  `fork/avatars/generate.py`). Your own pictures go into
  `backend/quizbar/static/quizbar/avatars/` (git-ignored; README there):
  `newton.png` replaces an icon, `ada-lovelace.png` adds an avatar,
  `newton-full.png` adds a **full-body** picture — shown big on the phone
  once chosen, on the phone's final screen and on the podium.
- **Sounds:** your own MP3 files in `frontend/public/quizbar/sounds/`
  (`lobby`, `question`, `reveal`, `leaderboard`, `drumroll`, `podium`).
  They are git-ignored, so each server keeps its own; see the README in
  that folder. Missing files stay silent.

Code: `quizbar/game.py`, `quizbar/avatars.py`, `quizbar/funny_names.py` (tables `SetGame`, `GameEntry`, `GameQuestion`;
Run signal in `quizbar/apps.py`), `quizbar/templates/quizbar/game_participant.html`
(included by the participant page), `frontend/src/quizbar/Game.tsx`,
`GameModePanel.tsx`; hooks in `live/state.py`, `participant.html` (one
event), `PresentPage.tsx`, `SetPage.tsx`, `rooms/views.py` (duplicate).

### Demo present (try a quiz out, nothing is saved)

Set page → **Demo**, next to *Present* (live polls and self-paced quizzes).
It presents exactly as usual — lobby, QR code, phones, every key, peer
instruction, game mode, *Next quiz* (stays in demo mode) — but the run is a
test: the beamer shows "Demo — nothing is saved", the phones "your answers
are not saved".

- The demo run is deleted with everything answered in it when the
  presenter leaves it (✕/Esc, end of the quiz, closing or reloading the
  tab), when any presentation (real or demo) starts in the same room, or
  after 6 hours untouched.
- While it exists it is invisible to the results page, the CSV, the room
  statistics, the PDF report, the library card numbers and the start
  dialog ("continue / archive / delete").
- Starting a demo leaves real results alone: an unfinished real run of the
  set (presenter left with Esc) is kept as a finished result.

Code: `quizbar/demo.py` (table `DemoRun`, endpoints
`POST /api/quizbar/sets/<id>/demo/` and `/api/quizbar/runs/<id>/demo/end/`),
`frontend/src/quizbar/Demo.tsx`; hooks in `live/views.py` (`live_status`,
`start_run`, `set_results`, `results_csv`), `live/state.py`,
`PresentPage.tsx`, `SetPage.tsx`, `api.ts` (`results.list`), phone note in
`quizbar/templates/quizbar/peer_participant.html`.

### The handbook, inside the app

Header **?** → **Handbook** (`/handbook`): the fork's handbook as a page of
the app, with a table of contents that follows the reading position
(chapters; the sections of the current chapter), deep links
(`/handbook#demo-try-a-quiz-out`) and a small *PDF* link.

The source is `backend/quizbar/handbook/handbook.typ` — one Typst file for
both: the server compiles it to HTML for the page (cached) and to PDF for
the link, filling in its own address and the signed-in user, so the file
holds nothing personal. Its helpers (`tip`, `warn`, `key`, `step`,
`cards`) check `target()` and give boxes/keys/steps in both outputs. Edit
it like any other file of the fork; locally:

    typst compile backend/quizbar/handbook/handbook.typ \
        --input site=https://<server>.ts.net --input user=<username>

Code: `quizbar/handbook.py`, endpoint `/api/quizbar/handbook/` (`?pdf=1`),
`frontend/src/quizbar/Handbook.tsx`; hooks in `components/HelpMenu.tsx`,
`main.tsx`.

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
