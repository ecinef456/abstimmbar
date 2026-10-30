// abstimmbar — my fork: the handbook. One source for two outputs:
//   PDF:  typst compile handbook.typ --input site=https://<server>.ts.net --input user=<username>
//   In the app: the server compiles it to HTML (? menu → Handbook) and fills
//   in its own address and the signed-in user.
// Helpers check `target()`, so boxes, keys and steps work in both.
#let site = sys.inputs.at("site", default: "https://<server>.ts.net")
#let me = sys.inputs.at("user", default: "<username>")

#let green = rgb("#2c7a45")
#let soft = rgb("#eefaf1")
#let amber = rgb("#fff4dc")
#let red = rgb("#fde8e8")
#let ink = rgb("#26292b")
#let grey = rgb("#6b7176")

#set document(title: "abstimmbar — my fork: handbook")
#set page(
  paper: "a4",
  margin: (x: 2cm, top: 2cm, bottom: 2cm),
  numbering: "1",
  footer: context [
    #set text(8pt, fill: grey)
    abstimmbar (fork ecinef456/abstimmbar, branch `custom`) #h(1fr) #counter(page).display()
  ],
)
#set text(font: ("Libertinus Serif", "New Computer Modern"), size: 10.5pt, fill: ink)
#set par(justify: false, leading: 0.62em)
#show raw: set text(font: ("DejaVu Sans Mono", "New Computer Modern Mono"), size: 8.6pt)
#show raw.where(block: true): it => context if target() == "html" { it } else {
  block(fill: rgb("#f5f6f7"), inset: 8pt, radius: 5pt, width: 100%, stroke: 0.5pt + rgb("#e1e4e7"), it)
}
#show heading.where(level: 1): it => context if target() == "html" { it } else {
  pagebreak(weak: true)
  block(above: 0pt, below: 12pt)[
    #text(20pt, weight: "bold", fill: green)[#it.body]
    #v(-6pt)
    #line(length: 100%, stroke: 1.2pt + green)
  ]
}
#show heading.where(level: 2): it => context if target() == "html" { it } else {
  block(above: 14pt, below: 7pt, text(13pt, weight: "bold")[#it.body])
}
#show heading.where(level: 3): it => context if target() == "html" { it } else {
  block(above: 10pt, below: 5pt, text(11pt, weight: "bold", fill: green)[#it.body])
}
#show link: it => context if target() == "html" { it } else { text(fill: green, it) }

#let box-of(fill, stroke, kind, label, body) = context if target() == "html" {
  html.elem("div", attrs: (class: "hb-box hb-" + kind))[#html.elem("strong")[#label] #body]
} else {
  block(
    fill: fill, stroke: (left: 3pt + stroke), inset: (x: 10pt, y: 8pt), radius: 3pt, width: 100%,
    above: 8pt, below: 8pt,
  )[#text(weight: "bold", fill: stroke)[#label] #body]
}
#let tip(body) = box-of(soft, green, "tip", "Tip.", body)
#let warn(body) = box-of(amber, rgb("#b45309"), "warn", "Careful.", body)
#let danger(body) = box-of(red, rgb("#b91c1c"), "danger", "Never.", body)
#let key(k) = context if target() == "html" { html.elem("kbd")[#k] } else {
  box(
    fill: rgb("#f1f3f5"), stroke: 0.6pt + rgb("#c9ced3"), inset: (x: 4pt, y: 1.5pt), radius: 3pt,
    baseline: 1.5pt, text(8.5pt, font: ("DejaVu Sans Mono", "New Computer Modern Mono"), weight: "bold", k),
  )
}
#let step(n, body) = context if target() == "html" {
  html.elem("div", attrs: (class: "hb-step"))[
    #html.elem("span", attrs: (class: "hb-num"))[#str(n)]
    #html.elem("div")[#body]
  ]
} else {
  grid(
    columns: (18pt, 1fr), column-gutter: 6pt,
    box(width: 16pt, height: 16pt, radius: 8pt, fill: green, align(center + horizon, text(9pt, fill: white, weight: "bold", str(n)))),
    body,
  )
}
// Cards side by side (cheat sheet); `warm: true` = amber.
#let cards(..items) = context if target() == "html" {
  html.elem("div", attrs: (class: "hb-cards"), items.pos().map(((warm, body)) =>
    html.elem("div", attrs: (class: if warm { "hb-card hb-warm" } else { "hb-card" }), body)
  ).join())
} else {
  grid(columns: (1fr, 1fr), column-gutter: 14pt, row-gutter: 10pt,
    ..items.pos().map(((warm, body)) =>
      block(fill: if warm { amber } else { soft }, inset: 10pt, radius: 6pt, width: 100%, body)
    ),
  )
}
#set table(stroke: 0.5pt + rgb("#d9dde1"), inset: 6pt)
#show table.cell.where(y: 0): set text(weight: "bold")

