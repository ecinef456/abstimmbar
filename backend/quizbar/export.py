# SPDX-License-Identifier: Apache-2.0
"""PDF export of single- and multiple-choice questions, typeset with Typst.

A room (folders → sets), a folder (sets) or a list of library entries
becomes one Typst document per language, written with the quizbar.typ
package (the same one the Typst import reads). Each document is compiled
without solutions (empty circles / squares to tick) and/or with solutions
(correct answers filled, the "why" of every answer below it).

One PDF comes back as it is; several come back as a zip:

    <name>/quizbar.typ  figures/  README.txt
    <name>/<lang>/<name>.typ  <name>.pdf  <name>-solutions.pdf

Question HTML is converted to Typst markup: text is escaped, Typst math
(``$…$``) is kept, LaTeX math is shown as source (Typst cannot typeset it),
and images from /media/ are copied into figures/.
"""
import io
import posixpath
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

from django.conf import settings
from django.db.models import Prefetch
from django.utils import timezone
from django.utils.text import slugify

from common.i18n_fields import translated_map
from rooms.models import AnswerOption, Question

from . import i18n
from .models import LibraryEntry, QuestionLineage

LANGS = i18n.LANGS
CHOICE = ("single_choice", "multiple_choice")
MAX_QUESTIONS = 3000
PACKAGE = Path(__file__).resolve().parent / "typst" / "quizbar.typ"

WORDS = {
    "en": {"library": "Question library", "other": "Other quizzes", "tags": "Tags"},
    "de": {"library": "Fragenbibliothek", "other": "Weitere Quiz", "tags": "Tags"},
    "fr": {"library": "Bibliothèque de questions", "other": "Autres quiz", "tags": "Tags"},
}

# Text area of an A4 page with quizbar.typ's margins (cm).
TEXT_WIDTH = 21.0 - 2 * 2.2
FIGURE_WIDTH = 0.6 * TEXT_WIDTH
FIGURE_HEIGHT = 7.5
OPTION_IMAGE_WIDTH = 6.0
OPTION_IMAGE_HEIGHT = 2.5
IMAGE_TYPES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")


class ExportError(Exception):
    """Something the teacher should see (nothing to export, Typst failed)."""


# -- what goes into a document --------------------------------------------------


@dataclass
class Document:
    """The parts of an export, before any language is chosen."""

    name: str  # file name stem
    title: object  # str, or {lang: str}
    description: object = ""
    # ("section", title, level) | ("question", Question)
    items: list = field(default_factory=list)

    def questions(self):
        return [item[1] for item in self.items if item[0] == "question"]


def _title(obj, base="title"):
    """{lang: text} of a modeltranslation field, falling back to the original."""
    values = translated_map(obj, base)
    original = values.get(settings.MODELTRANSLATION_DEFAULT_LANGUAGE) or next(
        (v for v in values.values() if v), ""
    )
    return {lang: values.get(lang) or original for lang in LANGS}


def _natural(text):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", text)]


def _questions_query():
    return (
        Question.objects.filter(kind__in=CHOICE, qb_synced_from__isnull=True)
        .order_by("position", "id")
        .prefetch_related(
            Prefetch(
                "options",
                queryset=AnswerOption.objects.filter(is_abstention=False)
                .select_related("qb_justification")
                .order_by("position", "id"),
                to_attr="qb_export_options",
            )
        )
    )


def _usable(question):
    return len(question.qb_export_options) >= 2


def _by_set(set_ids):
    out = {set_id: [] for set_id in set_ids}
    for question in _questions_query().filter(question_set_id__in=set_ids):
        if _usable(question):
            out[question.question_set_id].append(question)
    return out


def _set_sequence(folder):
    sets = [p.question_set for p in folder.placements.select_related("question_set")]
    if not folder.ordered:
        sets.sort(key=lambda s: _natural(_title(s)["de"] or ""))
    return sets


