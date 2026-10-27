# SPDX-License-Identifier: Apache-2.0
"""Import a quiz written with the quizbar Typst package (quizbar.typ).

We do not run Typst: the file's ``#show: quizbar.with(...)`` and every
``#question(...)`` call are read with a small parser for Typst's argument
syntax (content blocks, strings, arrays, dictionaries, calls). Content is
turned into the app's formats: question text as HTML (paragraphs, lists,
*bold*, _italic_), answers and justifications as plain text — math stays
``$…$`` Typst math in both, which the app renders.
"""
import html
import posixpath
import re
from dataclasses import dataclass, field

SET_TYPES = {"live": "live_poll", "quiz": "self_paced", "self-check": "self_check"}
LANGS = ("en", "de", "fr")
MAX_QUESTIONS = 300


class TypstImportError(ValueError):
    pass


# -- values ------------------------------------------------------------------


@dataclass
class Content:
    src: str


@dataclass
class Call:
    name: str
    args: list = field(default_factory=list)
    named: dict = field(default_factory=dict)


@dataclass
class Code:
    """An expression we do not evaluate (kept as source)."""

    src: str


# -- parser ------------------------------------------------------------------


class Parser:
    def __init__(self, src):
        self.src = src
        self.i = 0

    def error(self, message, at=None):
        at = self.i if at is None else at
        line = self.src.count("\n", 0, at) + 1
        raise TypstImportError(f"Line {line}: {message}")

    def peek(self, n=0):
        j = self.i + n
        return self.src[j] if j < len(self.src) else ""

    def skip_ws(self):
        while self.i < len(self.src):
            c = self.src[self.i]
            if c.isspace():
                self.i += 1
            elif self.src.startswith("//", self.i):
                end = self.src.find("\n", self.i)
                self.i = len(self.src) if end < 0 else end
            elif self.src.startswith("/*", self.i):
                end = self.src.find("*/", self.i + 2)
                self.i = len(self.src) if end < 0 else end + 2
            else:
                break

    def expect(self, ch):
        self.skip_ws()
        if self.peek() != ch:
            self.error(f"expected “{ch}”")
        self.i += 1

    # strings, content, raw ---------------------------------------------------

    def string(self):
        start = self.i
        self.i += 1
        out = []
        escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}
        while self.i < len(self.src):
            c = self.src[self.i]
            if c == "\\":
                nxt = self.peek(1)
                if nxt == "u" and self.peek(2) == "{":
                    end = self.src.find("}", self.i)
                    out.append(chr(int(self.src[self.i + 3 : end], 16)))
                    self.i = end + 1
                    continue
                out.append(escapes.get(nxt, nxt))
                self.i += 2
                continue
            if c == '"':
                self.i += 1
                return "".join(out)
            out.append(c)
            self.i += 1
        self.error("unterminated string", start)
        return ""

    def _skip_raw(self):
        # `code` or ```block```
        ticks = 0
        while self.peek() == "`":
            ticks += 1
            self.i += 1
        if ticks == 2:  # empty raw ``
            return
        end = self.src.find("`" * ticks, self.i)
        if end < 0:
            self.error("unterminated raw text")
        self.i = end + ticks

    def _skip_math(self):
        start = self.i
        self.i += 1
        while self.i < len(self.src):
            c = self.src[self.i]
            if c == "\\":
                self.i += 2
            elif c == '"':
                self.string()
            elif c == "$":
                self.i += 1
                return
            else:
                self.i += 1
        self.error("unterminated math ($…$)", start)

    def content(self):
        """A [...] block; returns its source between the brackets."""
        start = self.i
        self.i += 1
        depth = 1
        while self.i < len(self.src):
            c = self.src[self.i]
            if c == "\\":
                self.i += 2
            elif c == "$":
                self._skip_math()
            elif c == "`":
                self._skip_raw()
            elif self.src.startswith("//", self.i) and self.src[self.i - 1 : self.i] != ":":
                end = self.src.find("\n", self.i)
                self.i = len(self.src) if end < 0 else end
            elif self.src.startswith("/*", self.i):
                end = self.src.find("*/", self.i + 2)
                self.i = len(self.src) if end < 0 else end + 2
            elif c == "[":
                depth += 1
                self.i += 1
            elif c == "]":
                depth -= 1
                self.i += 1
                if depth == 0:
                    return Content(self.src[start + 1 : self.i - 1])
            else:
                self.i += 1
        self.error("unterminated content block […]", start)
        return Content("")

    # code values -------------------------------------------------------------

    def args(self):
        """Arguments after '(' up to ')': (positional, named)."""
        self.expect("(")
        positional, named = [], {}
        while True:
            self.skip_ws()
            if self.peek() == ")":
                self.i += 1
                break
            match = re.compile(r"([A-Za-z_][\w-]*)\s*:(?!:)").match(self.src, self.i)
            if match:
                self.i = match.end()
                named[match.group(1)] = self.value()
            else:
                positional.append(self.value())
            self.skip_ws()
            if self.peek() == ",":
                self.i += 1
            elif self.peek() != ")":
                self.error("expected “,” or “)”")
        # Trailing content blocks: f(...)[...]
        while self.peek() == "[":
            positional.append(self.content())
        return positional, named

    def value(self):
        self.skip_ws()
        c = self.peek()
        if c == "[":
            return self.content()
        if c == '"':
            return self.string()
        if c == "(":
            return self.collection()
        if c == "$":
            start = self.i
            self._skip_math()
            return Content(self.src[start : self.i])
        match = re.compile(r"-?\d+(\.\d+)?([a-z%]+)?").match(self.src, self.i)
        if match:
            self.i = match.end()
            number, unit = match.group(0), match.group(2)
            if unit:
                return Code(number)
            return float(number) if "." in number else int(number)
        match = re.compile(r"[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*").match(self.src, self.i)
        if match:
            self.i = match.end()
            name = match.group(0)
            if name in ("true", "false"):
                return name == "true"
            if name in ("none", "auto"):
                return None
            if self.peek() in ("(", "["):
                if self.peek() == "(":
                    positional, named = self.args()
                else:
                    positional, named = [], {}
                    while self.peek() == "[":
                        positional.append(self.content())
                return Call(name, positional, named)
            return Code(name)
        self.error("cannot read this value")
        return None

    def collection(self):
        start = self.i
        self.i += 1
        self.skip_ws()
        if self.src.startswith(":)", self.i):
            self.i += 2
            return {}
        items, named, single, trailing_comma = [], {}, True, False
        while True:
            self.skip_ws()
            if self.peek() == ")":
                self.i += 1
                break
            match = re.compile(r"([A-Za-z_][\w-]*|\"[^\"]*\")\s*:(?!:)").match(self.src, self.i)
            if match:
                self.i = match.end()
                named[match.group(1).strip('"')] = self.value()
            else:
                items.append(self.value())
            self.skip_ws()
            if self.peek() == ",":
                self.i += 1
                trailing_comma = True
                single = False
            elif self.peek() == ")":
                trailing_comma = False
            else:
                self.error("expected “,” or “)”", start)
        if named:
            return named
        # (x) is just x, (x,) is an array.
        if len(items) == 1 and single and not trailing_comma:
            return items[0]
        return items