// ---------------------------------------------------------------- cover
#context if target() == "html" {
  html.elem("div", attrs: (class: "hb-cover"))[
    #table(columns: (auto, 1fr),
      [*Live site*], [#link(site)[#raw(site)] — public, for students],
      [*Test site*], [#raw(site + ":8443") — only on your tailnet],
      [*Students join*], [`…/p/<room code>` or the QR code on the beamer],
      [*Code*], [`github.com/ecinef456/abstimmbar`, branch `custom`],
      [*On the server*], [`/opt/abstimmbar` (live) · `/opt/abstimmbar-test` (test) · `~/abstimmbar-backups/`],
    )
  ]
} else {
  align(center)[
    #v(3.2cm)
    #text(34pt, weight: "bold")[abstimm#text(fill: green)[BAR]]
    #v(2pt)
    #text(15pt, fill: grey)[my fork — the handbook]
    #v(1.2cm)
    #block(width: 82%, fill: soft, inset: 14pt, radius: 8pt)[
      #set align(left)
      #set text(10.5pt)
      #grid(columns: (auto, 1fr), row-gutter: 8pt, column-gutter: 12pt,
      [*Live site*], [#link(site)[#raw(site)] — public, for students],
      [*Test site*], [#raw(site + ":8443") — only on your tailnet],
      [*Students join*], [`…/p/<room code>` or the QR code on the beamer],
      [*Code*], [`github.com/ecinef456/abstimmbar`, branch `custom`],
      [*On the server*], [`/opt/abstimmbar` (live) · `/opt/abstimmbar-test` (test) · `~/abstimmbar-backups/`],
      )
    ]
    #v(1cm)
    #block(width: 82%)[
      #set align(left)
      *What is in here.*
      1. What the app can do — one page
      2. A teaching week, step by step
      3. Presenting: all keys · peer instruction · demo
      4. Writing questions (math, images, justifications)
      5. The question library and tags · PDF export · statistics
      6. Recipe: Typst quiz → PDF → abstimmbar
      7. Game mode (Kahoot style)
      8. The server: updating safely, backups, emergencies
      9. One-page cheat sheet
    ]
  ]
}

// ---------------------------------------------------------------- 1
= What the app can do