def _add_sets(document, sets, questions, level):
    for question_set in sets:
        found = questions.get(question_set.pk) or []
        if found:
            document.items.append(("section", _title(question_set), level))
            document.items.extend(("question", q) for q in found)


def room_document(room):
    folders = list(room.qb_folders.prefetch_related("placements"))
    all_sets = list(room.question_sets.all())
    questions = _by_set([s.pk for s in all_sets])
    document = Document(name=room.title, title=_title(room))
    placed = set()
    for folder in folders:
        sets = _set_sequence(folder)
        placed.update(s.pk for s in sets)
        if any(questions.get(s.pk) for s in sets):
            document.items.append(("section", folder.title, 1))
            _add_sets(document, sets, questions, 2)
    rest = sorted((s for s in all_sets if s.pk not in placed), key=lambda s: _natural(_title(s)["de"]))
    if any(questions.get(s.pk) for s in rest):
        if folders:
            document.items.append(("section", {lang: WORDS[lang]["other"] for lang in LANGS}, 1))
            _add_sets(document, rest, questions, 2)
        else:
            _add_sets(document, rest, questions, 1)
    return document


def folder_document(folder):
    sets = _set_sequence(folder)
    questions = _by_set([s.pk for s in sets])
    document = Document(
        name=f"{folder.room.title} {folder.title}",
        title=folder.title,
        description=_title(folder.room),
    )
    _add_sets(document, sets, questions, 1)
    return document


def library_document(owner, entry_ids, label=""):
    entries = LibraryEntry.objects.filter(owner=owner, pk__in=entry_ids, master__isnull=False)
    masters = {e.pk: e.master_id for e in entries}
    found = {q.pk: q for q in _questions_query().filter(pk__in=masters.values())}
    document = Document(
        name="library" + (f" {label}" if label else ""),
        title={lang: WORDS[lang]["library"] for lang in LANGS},
        description=label,
    )
    for entry_id in entry_ids:  # the order the library showed
        question = found.get(masters.get(entry_id))
        if question and _usable(question):
            document.items.append(("question", question))
    return document


def _tags(questions):
    """{question id: [tag, …]} from the library."""
    out = {}
    lineage = QuestionLineage.objects.filter(question__in=questions).prefetch_related("entry__tags")
    for row in lineage:
        out[row.question_id] = [tag.name for tag in row.entry.tags.all()]
    return out


# -- HTML / text → Typst markup ---------------------------------------------------

LATEX_COMMAND = re.compile(r"\\[a-zA-Z]")
ALWAYS = set("\\#*_`$<>@[]~")
LINE_START = set("=-+/")
HTML_TAG = re.compile(r"</?(p|br|strong|em|b|i|u|s|sub|sup|span|code|a|ul|ol|li|div)\b[^>]*>", re.IGNORECASE)
MATH = "\ue000{}\ue001"
MATH_RE = re.compile("\ue000(\\d+)\ue001")


def typst_string(text):
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def math_segments(src):
    """Split a text node like the app does (mathCore.ts): yields
    ("text", s), ("typst", body) and ("raw", source) — LaTeX, or Typst math
    with code in it, shown as its source."""
    text, i, n = [], 0, len(src)

    def flush():
        if text:
            yield ("text", "".join(text))
            text.clear()

    while i < n:
        ch = src[i]
        if ch == "\\" and src.startswith("$", i + 1):
            text.append("$")
            i += 2
        elif src.startswith("$$", i) or src.startswith("\\(", i) or src.startswith("\\[", i):
            closing = {"$$": "$$", "\\(": "\\)", "\\[": "\\]"}[src[i : i + 2]]
            end = src.find(closing, i + 2)
            if end < 0:
                text.append(src[i:])
                break
            yield from flush()
            yield ("raw", src[i : end + 2])
            i = end + 2
        elif ch == "$":
            end = i + 1
            while end < n and not (src[end] == "$" and src[end - 1] != "\\"):
                end += 1
            if end >= n:
                text.append(src[i:])
                break
            body = src[i + 1 : end]
            if not body.strip():
                text.append(src[i : end + 1])
            else:
                yield from flush()
                if LATEX_COMMAND.search(body) or "#" in body:
                    yield ("raw", src[i : end + 1])
                else:
                    yield ("typst", body)
            i = end + 1
        else:
            text.append(ch)
            i += 1
    yield from flush()