# -- markup → html / text --------------------------------------------------------

_ESCAPABLE = set("\\*_$#[]`<>@=-+/\"'~")


def _inline(src, rich):
    """Typst markup (one paragraph) → HTML (rich) or plain text."""
    out = []
    i, n = 0, len(src)
    stack = []  # open "*" / "_"
    esc = html.escape if rich else (lambda s: s)
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n:
            nxt = src[i + 1]
            if nxt in _ESCAPABLE:
                out.append(esc(nxt))
                i += 2
                continue
            if nxt in " \n":  # forced line break
                out.append("<br>" if rich else "\n")
                i += 2
                continue
        if c == "$":
            j = i + 1
            while j < n and src[j] != "$":
                if src[j] == "\\":
                    j += 1
                elif src[j] == '"':
                    j = src.find('"', j + 1)
                    if j < 0:
                        j = n
                j += 1
            out.append(esc(src[i : j + 1]))
            i = j + 1
            continue
        if c == "`":
            end = src.find("`", i + 1)
            end = n if end < 0 else end
            out.append(esc(src[i + 1 : end]))
            i = end + 1
            continue
        before = src[i - 1] if i else " "
        after = src[i + 1] if i + 1 < n else " "
        if c in "*_":
            # Typst: strong/emph delimiters; inside a word an opening one
            # is literal (snake_case, 2*3).
            if stack and stack[-1] == c and not before.isspace():
                stack.pop()
                if rich:
                    out.append("</strong>" if c == "*" else "</em>")
                i += 1
                continue
            if not before.isalnum() and not after.isspace() and src.find(c, i + 1) > i:
                stack.append(c)
                if rich:
                    out.append("<strong>" if c == "*" else "<em>")
                i += 1
                continue
        if c == "#":
            match = re.compile(r"#([A-Za-z_][\w.-]*)").match(src, i)
            if match:
                parser = Parser(src)
                parser.i = match.end()
                name = match.group(1)
                positional = []
                try:
                    if parser.peek() == "(":
                        positional, _ = parser.args()
                    while parser.peek() == "[":
                        positional.append(parser.content())
                except TypstImportError:
                    positional = []
                i = parser.i
                if name in ("linebreak",):
                    out.append("<br>" if rich else "\n")
                elif name in ("h", "v", "hide", "pagebreak", "colbreak"):
                    out.append(" ")
                else:
                    inner = next((p for p in positional if isinstance(p, Content)), None)
                    text = next((p for p in positional if isinstance(p, str)), None)
                    if inner is not None:
                        body = _inline(inner.src, rich)
                        if rich and name in ("strong", "emph"):
                            tag = "strong" if name == "strong" else "em"
                            body = f"<{tag}>{body}</{tag}>"
                        out.append(body)
                    elif text is not None:
                        out.append(esc(text))
                    elif name.startswith("sym."):
                        out.append(esc(name))
                continue
        if c == "~":
            out.append(" ")
            i += 1
            continue
        if src.startswith("---", i):
            out.append("—")
            i += 3
            continue
        if src.startswith("--", i):
            out.append("–")
            i += 2
            continue
        out.append(esc(c))
        i += 1
    if rich:
        for c in reversed(stack):
            out.append("</strong>" if c == "*" else "</em>")
    return "".join(out)


