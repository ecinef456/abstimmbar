# SPDX-License-Identifier: Apache-2.0
"""Statistics of a room or folder as CSV and as a PDF report (Typst).

Both start from ``stats.room_stats`` (latest run of every set). The PDF
has, per folder: an overview of the sets, the PRE → POST comparison of the
activators question by question, then one page per set with every
question's answers as bars (vote 1 above vote 2 after peer instruction)
and how sure the class was.
"""
import csv
import io
import tempfile
from pathlib import Path

from django.utils import timezone
from django.utils.text import slugify

from .export import ExportError, Renderer
from .stats import room_stats

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
MAX_OPTIONS = 8

WORDS = {
    "en": {
        "stats": "Statistics", "all": "All sets", "none": "Not in a folder", "set": "Set",
        "date": "Date", "people": "Participants", "correct": "Correct", "answers": "answers",
        "pre_post": "Before and after", "question": "Question", "vote1": "Vote 1", "vote2": "Vote 2",
        "sure": "How sure (0–10)", "right": "right answers", "wrong": "wrong answers",
        "nothing": "No answers yet.", "attempts": "attempts", "self_check": "Self-check",
    },
    "de": {
        "stats": "Statistik", "all": "Alle Sets", "none": "Ohne Ordner", "set": "Set",
        "date": "Datum", "people": "Teilnehmende", "correct": "Richtig", "answers": "Antworten",
        "pre_post": "Vorher und nachher", "question": "Frage", "vote1": "Abstimmung 1",
        "vote2": "Abstimmung 2", "sure": "Wie sicher (0–10)", "right": "richtige Antworten",
        "wrong": "falsche Antworten", "nothing": "Noch keine Antworten.", "attempts": "Durchgänge",
        "self_check": "Lernkontrolle",
    },
    "fr": {
        "stats": "Statistiques", "all": "Tous les sets", "none": "Hors dossier", "set": "Set",
        "date": "Date", "people": "Participant·e·s", "correct": "Juste", "answers": "réponses",
        "pre_post": "Avant et après", "question": "Question", "vote1": "Vote 1", "vote2": "Vote 2",
        "sure": "Certitude (0–10)", "right": "bonnes réponses", "wrong": "mauvaises réponses",
        "nothing": "Pas encore de réponses.", "attempts": "passages", "self_check": "Autocontrôle",
    },
}


def _pick(value, lang):
    if isinstance(value, dict):
        return value.get(lang) or next((v for v in value.values() if v), "")
    return value or ""


def _pct(share):
    return "–" if share is None else f"{round(share * 100)} %"


def _plain(html):
    import nh3

    return " ".join(nh3.clean(html or "", tags=set()).split())


def _date(item):
    run = next((r for r in item["runs"] if r["id"] == item["run"]), None)
    return run["date"][:10] if run else ""


def _scope_title(room, data, folder, lang):
    words = WORDS[lang]
    if folder == "all":
        return words["all"]
    if folder == "none":
        return words["none"]
    return data["groups"][0]["title"] if data["groups"] else ""


# -- CSV -------------------------------------------------------------------------


def csv_bytes(room, folder="all", lang="en"):
    data = room_stats(room, folder)
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";")
    header = ["Folder", "Set", "Date", "Participants", "No.", "Question", "Type", "Answers",
              "Correct (%)", "Correct options", "Vote 1 correct (%)", "Confidence (0-10)",
              "Confidence right", "Confidence wrong"]
    header += [f"Option {LETTERS[i]}" for i in range(MAX_OPTIONS)]
    writer.writerow(header)
    for group in data["groups"]:
        folder_title = group["title"] or WORDS[lang]["none"]
        for item in group["sets"]:
            if not item["answers"]:
                continue
            for number, question in enumerate(item["questions"], start=1):
                options = question["options"]
                confidence = question["confidence"] or {}
                peer = question["peer"] or {}
                row = [
                    folder_title, _pick(item["title_map"], lang), _date(item), item["participants"],
                    number, _plain(_pick(question["text"], lang)),
                    "MC" if question["kind"] == "multiple_choice" else "SC", question["answers"],
                    "" if question["correct"] is None else round(question["correct"] * 100),
                    "".join(LETTERS[i] for i, o in enumerate(options) if o["is_correct"]),
                    "" if peer.get("correct") is None else round(peer["correct"] * 100),
                    confidence.get("average", ""), confidence.get("right") or "", confidence.get("wrong") or "",
                ]
                row += [o["count"] for o in options[:MAX_OPTIONS]]
                writer.writerow(row)
    return ("﻿" + buffer.getvalue()).encode("utf-8")


# -- PDF -------------------------------------------------------------------------