class _Node:
    def __init__(self, tag, attrs=None, parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs or ()), parent, []


class _Tree(HTMLParser):
    VOID = frozenset({"br", "img", "hr", "wbr", "input"})

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.current = _Node("root")

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in self.VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.current.children.append(_Node(tag, attrs, self.current))

    def handle_endtag(self, tag):
        node = self.current
        while node is not None and node.tag != tag:
            node = node.parent
        if node is not None and node.parent is not None:
            self.current = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


INLINE = {
    "strong": "strong", "b": "strong", "em": "emph", "i": "emph",
    "u": "underline", "s": "strike", "del": "strike", "sub": "sub", "sup": "super",
}
BLOCKS = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "figure"}


class Markup:
    """Builds Typst markup with correct escaping (see ``text``)."""

    def __init__(self, renderer):
        self.renderer = renderer
        self.parts = []
        self.line_start = True
        self.after_code = False
        self.indent = ""
        self.in_list = 0

    def raw(self, s, code=False):
        if s:
            self.parts.append(s)
            self.line_start = s.endswith(("\n" + self.indent, "\n"))
            self.after_code = code

    def newline(self):
        self.raw("\n" + self.indent)
        self.line_start = True

    def text(self, s):
        """Plain text, escaped: characters with a meaning in Typst markup get
        a backslash — some always, some only at the start of a line (lists,
        headings, "1." numbering) or right after a #call (".", "(")."""
        out = []
        dot_at = None  # "12." at the start of a line: escape that dot
        for index, ch in enumerate(s):
            if self.line_start and ch.isspace():
                continue
            nxt = s[index + 1 : index + 2]
            if self.line_start and ch.isdigit():
                number = re.match(r"\d+\.", s[index:])
                dot_at = index + len(number.group()) - 1 if number else None
            if (
                ch in ALWAYS
                or (self.line_start and ch in LINE_START)
                or (ch == "-" and nxt in ("-", "?"))
                or (ch == "/" and nxt in ("/", "*"))
                or (self.after_code and ch in ".(")
                or index == dot_at
            ):
                out.append("\\" + ch)
            else:
                out.append(ch)
            self.line_start = False
            self.after_code = False
        if out:
            self.parts.append("".join(out))

    def content(self, s, html_whitespace=True):
        """A text node, math included."""
        if html_whitespace:
            s = re.sub(r"\s+", " ", s)
        for kind, value in math_segments(s):
            if kind == "text":
                if html_whitespace:
                    self.text(value)
                else:
                    lines = value.split("\n")
                    for number, line in enumerate(lines):
                        if number:
                            self.raw(" \\")
                            self.newline()
                        self.text(line)
            else:
                self.raw(self.renderer.math(kind, value), code=True)

    def block_break(self):
        if not self.parts or self.line_start:
            return
        if self.in_list:
            self.raw(" \\")
            self.newline()
        else:
            self.raw("\n\n" + self.indent)
            self.line_start = True

    def result(self):
        return "".join(self.parts).strip()