def _blocks(src):
    """Split markup into paragraphs and list blocks."""
    def is_item(line):
        return bool(re.match(r"^[-+]\s", line))

    lines = [line.strip() for line in src.strip().splitlines()]
    blocks, current = [], []
    for line in lines:
        if not line:
            if current:
                blocks.append(current)
                current = []
            continue
        # A list starts a new block; lines after an item continue it.
        if current and is_item(line) and not is_item(current[0]):
            blocks.append(current)
            current = []
        current.append(line)
    if current:
        blocks.append(current)
    return blocks


def markup_to_html(src):
    parts = []
    for block in _blocks(src):
        if re.match(r"^[-+]\s", block[0]):
            tag = "ul" if block[0][0] == "-" else "ol"
            items = []
            for line in block:
                if re.match(r"^[-+]\s", line):
                    items.append(line[2:].strip())
                elif items:
                    items[-1] += " " + line
            lis = "".join(f"<li>{_inline(item, True)}</li>" for item in items)
            parts.append(f"<{tag}>{lis}</{tag}>")
        else:
            parts.append(f"<p>{_inline(' '.join(block), True)}</p>")
    return "".join(parts)


def markup_to_text(src):
    lines = []
    for block in _blocks(src):
        lines.append(" ".join(_inline(line, False) for line in block))
    return " ".join(lines).strip()


# -- reading a quiz file -----------------------------------------------------


def _text_of(value, what, parser, at):
    if isinstance(value, Content):
        return value.src
    if isinstance(value, str):
        return value
    parser.error(f"{what} must be […] or a string", at)
    return ""


@dataclass
class ParsedQuestion:
    text_html: str
    kind: str
    options: list
    image: str | None
    tags: list
    time_limit: int | None
    shuffle: bool


@dataclass
class ParsedQuiz:
    title: str
    set_type: str
    description_html: str
    figures: str
    questions: list
    lang: str = ""