PREAMBLE = r"""
#set page(margin: (x: 1.8cm, y: 1.8cm), numbering: "1")
#set text(size: 10pt, lang: "LANG")
#set par(justify: false)
#let green = rgb("#15803d")
#let red = rgb("#dc2626")
#let soft = luma(232)
#let bar(p, fill: green, width: 5cm) = box(width: width, height: 0.7em, radius: 2pt, fill: soft, clip: true,
  align(left, box(width: p * 100%, height: 100%, fill: fill)))
#let tone(p) = if p == none { luma(150) } else if p >= 0.7 { green } else if p >= 0.4 { rgb("#d97706") } else { red }
#let score(p) = if p == none [–] else [#text(fill: tone(p), weight: "bold")[#calc.round(p * 100) %]]
#show heading.where(level: 1): it => block(above: 1.4em, below: 0.7em, width: 100%)[
  #text(size: 15pt, weight: "bold", it.body) #v(-0.5em) #line(length: 100%, stroke: 0.8pt + luma(150))]
#show heading.where(level: 2): it => block(above: 1.2em, below: 0.6em, text(size: 12.5pt, weight: "bold", it.body))
"""


def _num(value):
    return "none" if value is None else repr(float(value))


def _question_block(renderer, number, question, lang, words):
    lines = ["#block(breakable: false, width: 100%, above: 1.1em, below: 1.1em)["]
    first = question["peer"]
    before = (
        f"#text(size: 8.5pt, fill: luma(110))[{words['vote1']}] #score({_num(first['correct'])}) → "
        if first and first["correct"] is not None
        else ""
    )
    lines.append(
        f"  #text(weight: \"bold\")[{words['question']} {number}] #h(0.5em) "
        f"#text(size: 8.5pt, fill: luma(110))[{question['answers']} {words['answers']}] #h(1fr) "
        f"{before}#score({_num(question['correct'])})"
    )
    lines.append("")
    lines.append(renderer.html(_pick(question["text"], lang)))
    lines.append("")
    total = question["answers"]
    peer = question["peer"]
    if question["options"]:
        cells = []
        for index, option in enumerate(question["options"]):
            share = option["count"] / total if total else 0
            fill = "green" if option["is_correct"] else "luma(150)"
            label = renderer.plain(_pick(option["text"], lang)) or " "
            mark = "#text(fill: green)[✓]" if option["is_correct"] else ""
            if peer:
                first_total = peer["votes"]
                first = peer["counts"][index] / first_total if first_total else 0
                bars = (
                    f"#text(size: 7.5pt, fill: luma(120))[{words['vote1']}] #h(0.3em) "
                    f"#bar({first:.4f}, fill: {fill}.lighten(55%)) #h(0.4em) "
                    f"#text(size: 8.5pt)[{peer['counts'][index]} · {round(first * 100)} %] \\ "
                    f"#text(size: 7.5pt, fill: luma(120))[{words['vote2']}] #h(0.3em) "
                    f"#bar({share:.4f}, fill: {fill}) #h(0.4em) "
                    f"#text(size: 8.5pt)[{option['count']} · {round(share * 100)} %]"
                )
            else:
                bars = (
                    f"#bar({share:.4f}, fill: {fill}) #h(0.4em) "
                    f"#text(size: 8.5pt)[{option['count']} · {round(share * 100)} %]"
                )
            cells.append(f"  [*{LETTERS[index]}* {mark}], [{label}], [{bars}],")
        lines.append("#grid(columns: (auto, 1fr, auto), column-gutter: 0.6em, row-gutter: 0.55em, align: horizon,")
        lines.extend(cells)
        lines.append(")")
    confidence = question["confidence"]
    if confidence and confidence["average"] is not None:
        parts = [f"{words['sure']}: Ø {confidence['average']}"]
        if confidence["right"] is not None:
            parts.append(f"{words['right']} {confidence['right']}")
        if confidence["wrong"] is not None:
            parts.append(f"{words['wrong']} {confidence['wrong']}")
        lines.append(f"#v(0.3em) #text(size: 8.5pt, fill: luma(100))[{' · '.join(parts)}]")
    lines.append("]")
    return "\n".join(lines)


def _set_header(renderer, item, lang, words):
    title = renderer.plain(_pick(item["title_map"], lang))
    kind = f" · {words['self_check']}" if item["type"] == "self_check" else ""
    people = f"{item['participants']} {words['attempts'] if item['type'] == 'self_check' else words['people']}"
    return (
        f"== {title}\n#text(size: 9pt, fill: luma(100))[{_date(item)}{kind} · {people}] "
        f"#h(1fr) #score({_num(item['correct'])})\n"
    )