#table(
  columns: (auto, 1fr),
  table.header([Feature], [What it gives you]),
  [*Live polls*], [Questions on the beamer, students answer on their phones (QR code, no account). Single/multiple choice, word cloud, free text, scales, ordering, mind map, matrix …],
  [*Self-paced quiz*], [All questions at once, students work at their own pace in class.],
  [*Demo present*], [Try a quiz out (present, answer on your own phone) — nothing is saved, nothing shows up in the statistics.],
  [*Self-check*], [A permanent link for self-study with instant feedback. *Fills itself* from other sets of the week.],
  [*Math*], [Typst math `$v = lambda f$` (default) or LaTeX `\(\frac{a}{b}\)`, on beamer and phones.],
  [*Justifications*], [Under each answer: why it is right or wrong. Shown with #key("J").],
  [*One language per room*], [No DE/EN tabs: write once; set the room language (EN/DE/FR). The interface also speaks French.],
  [*Folders*], [Sets grouped per week inside a room, in a numbered order, with a *Next quiz* button.],
  [*Course rooms*], [A room with Week 1 … Week 14, each with Activators PRE, Quiz 1 … Quiz 10, Activators POST, Self-check.],
  [*Duplicate room*], [Copy a whole room (e.g. the template) in one click.],
  [*Question library*], [Every question you write, once, with tags. Search by tags; copy questions into any set.],
  [*Typst quizzes*], [Write quizzes in Typst → clean PDF (with/without solutions) → import into abstimmbar.],
  [*PDF export*], [A room, a folder or what the library shows → PDF in EN/DE/FR, with tick boxes for students and/or with solutions; exam versions A/B with an answer key.],
  [*Peer instruction*], [#key("D"): the class discusses and votes again; results show vote 1 above vote 2.],
  [*Confidence*], [Optional 0–10 "how sure?" after each answer (switch per set, off by default).],
  [*Statistics*], [Room/folder: PRE → POST comparison, % correct per set and question, CSV and PDF report. Library cards show their numbers.],
  [*Auto-translate*], [In the editor: translate a question into the other two languages (DeepL or LibreTranslate).],
  [*Game mode*], [Kahoot style: points for fast right answers, leaderboard, podium, sounds, optional nicknames and avatars.],
)

#tip[This handbook is also in the app: #key("?") in the header → *Handbook*.]

#tip[Everything you add is in *your fork* only. The original app (virtUOS) keeps working underneath; you can still take its updates (chapter 8).]

// ---------------------------------------------------------------- 2
= A teaching week, step by step

== Once per semester
#step(1)[Open the archived room *0000 - TEMPLATE* (rooms overview → *Archived*).]
#step(2)[Room menu #key("⋮") → *Duplicate room*. You land in "0000 - TEMPLATE (copy)".]
#step(3)[#key("⋮") → *Settings*: rename it (e.g. "FS27 - TA - Physics") and pick the *room language*.]

You now have folders *Week 1 … Week 14*, each with 13 sets in this order:

#table(
  columns: (auto, auto, 1fr),
  table.header([Set], [Type], [Use]),
  [Activators PRE], [live poll], [at the start of class; solutions never shown],
  [Quiz 1 … Quiz 10], [live poll], [in-class quizzes; the solution only when you press #key("L"). Fill as many as you need — empty ones are skipped by *Next quiz* and the self-check],
  [Activators POST], [live poll], [at the end, with solutions],
  [Self-check], [self-check], [copies the quizzes + Activators POST automatically],
)

All live polls start *answerable as soon as a question is shown*, with the results only on the beamer (not on the phones). New live polls you make yourself start the same way, with the solution on #key("L").

== Every week
#step(1)[Fill *Quiz 1*, *Quiz 2*, *Activators* — by hand, from the library ("From library"), or by importing a Typst file (chapter 6).]
#step(2)[In class: open the week's folder → #key("▶") on the first set. At the end of a quiz the closing slide offers *Next quiz* (or press #key("N")).]
#step(3)[After class: open *Self-check* → it already contains this week's questions. Press *Publish* and post the link/QR (e.g. on Moodle).]

#tip[Edit a question in its *own* set (Quiz 1 …). The self-check updates itself the next time it is opened. Edits made inside the self-check are overwritten.]
#tip[A set's "Fill automatically from" box (on the self-check page) decides which sets it copies. You can tick or untick sets there.]

// ---------------------------------------------------------------- 3
= Presenting: all keys

#table(
  columns: (auto, 1fr),
  table.header([Key], [Does]),
  [#key("S") #key("Space") #key("Enter")], [start · open the vote · close the vote (step by step)],
  [#key("→") / #key("←")], [next / previous question],
  [#key("E") (#key("R"))], [show the results],
  [#key("L")], [reveal the correct answer],
  [#key("J")], [show *why* each answer is right/wrong (also on the phones)],
  [#key("D")], [*peer instruction*: keep the first vote, the class discusses, then votes again],
  [#key("A")], [cycle the views (question → results → …)],
  [#key("Q")], [QR code panel on/off],
  [#key("P")], [game mode: leaderboard],
  [#key("M")], [game mode: sound on/off],
  [#key("N")], [on the closing slide: next quiz of the folder],
  [#key("H") #key("?")], [help overlay],
  [#key("Esc")], [leave (the run stays open, phones show "paused")],
)

== Peer instruction (vote, discuss, vote again)
#step(1)[Ask the question, let the class vote (#key("S")), close (#key("S")) and — if you like — show the results (#key("E")) *without* the solution.]
#step(2)[Results between about 30 % and 70 % correct? Say "convince your neighbour", then press #key("D"). The question opens again; phones show *Vote 2*.]
#step(3)[Close and show the results: each answer has two bars, *Vote 1* (light) and *Vote 2*. Then #key("L") and #key("J") as usual.]
Once per question; not in game mode. The stored results and the statistics keep both votes.

== How sure are you? (0–10)
On the set page: *Ask how sure students are* (off by default). After answering, phones show an optional scale 0–10 (guessing … sure) that fills up to the chosen number. The results show the average — for right and for wrong answers apart. *Wrong but sure* means a misconception worth discussing.

#tip[For Google Slides: keep abstimmbar open in a second window and switch with #key("Alt")+#key("Tab"). The QR code stays the same for the whole room.]

== Demo: try a quiz out
Set page → *Demo* (next to *Present*). Everything works as usual — QR code, phones, all keys, peer instruction, game mode — but it is a *test run*: the beamer shows "Demo — nothing is saved", the phones "your answers are not saved".
- When you leave (#key("Esc"), ✕, end of the quiz, closing the tab) the test run is deleted with all its answers.
- It never shows up in the results, the statistics, the CSV/PDF reports or the numbers on the library cards.
- *Next quiz* (#key("N")) stays in demo mode. Starting a real presentation in the room ends any demo.


// ---------------------------------------------------------------- 4
= Writing questions

== Math
#table(
  columns: (1fr, 1fr),
  table.header([You type], [Kind]),
  [`$v = lambda f$`], [Typst (default), inline],
  [`$ E = m c^2 $` (spaces inside)], [Typst, displayed on its own line],
  [`\( \frac{1}{2} m v^2 \)` or `$$ … $$`], [LaTeX],
  [`$lambda \/ f$`], [a literal slash inside Typst math],
)
Works in the question text, the answers and the justifications.

== Images
Drag an image into the question text (or use the image icon). It is centred automatically. Each answer can have its own image too.

== Justifications (key J)
Tick the box in front of every correct answer. Forgot it? *Save* asks "Are you sure this question has no correct answer?" — *Back to the answers*, or *Save anyway* (e.g. when all answers are wrong on purpose).

Under every answer in the editor there is a field *"why right / wrong"*. In class: #key("L") reveals the solution, #key("J") shows the justifications on the beamer *and* on the phones. In self-checks, students see them with the feedback.

== Room language
#key("⋮") → *Settings* → *Language* (English / Deutsch / Français): the beamer and the phones switch to it.

== Translations (one question, three languages)
Under the answers in the editor: *Translations* (tabs English / Deutsch / Français) — question text, answers and "why" in the other languages.
- The room's language decides what is shown. No translation for it → the original text.
- The English tab shows your original in its field; only what you change there becomes an English translation.
- Titles of the course structure ("Week 2 – Activators PRE", "Quiz 3", "Self-check") appear in the room's language while presenting ("Woche 2 – Aktivierungsfragen PRE", "Semaine 2 – Activateurs PRE" …). You keep editing them in English.
- The library always shows the English version; tags are English.
- Copies (library, duplicated rooms, self-checks) keep the translations.
- *Translate* (if set up on the server, chapter 8): "Translate from English / Deutsch / Français into the other languages" fills the empty fields (English = your original); tick *replace what is already there* to overwrite. Math stays untouched. Check the draft, then *Save*.

// ---------------------------------------------------------------- 5
= The question library

The *book icon* in the header (or `/library`).

- Every question you write lands here *once* — copies (duplicated sets, rooms, self-checks, "From library") are the same entry, never doubles.
- In the editor: *"Keep this question in my library"* (ticked by default) and the *tags*.
- *To sort*: the questions that have no tag yet.

== Tags
Always lower case with dashes — `Week 3` is saved as `week-3`, `Thermo Dynamics` as `thermo-dynamics`. Typical tags: `week-3`, `waves`, `thermodynamics`, `activator`.

== Searching
- *Tags* ticked (default): type tags separated by commas — `waves, week-3` shows the questions that have *all* of them. A partial tag (`week`) matches every tag starting with it, and clickable suggestions appear.
- *Tags* unticked: searches the text of questions and answers.

== Using library questions
- On a set page: *From library* → tick questions → *Copy*.
- On the library page: select questions → *Copy into a question set*, or *Add tags* to many at once.
- The copy is independent: change it freely in its set. The pencil edits the original.

#tip[Deleting a set or a room never deletes library questions: the last copy is kept ("Kept only in the library").]

== Statistics on the cards
Each card shows: runs, answers, *% correct* (green ≥ 70 %, orange ≥ 40 %, red below) and the *most chosen wrong answer* — over every copy of the question, in every room and every semester: each answer ever given counts once. So over time you see which questions are easy and which are hard.
- After peer instruction (#key("D")) the *first* vote counts — what students knew before discussing.
- Demo runs never count. Self-checks are not included (students can retry there).

== Many questions
The library shows 30 questions per page (pager at the bottom, 60 or 120 per page possible). Searching and tag filters always look through *all* questions, and *Select all … found* selects all matches, not just the page. The tag chips are always folded when the page opens: *Show the tag list* opens them.

== The Tags tab
The library has two tabs: *Questions* and *Tags*. *Tags* lists all tags A–Z with their number of questions (click one to see its questions).
- *Search and replace:* "Find" `electro-` → "Replace with" `electro` changes every tag containing the text; tick *Whole tag only* to change one tag exactly. A preview shows old → new first.
- *Delete a tag:* find it (whole tag only) and leave "Replace with" empty → *Delete 1 tag*. The questions keep their other tags.
- Two tags that become the same are merged.

== Copy questions into a set
On a set page: #key("⋮") → *Add questions from another set …* — tab *From a room* (any room, also archived ones, e.g. last semester's week 7) or tab *From the library*.

== Keep track of a selection
Ticked questions stay ticked while you search for other tags. *Show only the selected* lists exactly them (to check before *Copy* or *Export*).

== Export to PDF
Only single- and multiple-choice questions are exported (word clouds etc. are left out).
- *A whole room:* room #key("⋮") → *Export quizzes as PDF* — one chapter per folder, the sets in folder order.
- *One week:* open the folder → *Export PDF*.
- *From the library:* search tags (e.g. `week-3, waves`) → *Export shown as PDF* (or tick questions → *Export selection as PDF*).

In the window, tick the *languages* (English, Deutsch, Français) and the *versions*:
- *Without solutions* — empty ○ (one answer) and □ (several answers) for students to tick on paper.
- *With solutions* — right answers filled in green, the "why" under every answer.

One language + one version → *one PDF*. Otherwise a *zip*: a folder per language with both PDFs and the `.typ` file, plus `quizbar.typ` and `figures/` — you can edit the `.typ` and recompile it yourself (`typst compile --root . en/NAME.typ`).

*Exam versions A and B* (tick in the window): same questions, answers in another order in B, plus an *answer key* PDF with the correct letters of both versions.

#tip[Each language uses the translation if there is one, otherwise the original text. Math is typeset; LaTeX math appears as code.]

== Statistics of a room or week
Room page → *Statistics* (with *All sets* or a week folder selected).
- *Left:* the sets, each with its % correct and its questions underneath.
- *Right:* *Before and after* — Activators PRE vs POST, overall and per question (e.g. 39 % → 82 %, +43) — and a table of all sets. Click a set: every question with its bars, vote 1/2, confidence, and a run selector.
- *CSV* (Excel) and *PDF report*: the overview and PRE → POST on the first page, then one page per quiz.

// ---------------------------------------------------------------- 6
= Recipe: Typst quiz → PDF → abstimmbar

== Get the package (once)
Library page → download `quizbar.typ`, `example.typ` and its figure. Put `quizbar.typ` *in the same folder* as your quiz files (like your TA preamble), figures in a sub-folder `figures/`.

```
week-3/
├── quizbar.typ
├── quiz1.typ
└── figures/
    └── wave.png
```

== Write the quiz
```typst
#import "quizbar.typ": *
#show: quizbar.with(
  title: "Week 3 – Quiz 1",        // = the set's name in abstimmbar
  type: "live",                    // "live" | "quiz" (self-paced) | "self-check"
  description: [In-class quiz about waves],
  figures: "figures",
)

#question(
  [Speed of a wave with $lambda = 2$ m and $f = 3$ Hz?],
  kind: "SC",                      // "SC" one answer, "MC" several
  answers: (
    answer(true,  [6 m/s],   why: [$v = lambda f$.]),
    answer(false, [1.5 m/s], why: [That is $lambda \/ f$.]),
  ),
  image: "wave.png",               // optional, from figures/
  tags: ("waves", "week-3"),       // optional, for the library
  time-limit-s: 60,                // optional
  shuffle: false,                  // optional (default false)
)
```

== Several languages at once
One file per language, *same questions and answers in the same order*, each with its language in the show rule:
```
waves.en.typ   →  #show: quizbar.with(title: "Waves", lang: "en", …)
waves.de.typ   →  #show: quizbar.with(title: "Waves", lang: "de", …)
waves.fr.typ   →  #show: quizbar.with(title: "Waves", lang: "fr", …)
```
Zip them together with `quizbar.typ` and `figures/`, import the zip: *one* set, each question once, in three languages. The English file is the original (correct answers, images, tags, time limits come from it). Each PDF gets headings in its own language ("Frage 1", "eine Antwort" …).

#tip[Extracting questions from a PDF: give a new Claude chat (Sonnet, with code execution) the PDF, `quizbar.typ`, `example.typ` and the prompt `PROMPT.md`. It returns the three language files + figures, ready to import.]

== Make the PDFs
```bash
typst compile quiz1.typ                          # for students
typst compile --input solutions=true quiz1.typ   # with ✓, why, tags, time
```

== Many quizzes at once, straight into the library
Library page → *Import Typst quizzes (.zip)*. The zip holds the *.typ sources* (not the PDFs!) and their figures, for example:
```
src/quizbar.typ
src/kinematics/kinematics.en.typ   kinematics.de.typ   kinematics.fr.typ
src/kinematics/figures/…
src/gauss-law/gauss-law.en.typ     …
```
- The questions go *only into the library* (no room); each is tagged with its file name (`kinematics`, `gauss-law`, …) plus its own tags. The pencil on a card opens it in the editor.
- Importing the same zip again adds nothing twice — questions already in the library only get the tags.
- Then: library → search the tag → tick → *Copy into a question set*.

== Import into abstimmbar
#step(1)[Zip the folder (`week-3.zip`), or select the `.typ` *and* its figures.]
#step(2)[Open the room → #key("⋮") → *Import Typst quiz (.typ or .zip)*.]
#step(3)[If the room has an *empty* set with the *same title and type* (e.g. "Week 3 – Quiz 1" from the template), the questions go *into it* — it stays in its week folder and feeds the week's self-check. Otherwise a new set is made in the folder you have open.]

#warn[Write every `#question(...)` out — questions made by loops or your own functions are not found (abstimmbar reads the file, it does not run Typst). Kept: math, paragraphs, `- lists`, `*bold*`, `_italic_`. Answers and "why" become plain text (math still works).]

#tip[Re-importing after an edit makes a new set ("… (2)") if the old one has questions. Delete the old set first if you want to replace it.]

// ---------------------------------------------------------------- 7
= Game mode (Kahoot style)

== Switch it on
Set page of a *live poll* → *Game mode*. Under it, two options (both *off* by default):

#table(
  columns: (auto, 1fr, 1fr),
  table.header([Option], [Ticked], [Unticked (default)]),
  [*Students choose a nickname*], [they type a nickname], [random funny name per phone, e.g. "Chaotic Capybara" — the same phone keeps it],
  [*Students choose an avatar*], [they pick a physicist], [no avatars; the podium shows medals only],
)
With both unticked there is no join screen at all: phones are in as soon as they open the page.

== Points
- Only single/multiple choice questions *with a correct answer* count (MC: exactly the right choices).
- Right answer = 500–1000 points: 1000 at once, 500 at the time limit (no limit: 20-second window).
- Phones see their points only once you reveal the solution (#key("L")).

== In class
Lobby shows who joined → questions as usual → #key("P") leaderboard whenever you like → after the last question the closing slide is the *podium* (3rd, 2nd, drum roll, 1st). Phones show their final place.

== Your own sounds and avatars (files on the server)
#table(
  columns: (auto, 1fr),
  table.header([Folder], [Put there]),
  [`frontend/public/quizbar/sounds/`], [`lobby.mp3` `question.mp3` `reveal.mp3` `leaderboard.mp3` `drumroll.mp3` `podium.mp3` (missing = silent)],
  [`backend/quizbar/static/quizbar/avatars/`], [`newton-full.png` = full body (phone + podium) · `newton.png` = replaces the icon · `ada-lovelace.png` = a new avatar "Ada Lovelace"],
)
These files are *not in git*: copy them into *both* `/opt/abstimmbar-test/…` and `/opt/abstimmbar/…`, then rebuild (`fork/test-up.sh`, `fork/deploy.sh`).

// ---------------------------------------------------------------- 8
= The server

== The two copies
#table(
  columns: (auto, auto, 1fr),
  table.header([Folder], [Branch], [What]),
  [`/opt/abstimmbar`], [`custom`], [*live* site, public (Tailscale Funnel)],
  [`/opt/abstimmbar-test`], [`next`], [*test* site, only on your tailnet, port 8443],
  [`~/abstimmbar-backups/`], [—], [backups (newest 30 kept)],
)

== The scripts (in `fork/`)
#table(
  columns: (auto, 1fr),
  table.header([Command], [Does]),
  [`fork/backup.sh`], [backs up the live database + images],
  [`fork/test-up.sh`], [copies the *live data* into the test site and rebuilds it],
  [`fork/test-up.sh --keep-data`], [rebuilds the test site, keeps its own data],
  [`fork/deploy.sh`], [backup → puts the tested version live → rebuild → push to GitHub],
  [`fork/update-upstream.sh`], [takes the newest original abstimmbar (virtUOS) into the test copy],
  [`fork/restore.sh <backup>`], [puts a backup back into the live site (asks first)],
)

== Install a change (a `.patch` file) — the safe way
```bash
# laptop → server
scp ~/Downloads/00XX-*.patch debian-hp:~/

# server: 1. test copy
cd /opt/abstimmbar-test
git am ~/00XX-*.patch
fork/test-up.sh                 # then try https://…ts.net:8443

# 2. all good → live (makes a backup first)
/opt/abstimmbar/fork/deploy.sh
```

If `git am` stops with an error, undo the half-applied patch:
```bash
git am --abort
```
Patches must go in *in order* (0010 before 0011 …). Check what is in: `git log --oneline -5`.

== Bad test? Throw it away
```bash
cd /opt/abstimmbar-test
git reset --hard HEAD~1         # removes the last patch from the test copy
fork/test-up.sh
```

== Update the original abstimmbar (virtUOS)
```bash
/opt/abstimmbar/fork/update-upstream.sh   # into the test copy
/opt/abstimmbar/fork/test-up.sh           # try it
/opt/abstimmbar/fork/deploy.sh            # live
```
If it reports a conflict, nothing was changed — ask for help with the listed files.

#danger[`docker compose pull` for the app, or upstream's own update script: it would replace *your* version with the original one. Always use the scripts above.]

== Backups and going back
- `deploy.sh` makes a backup every time. Extra one anytime: `/opt/abstimmbar/fork/backup.sh`.
- *Bad deploy?* Code and database must go back *together*:
```bash
cd /opt/abstimmbar
git log --oneline -5                       # find the commit before
git reset --hard <that commit>
sudo docker compose -f docker-compose.prod.yml -f docker-compose.funnel.yml up -d --build
fork/restore.sh ~/abstimmbar-backups/db-<stamp>.sql.gz   # the backup made just before
```

== Everyday commands
```bash
cd /opt/abstimmbar
alias dc='sudo docker compose -f docker-compose.prod.yml -f docker-compose.funnel.yml'
dc ps                 # is it running?
dc logs -f app        # live log (Ctrl+C to quit)
dc restart app        # restart the app
sudo tailscale funnel status   # is the public link on?
```
(Put the `alias` line in `~/.bashrc` to have it always.)

== One-time commands (run after a deploy)
#raw(block: true, lang: "bash", "# put questions written before the library into it
sudo docker exec abstimmbar_app python manage.py quizbar_library --owner " + me + "
# create course rooms
sudo docker exec abstimmbar_app python manage.py quizbar_course --owner " + me + " --title \"0000 - TEMPLATE\" --archived
sudo docker exec abstimmbar_app python manage.py quizbar_course --owner " + me + " --title \"HS26 - TA - Physics\"
# bring an existing course room up to date (adds missing quizzes, removes nothing)
sudo docker exec abstimmbar_app python manage.py quizbar_course --owner " + me + " --title \"0000 - TEMPLATE\" --update")
On the test site: the same with `abstimmbar_test_app`. Options of `quizbar_course`: `--weeks 14`, `--language en|de|fr|none`, `--update`.

== Switch on automatic translation (once)
Add *one* of these to `/opt/abstimmbar/.env`, then run `fork/deploy.sh`:
```bash
# DeepL (best): an API key from deepl.com (free keys end in ":fx")
QUIZBAR_DEEPL_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx
# or LibreTranslate on your PC (free, private, weaker; first start downloads models)
COMPOSE_PROFILES=translate
QUIZBAR_LIBRETRANSLATE_URL=http://libretranslate:5000
```

== If something looks wrong
#table(
  columns: (auto, 1fr),
  table.header([Symptom], [Fix]),
  [Timers wrong (30 s shows 60 min)], [server clock: `timedatectl` must say "System clock synchronized: yes"; `sudo timedatectl set-ntp true`],
  [Links/QR say `http://`], [`Caddyfile.funnel` must contain `header_up X-Forwarded-Proto https`],
  [Site down after a reboot], [wait 1 min; `dc ps`; `dc up -d`; `sudo tailscale funnel status`],
  [Test site unreachable], [only inside the tailnet (Tailscale on your laptop)],
)

#tip[Turning the PC off and on is fine: the containers and the Funnel come back by themselves. Students only need the room code or QR code — it never changes.]

// ---------------------------------------------------------------- 9
= Cheat sheet

#cards(
  (false, [
    *Presenting* \
    #key("S") step · #key("→")#key("←") question · #key("E") results \
    #key("L") solution · #key("J") why · #key("Q") QR \
    #key("P") leaderboard · #key("M") sound · #key("N") next quiz \
    #key("D") vote again (peer instruction) \
    #key("Esc") leave · #key("H") help
  ]),
  (false, [
    *Each week* \
    folder Week N → Activators, Quiz 1 … 10, Activators \
    → present → *Next quiz* \
    → Self-check → *Publish* → link on Moodle
  ]),
  (false, [
    *Typst quiz* \
    `typst compile quiz.typ` (students) \
    `typst compile --input solutions=true quiz.typ` \
    room #key("⋮") → *Import Typst quiz* (.zip with figures)
  ]),
  (false, [
    *Library* \
    book icon in the header · tags `week-3, waves` \
    set page → *From library* \
    untagged = *To sort* \
    *Export shown as PDF* (also room #key("⋮"), folder)
  ]),
  (true, [
    *Install a patch* \
    `scp …patch debian-hp:~/` \
    `cd /opt/abstimmbar-test && git am ~/…patch` \
    `fork/test-up.sh` → try on :8443 \
    `/opt/abstimmbar/fork/deploy.sh`
  ]),
  (true, [
    *Rescue* \
    `git am --abort` (stuck patch) \
    `git reset --hard HEAD~1` (test copy) \
    `fork/backup.sh` · `fork/restore.sh <db-….sql.gz>` \
    never `docker compose pull` for the app
  ]),
)