class Renderer:
    """Converts one export's texts; collects figures and math."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self.figures = {}  # media path → file name in figures/
        self.math_items = []  # (kind, value)
        self.bad = set()  # Typst math that does not compile

    # math: kept as placeholders until checked (see check_math)
    def math(self, kind, value):
        self.math_items.append((kind, value))
        return MATH.format(len(self.math_items) - 1)

    def check_math(self, compiler):
        """Typst math that does not compile is shown as source instead of
        failing the whole export."""
        typst_items = [i for i, (kind, _) in enumerate(self.math_items) if kind == "typst"]
        if not typst_items:
            return
        import typst

        probe = self.folder / "_math.typ"
        for _ in range(60):
            lines = [i for i in typst_items if i not in self.bad]
            if not lines:
                return
            probe.write_text("\n".join(f"${self.math_items[i][1]}$" for i in lines) + "\n")
            try:
                compiler.compile(input=str(probe), format="pdf", sys_inputs={})
                return
            except typst.TypstError as error:
                found = re.search(r"_math\.typ:(\d+):", error.diagnostic or "")
                line = int(found.group(1)) if found else 0
                if not 1 <= line <= len(lines):
                    self.bad.update(lines)
                    return
                self.bad.add(lines[line - 1])
            finally:
                probe.unlink(missing_ok=True)
        self.bad.update(typst_items)

    def finish(self, markup):
        def replace(match):
            index = int(match.group(1))
            kind, value = self.math_items[index]
            if kind == "typst" and index not in self.bad:
                return f"${value}$"
            source = value if kind == "raw" else f"${value}$"
            return f"#raw({typst_string(source)})"

        return MATH_RE.sub(replace, markup)

    # images
    def figure(self, src):
        """File name in figures/ for an image URL from /media/, else None."""
        if not src:
            return None
        if src in self.figures:
            return self.figures[src]
        path = re.sub(r"^https?://[^/]+", "", src.split("?")[0].split("#")[0])
        media_url = "/" + settings.MEDIA_URL.strip("/") + "/"
        if not path.startswith(media_url):
            return None
        relative = posixpath.normpath(path[len(media_url) :])
        if relative.startswith(("..", "/")):
            return None
        source = Path(settings.MEDIA_ROOT) / relative
        if source.suffix.lower() not in IMAGE_TYPES or not source.is_file():
            return None
        name = source.name
        taken = set(self.figures.values())
        stem, suffix, number = source.stem, source.suffix, 2
        while name in taken:
            name = f"{stem}-{number}{suffix}"
            number += 1
        target = self.folder / "figures" / name
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, target)
        self.figures[src] = name
        return name

    def image_call(self, name, max_width, max_height, rel="../figures/"):
        width = max_width
        try:
            from PIL import Image

            with Image.open(self.folder / "figures" / name) as image:
                w, h = image.size
        except Exception:  # noqa: BLE001 — SVG and the like: default width
            w = h = 0
        if w and h:
            width = min(max_width, max_height * w / h)
        return f"image({typst_string(rel + name)}, width: {width:.2f}cm)"

    # converters
    def html(self, html):
        tree = _Tree()
        tree.feed(html or "")
        tree.close()
        markup = Markup(self)
        self._children(tree.root, markup)
        return markup.result()

    def plain(self, text):
        """Plain text (answer options, justifications); HTML in them, as
        some older content has, is converted like question text."""
        if HTML_TAG.search(text or ""):
            return self.html(text)
        markup = Markup(self)
        markup.content((text or "").strip(), html_whitespace=False)
        return markup.result()

    def _children(self, node, markup):
        for child in node.children:
            if isinstance(child, str):
                markup.content(child)
            else:
                self._node(child, markup)

    def _wrapped(self, call, node, markup):
        inner = Markup(self)
        inner.line_start = False
        self._children(node, inner)
        body = "".join(inner.parts).strip()
        if body:
            markup.raw(f"#{call}[{body}]", code=True)

    def _node(self, node, markup):
        tag = node.tag
        if tag in INLINE:
            self._wrapped(INLINE[tag], node, markup)
        elif tag == "a":
            href = node.attrs.get("href") or ""
            if re.match(r"^(https?:|mailto:)", href):
                self._wrapped(f"link({typst_string(href)})", node, markup)
            else:
                self._children(node, markup)
        elif tag == "br":
            if not markup.line_start:
                markup.raw(" \\")
                markup.newline()
        elif tag == "img":
            name = self.figure(node.attrs.get("src"))
            if name:
                if not markup.line_start:
                    markup.newline()
                markup.raw("#align(center, " + self.image_call(name, FIGURE_WIDTH, FIGURE_HEIGHT) + ")")
                markup.newline()
        elif tag in ("ul", "ol"):
            self._list(node, markup, "- " if tag == "ul" else "+ ")
        elif tag == "code":
            markup.raw(f"#raw({typst_string(_text_of(node))})", code=True)
        elif tag == "pre":
            markup.block_break()
            markup.raw(f"#raw(block: true, {typst_string(_text_of(node))})")
            markup.newline()
        elif tag == "hr":
            markup.block_break()
            markup.raw("#line(length: 100%)")
            markup.newline()
        elif tag in BLOCKS:
            markup.block_break()
            if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                self._wrapped("strong", node, markup)
            else:
                self._children(node, markup)
            markup.block_break()
        elif tag in ("script", "style"):
            return
        else:
            self._children(node, markup)

    def _list(self, node, markup, marker):
        if not markup.line_start:
            markup.newline()
        outer = markup.indent
        markup.in_list += 1
        for item in node.children:
            if isinstance(item, str) or item.tag != "li":
                continue
            if not markup.line_start:
                markup.indent = outer
                markup.newline()
            markup.raw(marker)
            markup.line_start = True
            markup.indent = outer + "  "
            self._children(item, markup)
            markup.indent = outer
        markup.in_list -= 1
        markup.indent = outer
        if markup.in_list:
            markup.newline()
        else:  # a blank line ends the list
            markup.raw("\n\n" + outer)
            markup.line_start = True


def _text_of(node):
    return "".join(c if isinstance(c, str) else _text_of(c) for c in node.children)


# -- writing and compiling ------------------------------------------------------


def _pick(value, lang):
    if isinstance(value, dict):
        return value.get(lang) or ""
    return value or ""


def _question(renderer, question, lang, tags):
    options = question.qb_export_options
    right = sum(1 for o in options if o.is_correct)
    kind = "MC" if question.kind == "multiple_choice" or right > 1 else "SC"
    lines = ["#question(", "  [", renderer.html(i18n.text_in(lang, question)), "  ],", f'  kind: "{kind}",']
    lines.append("  answers: (")
    for option in options:
        body = renderer.plain(i18n.text_in(lang, question, option))
        name = renderer.figure(option.image)
        if name:
            picture = "#box(" + renderer.image_call(name, OPTION_IMAGE_WIDTH, OPTION_IMAGE_HEIGHT) + ")"
            body = f"{body} \\\n{picture}" if body else picture
        original = getattr(getattr(option, "qb_justification", None), "text", "") or ""
        why = renderer.plain(i18n.justification(option.pk, lang, original, question))
        why_arg = f", why: [{why}]" if why else ""
        lines.append(f"    answer({'true' if option.is_correct else 'false'}, [{body}]{why_arg}),")
    lines.append("  ),")
    if tags:
        lines.append("  tags: (" + "".join(typst_string(t) + ", " for t in tags) + "),")
    if question.time_limit:
        lines.append(f"  time-limit-s: {int(question.time_limit)},")
    lines.append(")")
    return "\n".join(lines)


def _source(document, renderer, lang, tags, stem):
    title = renderer.plain(_pick(document.title, lang))
    description = renderer.plain(_pick(document.description, lang))
    stamp = timezone.localdate().isoformat()
    head = [
        f"// Exported from abstimmbar on {stamp}.",
        "// Compile from the export folder (one level up):",
        f"//   typst compile --root . {lang}/{stem}.typ",
        f"//   typst compile --root . --input solutions=true {lang}/{stem}.typ {lang}/{stem}-solutions.pdf",
        '#import "../quizbar.typ": *',
        "#show: quizbar.with(",
        f"  title: [{title}],",
        f'  lang: "{lang}",',
    ]
    if description:
        head.append(f"  description: [{description}],")
    head += ['  figures: "figures",', ")", ""]
    body = []
    for item in document.items:
        if item[0] == "section":
            heading = renderer.plain(_pick(item[1], lang))
            body.append(f"#section([{heading}], level: {item[2]})\n")
        else:
            body.append(_question(renderer, item[1], lang, tags.get(item[1].pk)) + "\n")
    return "\n".join(head + body)


def _stem(text):
    return slugify(text or "")[:60].strip("-") or "quizzes"


README = """Exported from abstimmbar: single- and multiple-choice questions.