def _group(renderer, group, lang, words):
    out = [f"= {renderer.plain(group['title'] or words['none'])}\n"]
    rows = []
    for item in group["sets"]:
        rows.append(
            f"  [{renderer.plain(_pick(item['title_map'], lang))}], [{_date(item)}], "
            f"[{item['participants']}], [#bar({item['correct'] or 0:.4f}, fill: tone({_num(item['correct'])}), "
            f"width: 3.5cm) #h(0.4em) #score({_num(item['correct'])})],"
        )
    out.append(
        "#table(columns: (1fr, auto, auto, auto), stroke: none, inset: (x: 4pt, y: 5pt), "
        "fill: (_, y) => if y == 0 { luma(240) },\n"
        f"  [*{words['set']}*], [*{words['date']}*], [*{words['people']}*], [*{words['correct']}*],\n"
        + "\n".join(rows) + "\n)\n"
    )
    for pair in group["pairs"]:
        if pair["pre_correct"] is None and pair["post_correct"] is None:
            continue
        pre = next(s for s in group["sets"] if s["id"] == pair["pre"])
        post = next(s for s in group["sets"] if s["id"] == pair["post"])
        out.append(
            f"== {words['pre_post']}: {renderer.plain(_pick(pre['title_map'], lang))} → "
            f"{renderer.plain(_pick(post['title_map'], lang))}\n"
            f"#text(size: 13pt)[#score({_num(pair['pre_correct'])}) #h(0.4em) → #h(0.4em) "
            f"#score({_num(pair['post_correct'])})]\n"
        )
        rows = []
        for number, row in enumerate(pair["questions"], start=1):
            text = _plain(_pick(row["text"], lang))
            short = renderer.plain(text[:90] + ("…" if len(text) > 90 else ""))
            delta = (
                ""
                if row["pre"] is None or row["post"] is None
                else f"{'+' if row['post'] >= row['pre'] else ''}{round((row['post'] - row['pre']) * 100)}"
            )
            rows.append(
                f"  [{number}], [{short}], [#bar({row['pre'] or 0:.4f}, fill: luma(160), width: 2.4cm) "
                f"#score({_num(row['pre'])})], [#bar({row['post'] or 0:.4f}, width: 2.4cm) "
                f"#score({_num(row['post'])})], [{delta}],"
            )
        out.append(
            "#table(columns: (auto, 1fr, auto, auto, auto), stroke: none, inset: (x: 4pt, y: 4pt), "
            "align: horizon, fill: (_, y) => if y == 0 { luma(240) },\n"
            f"  [*\\#*], [*{words['question']}*], [*PRE*], [*POST*], [*Δ*],\n" + "\n".join(rows) + "\n)\n"
        )
    for item in group["sets"]:
        if not item["answers"]:
            continue  # nothing to show yet (the overview says "–")
        out.append("#pagebreak(weak: true)\n")
        out.append(_set_header(renderer, item, lang, words))
        for number, question in enumerate(item["questions"], start=1):
            out.append(_question_block(renderer, number, question, lang, words) + "\n")
    return "\n".join(out)


def pdf_bytes(room, folder="all", lang="en"):
    """(file name, PDF bytes) of the statistics report."""
    import typst

    from common.i18n_fields import translated_map

    lang = lang if lang in WORDS else "en"
    words = WORDS[lang]
    data = room_stats(room, folder)
    if not any(item["answers"] for group in data["groups"] for item in group["sets"]):
        raise ExportError("Nothing to report yet: no answers to single- or multiple-choice questions here.")
    room_title = _pick(translated_map(room, "title"), lang) or room.title
    scope = _scope_title(room, data, folder, lang)
    with tempfile.TemporaryDirectory(prefix="qb-report-") as tmp:
        folder_path = Path(tmp)
        renderer = Renderer(folder_path, rel="figures/", figure_height=3.5)
        body = [
            PREAMBLE.replace("LANG", lang),
            f"#align(center, text(size: 17pt, weight: \"bold\")[{words['stats']}: {renderer.plain(room_title)}])",
            (
                f"#align(center, text(fill: luma(90))[{renderer.plain(scope)} · "
                f"{timezone.localdate().isoformat()}])"
            ),
            "",
        ]
        body += [
            _group(renderer, group, lang, words)
            for group in data["groups"]
            if any(item["answers"] for item in group["sets"])
        ]
        source = "\n".join(body)
        compiler = typst.Compiler(root=str(folder_path), ignore_system_fonts=True)
        renderer.check_math(compiler)
        path = folder_path / "report.typ"
        path.write_text(renderer.finish(source))
        try:
            pdf = compiler.compile(input=str(path), format="pdf", sys_inputs={})
        except typst.TypstError as error:
            raise ExportError(f"Typst could not compile the report: {error.message}") from error
    stem = slugify(f"{room_title} {scope} statistics")[:80] or "statistics"
    return f"{stem}.pdf", pdf


def csv_name(room, folder, lang):
    from common.i18n_fields import translated_map

    data_scope = WORDS[lang]["all"] if folder == "all" else WORDS[lang]["none"] if folder == "none" else ""
    if folder not in ("all", "none"):
        found = room.qb_folders.filter(pk=folder).first()
        data_scope = found.title if found else ""
    title = _pick(translated_map(room, "title"), lang) or room.title
    return (slugify(f"{title} {data_scope} statistics")[:80] or "statistics") + ".csv"
