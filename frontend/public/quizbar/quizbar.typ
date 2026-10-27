// quizbar.typ — quiz questions for abstimmbar (fork ecinef456/abstimmbar).
//
// One file, two uses:
//   typst compile quiz.typ                          → clean PDF for students
//   typst compile --input solutions=true quiz.typ   → with ticks, justifications,
//                                                     tags and time limits
//   abstimmbar: room ⋮ → "Import Typst file"         → a question set whose
//                                                     questions join the library
//
// Keep this file next to your quiz files (like a preamble): figures are
// looked up relative to it, in the folder given by `figures:`.
//
//   #import "quizbar.typ": *
//   #show: quizbar.with(title: "Week 3 – Quiz 1", type: "live", figures: "figures")
//
//   #question(
//     [Speed of a wave with $lambda = 2$ m and $f = 3$ Hz?],
//     kind: "SC",                          // "SC" single choice, "MC" multiple choice
//     answers: (
//       answer(true,  [6 m/s],   why: [$v = lambda f$.]),
//       answer(false, [1.5 m/s], why: [That is $lambda \/ f$.]),
//     ),
//     image: "wave.png",                   // optional, in the figures folder
//     tags: ("waves", "week-3"),           // optional, for the library (stored
//                                          // lower case, spaces → "-")
//     time-limit-s: 60,                    // optional
//     shuffle: false,                      // optional: shuffle the answers live
//   )
//
// What abstimmbar reads: the question text and answers (math stays Typst
// math, *bold*, _italic_, lists and paragraphs survive; other markup is
// kept as plain text), `why:`, `kind`, `image`, `tags`, `time-limit-s`,
// `shuffle`, and `title`/`type`/`description` of the show rule.

#let _image = image

#let _truthy(value) = lower(str(value)) in ("true", "1", "yes", "on")

#let _config = state("quizbar-config", (
  figures: "figures",
  solutions: _truthy(sys.inputs.at("solutions", default: "false")),
))

#let _number = counter("quizbar-question")

/// One answer option: correct or not, its text, and why.
#let answer(correct, body, why: none) = (correct: correct, body: body, why: why)

/// Document setup. `type`: "live" (live poll), "quiz" (self-paced quiz) or
/// "self-check". `solutions: auto` follows `--input solutions=true`.
#let quizbar(
  title: none,
  type: "live",
  description: none,
  figures: "figures",
  solutions: auto,
  body,
) = {
  assert(type in ("live", "quiz", "self-check"), message: "type: \"live\", \"quiz\" or \"self-check\"")
  _config.update(c => (
    figures: figures,
    solutions: if solutions == auto { c.solutions } else { solutions },
  ))
  set page(margin: (x: 2.2cm, y: 2.2cm), numbering: "1")
  set par(justify: false)
  set text(size: 11pt)
  if title != none {
    align(center, text(size: 17pt, weight: "bold", title))
    context if _config.get().solutions {
      align(center, text(size: 9pt, fill: rgb("#b45309"), [Solutions]))
    }
    v(0.4em)
  }
  if description != none {
    align(center, text(fill: luma(90), description))
    v(0.6em)
  }
  body
}

#let _marker(kind, filled) = {
  let fill = if filled { rgb("#15803d") } else { none }
  let stroke = 0.8pt + if filled { rgb("#15803d") } else { luma(80) }
  if kind == "MC" {
    box(baseline: 0.15em, rect(width: 0.8em, height: 0.8em, radius: 1.5pt, fill: fill, stroke: stroke))
  } else {
    box(baseline: 0.15em, circle(radius: 0.4em, fill: fill, stroke: stroke))
  }
}

/// A single- or multiple-choice question.
#let question(
  statement,
  kind: "SC",
  answers: (),
  image: none,
  image-width: 60%,
  tags: (),
  time-limit-s: none,
  shuffle: false,
) = {
  let kind = upper(kind)
  assert(kind in ("SC", "MC"), message: "kind: \"SC\" or \"MC\"")
  assert(answers.len() >= 2, message: "a question needs at least two answers")
  if kind == "SC" {
    let right = answers.filter(a => a.correct).len()
    assert(right <= 1, message: "a single-choice question has at most one correct answer")
  }
  let tags = if type(tags) == str { (tags,) } else { tags }
  _number.step()
  context {
    let cfg = _config.get()
    let n = _number.get().first()
    block(breakable: false, width: 100%, above: 1.4em, below: 1.4em)[
      #text(weight: "bold")[Question #n]
      #h(0.4em)
      #text(size: 8.5pt, fill: luma(110))[#if kind == "MC" [multiple answers possible] else [one answer]]
      #if cfg.solutions and (tags.len() > 0 or time-limit-s != none) {
        h(1fr)
        text(size: 8.5pt, fill: rgb("#b45309"))[
          #tags.join(" · ")#if time-limit-s != none [ #h(0.6em) #str(time-limit-s) s]
        ]
      }
      #v(0.2em)
      #statement
      #if image != none {
        align(center, _image(cfg.figures + "/" + image, width: image-width))
      }
      #v(0.2em)
      #grid(
        columns: (auto, auto, 1fr),
        column-gutter: 0.6em,
        row-gutter: 0.75em,
        ..answers.enumerate().map(((i, a)) => (
          _marker(kind, cfg.solutions and a.correct),
          [#numbering("A", i + 1).],
          [
            #a.body
            #if cfg.solutions and a.why != none {
              linebreak()
              text(size: 9pt, fill: luma(80), style: "italic", a.why)
            }
          ],
        )).flatten(),
      )
    ]
  }
}