def _find_calls(src, pattern):
    """Positions right after `pattern` outside comments, raw text and strings."""
    found, i, n = [], 0, len(src)
    regex = re.compile(pattern)
    while i < n:
        if src.startswith("//", i) and src[i - 1 : i] != ":":
            end = src.find("\n", i)
            i = n if end < 0 else end
            continue
        if src.startswith("/*", i):
            end = src.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if src[i] == "`":
            p = Parser(src)
            p.i = i
            try:
                p._skip_raw()
            except TypstImportError:
                return found
            i = p.i
            continue
        if src[i] == "\\":
            i += 2
            continue
        match = regex.match(src, i)
        if match:
            found.append(match.end())
            i = match.end()
            continue
        i += 1
    return found


def parse(src):
    """Read a quizbar .typ file. Raises TypstImportError with a line number."""
    parser = Parser(src)
    title, set_type, description, figures, lang = "", "live", "", "figures", ""
    for pos in _find_calls(src, r"#show\s*:\s*quizbar\.with\s*(?=\()"):
        parser.i = pos
        _, named = parser.args()
        if named.get("title"):
            title = markup_to_text(_text_of(named["title"], "title", parser, pos))[:200]
        set_type = named.get("type") or "live"
        if set_type not in SET_TYPES:
            parser.error('type must be "live", "quiz" or "self-check"', pos)
        if named.get("description"):
            description = _text_of(named["description"], "description", parser, pos)
        if isinstance(named.get("figures"), str):
            figures = named["figures"]
        if named.get("lang") is not None:
            lang = str(named["lang"]).lower()
            if lang not in LANGS:
                parser.error('lang must be "en", "de" or "fr"', pos)
        break

    questions = []
    for pos in _find_calls(src, r"#question\s*(?=\()"):
        parser.i = pos
        positional, named = parser.args()
        if len(questions) >= MAX_QUESTIONS:
            parser.error(f"more than {MAX_QUESTIONS} questions", pos)
        statement = named.get("statement", positional[0] if positional else None)
        if statement is None:
            parser.error("the question has no text", pos)
        kind = str(named.get("kind") or "SC").upper()
        if kind not in ("SC", "MC"):
            parser.error('kind must be "SC" or "MC"', pos)
        answers = named.get("answers")
        if isinstance(answers, Call):
            answers = [answers]
        if not isinstance(answers, list) or len(answers) < 2:
            parser.error("a question needs at least two answers", pos)
        options = []
        for item in answers:
            if isinstance(item, Call) and item.name == "answer":
                args = item.args
                correct = args[0] if args else item.named.get("correct")
                body = args[1] if len(args) > 1 else item.named.get("body")
                why = item.named.get("why")
            elif isinstance(item, dict):
                correct, body, why = item.get("correct"), item.get("body"), item.get("why")
            else:
                parser.error("answers must be answer(true/false, [text], why: [...])", pos)
            if not isinstance(correct, bool):
                parser.error("answer(...) needs true or false first", pos)
            options.append(
                {
                    "text": markup_to_text(_text_of(body, "an answer", parser, pos))[:500],
                    "is_correct": correct,
                    "justification": markup_to_text(_text_of(why, "why", parser, pos))
                    if why is not None
                    else "",
                }
            )
        if kind == "SC" and sum(o["is_correct"] for o in options) > 1:
            parser.error("a single-choice question has more than one correct answer", pos)
        tags = named.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        limit = named.get("time-limit-s")
        image = named.get("image")
        questions.append(
            ParsedQuestion(
                text_html=markup_to_html(_text_of(statement, "the question", parser, pos)),
                kind="multiple_choice" if kind == "MC" else "single_choice",
                options=options,
                image=image if isinstance(image, str) and image else None,
                tags=[str(t) for t in tags if isinstance(t, str | int | float)],
                time_limit=int(limit) if isinstance(limit, int | float) and 0 < limit <= 3600 else None,
                shuffle=named.get("shuffle") is True,
            )
        )
    if not questions:
        raise TypstImportError("No #question(...) found in the file.")
    return ParsedQuiz(
        title=title,
        set_type=SET_TYPES[set_type],
        description_html=markup_to_html(description) if description else "",
        figures=figures,
        questions=questions,
        lang=lang,
    )