Each language folder holds the Typst source and its PDFs:
  NAME.pdf             without solutions (tick the circles / squares)
  NAME-solutions.pdf   with the correct answers and why

To change and recompile (Typst 0.13 or newer), from this folder:
  typst compile --root . LANG/NAME.typ
  typst compile --root . --input solutions=true LANG/NAME.typ LANG/NAME-solutions.pdf

quizbar.typ is the package (the same as in abstimmbar's Typst import);
the pictures are in figures/.
"""


def build(document, langs, solutions, blank):
    """Compile ``document``. Returns (file name, content type, bytes)."""
    import typst

    langs = [lang for lang in LANGS if lang in langs]
    variants = [v for v, wanted in (("blank", blank), ("solutions", solutions)) if wanted]
    if not langs or not variants:
        raise ExportError("Choose at least one language and one version.")
    questions = document.questions()
    if not questions:
        raise ExportError("Nothing to export: there are no single- or multiple-choice questions here.")
    if len(questions) > MAX_QUESTIONS:
        raise ExportError(f"Too many questions (at most {MAX_QUESTIONS}).")
    i18n.preload(questions)
    tags = _tags(questions)
    stem = _stem(document.name)

    with tempfile.TemporaryDirectory(prefix="qb-export-") as tmp:
        folder = Path(tmp)
        shutil.copyfile(PACKAGE, folder / "quizbar.typ")
        renderer = Renderer(folder)
        sources = {lang: _source(document, renderer, lang, tags, stem) for lang in langs}
        compiler = typst.Compiler(root=str(folder), ignore_system_fonts=True)
        renderer.check_math(compiler)
        pdfs = {}
        for lang in langs:
            (folder / lang).mkdir()
            path = folder / lang / f"{stem}.typ"
            path.write_text(renderer.finish(sources[lang]))
            for variant in variants:
                try:
                    pdfs[(lang, variant)] = compiler.compile(
                        input=str(path),
                        format="pdf",
                        sys_inputs={"solutions": "true" if variant == "solutions" else "false"},
                    )
                except typst.TypstError as error:
                    raise ExportError(f"Typst could not compile the export: {error.message}") from error

        if len(pdfs) == 1:
            (lang, variant), data = next(iter(pdfs.items()))
            suffix = "-solutions" if variant == "solutions" else ""
            return f"{stem}-{lang}{suffix}.pdf", "application/pdf", data

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"{stem}/README.txt", README.replace("NAME", stem))
            archive.write(folder / "quizbar.typ", f"{stem}/quizbar.typ")
            for name in sorted(set(renderer.figures.values())):
                archive.write(folder / "figures" / name, f"{stem}/figures/{name}")
            for lang in langs:
                archive.write(folder / lang / f"{stem}.typ", f"{stem}/{lang}/{stem}.typ")
                for variant in variants:
                    suffix = "-solutions" if variant == "solutions" else ""
                    archive.writestr(f"{stem}/{lang}/{stem}{suffix}.pdf", pdfs[(lang, variant)])
        return f"{stem}.zip", "application/zip", buffer.getvalue()