def find_figure(files, figures, name):
    """The uploaded file for `image: name` (figures/name, name, or any
    uploaded file with that file name)."""
    wanted = [posixpath.normpath(posixpath.join(figures or "", name)), posixpath.normpath(name)]
    for path in wanted:
        for key in files:
            if posixpath.normpath(key).endswith(path) and (
                posixpath.normpath(key) == path or posixpath.normpath(key).endswith("/" + path)
            ):
                return key
    base = posixpath.basename(name)
    for key in files:
        if posixpath.basename(key) == base:
            return key
    return None


# -- creating the set --------------------------------------------------------

MAX_UPLOAD_BYTES = 40 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_ZIP_ENTRIES = 500


def collect_files(uploads):
    """{path: bytes} from uploaded .typ / image files and .zip archives."""
    import io
    import zipfile

    files, total = {}, 0
    for upload in uploads:
        data = upload.read()
        total += len(data)
        name = posixpath.basename(upload.name or "file")
        if name.lower().endswith(".zip"):
            try:
                archive = zipfile.ZipFile(io.BytesIO(data))
            except zipfile.BadZipFile as exc:
                raise TypstImportError(f"{name} is not a valid zip file.") from exc
            entries = [
                info
                for info in archive.infolist()
                if not info.is_dir() and not info.filename.startswith("__MACOSX/")
            ]
            if len(entries) > MAX_ZIP_ENTRIES:
                raise TypstImportError(f"{name} has too many files.")
            for info in entries:
                total += info.file_size
                if total > MAX_UPLOAD_BYTES:
                    raise TypstImportError("The upload is too large (40 MB at most).")
                files[posixpath.normpath(info.filename)] = archive.read(info)
        else:
            files[name] = data
        if total > MAX_UPLOAD_BYTES:
            raise TypstImportError("The upload is too large (40 MB at most).")
    return files


def quiz_sources(files):
    """The quiz files: .typ files with #question( calls (not the package)."""
    candidates = []
    for path, data in sorted(files.items()):
        if not path.lower().endswith(".typ"):
            continue
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise TypstImportError(f"{path} is not UTF-8 text.") from exc
        if _find_calls(text, r"#question\s*(?=\()") and posixpath.basename(path) != "quizbar.typ":
            candidates.append((path, text))
    if not candidates:
        raise TypstImportError("No .typ file with #question(...) in the upload.")
    return candidates


def _language_of(path, quiz):
    if quiz.lang:
        return quiz.lang
    match = re.search(r"\.(en|de|fr)\.typ$", path.lower())
    return match.group(1) if match else ""


def language_versions(sources):
    """[(lang, path, quiz)] of the uploaded quiz, the main version first
    (English if there is one). Several files must be language versions of
    the same quiz: one per language, same questions and answers."""
    parsed = []
    for path, text in sources:
        try:
            quiz = parse(text)
        except TypstImportError as exc:
            raise TypstImportError(f"{posixpath.basename(path)}: {exc}") from exc
        parsed.append((_language_of(path, quiz), path, quiz))
    if len(parsed) == 1:
        return parsed
    langs = [lang for lang, _, _ in parsed]
    if "" in langs or len(set(langs)) != len(langs):
        names = ", ".join(posixpath.basename(path) for _, path, _ in parsed)
        raise TypstImportError(
            f"Upload one quiz at a time (found {names}). Language versions of one quiz need "
            'lang: "en" / "de" / "fr" in their show rule (or names like quiz.de.typ).'
        )
    parsed.sort(key=lambda item: LANGS.index(item[0]))
    _, main_path, main = parsed[0]
    for lang, path, quiz in parsed[1:]:
        name = posixpath.basename(path)
        if len(quiz.questions) != len(main.questions):
            raise TypstImportError(
                f"{name} has {len(quiz.questions)} questions, {posixpath.basename(main_path)} "
                f"has {len(main.questions)}."
            )
        for number, (q, m) in enumerate(zip(quiz.questions, main.questions, strict=True), start=1):
            if len(q.options) != len(m.options):
                raise TypstImportError(
                    f"Question {number} has {len(q.options)} answers in {name} but "
                    f"{len(m.options)} in {posixpath.basename(main_path)}."
                )
    return parsed


def _empty_namesake(room, title, set_type, exclude):
    from rooms.models import QuestionSet
    from rooms.transfer import CONTENT_DEFAULT_LANGUAGE

    return (
        QuestionSet.objects.filter(
            room=room, type=set_type, **{f"title_{CONTENT_DEFAULT_LANGUAGE}__iexact": title}
        )
        .exclude(pk=exclude.pk)
        .filter(questions__isnull=True, sections__isnull=True)
        .order_by("id")
        .first()
    )


def import_quiz(room, user, uploads, folder=None):
    """Create a question set in ``room`` from uploaded files, or fill an
    empty set of the same title and type (e.g. one made from a course
    template). Returns (question_set, warnings)."""
    from django.core.files.base import ContentFile
    from django.db import transaction

    from rooms.images import InvalidImageError, normalize_image
    from rooms.models import UploadedImage
    from rooms.transfer import EXPORT_FORMAT, import_set

    from . import folders, i18n, library

    files = collect_files(uploads)
    versions = language_versions(quiz_sources(files))
    _, path, quiz = versions[0]
    warnings = []
    base_dir = posixpath.dirname(path)
    figures = posixpath.normpath(posixpath.join(base_dir, quiz.figures)) if base_dir else quiz.figures

    with transaction.atomic():
        items, figure_html = [], []
        for number, question in enumerate(quiz.questions, start=1):
            html_text = question.text_html
            figure_html.append("")
            if question.image:
                key = find_figure(files, figures, question.image)
                if key is None:
                    warnings.append(f"Question {number}: figure {question.image} was not uploaded.")
                elif len(files[key]) > MAX_IMAGE_BYTES:
                    warnings.append(f"Question {number}: figure {question.image} is over 5 MB.")
                else:
                    try:
                        normalized = normalize_image(
                            ContentFile(files[key], name=posixpath.basename(key))
                        )
                    except InvalidImageError:
                        warnings.append(
                            f"Question {number}: figure {question.image} is not an image "
                            "abstimmbar can show (use PNG or JPG)."
                        )
                    else:
                        uploaded = UploadedImage.objects.create(uploader=user, file=normalized)
                        figure_html[-1] = f'<p><img src="{uploaded.file.url}" alt=""></p>'
                        html_text += figure_html[-1]
            items.append(
                {
                    "kind": question.kind,
                    "text": html_text,
                    "shuffle_options": question.shuffle,
                    "time_limit": question.time_limit,
                    "options": [
                        {
                            "text": option["text"],
                            "is_correct": option["is_correct"],
                            "justification": option["justification"],
                        }
                        for option in question.options
                    ],
                }
            )
        title = quiz.title or posixpath.splitext(posixpath.basename(path))[0]
        question_set = import_set(
            room,
            {
                "format": EXPORT_FORMAT,
                "title": title,
                "description": quiz.description_html,
                "type": quiz.set_type,
                "questions": items,
            },
        )
        target = _empty_namesake(room, title, quiz.set_type, exclude=question_set)
        if target is not None:
            question_set.questions.update(question_set=target)
            question_set.sections.update(question_set=target)
            if quiz.description_html:
                for column in [f for f in vars(question_set) if f.startswith("description_")]:
                    setattr(target, column, getattr(question_set, column))
                target.save()
            question_set.delete()
            question_set, folder = target, None
        created = list(question_set.questions.order_by("position", "id"))
        for index, (question, parsed) in enumerate(zip(created, quiz.questions, strict=True)):
            if parsed.tags:
                entry = library.entry_of(question)
                if entry is not None:
                    library.set_tags(entry, parsed.tags)
            # The other language versions become the question's translations.
            i18n.save(
                question,
                {
                    lang: {
                        "text": other.questions[index].text_html + figure_html[index],
                        "options": [
                            {"text": o["text"], "justification": o["justification"]}
                            for o in other.questions[index].options
                        ],
                    }
                    for lang, _, other in versions[1:]
                },
            )
        if folder is not None:
            folders.place(question_set, folder)
    return question_set, warnings
