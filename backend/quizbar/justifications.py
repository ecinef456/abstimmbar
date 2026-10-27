# SPDX-License-Identifier: Apache-2.0
"""Per-option justifications: storage helpers and payload fragments.

Called from small hooks in upstream code (rooms serializers/transfer,
live state/views); all logic lives here.
"""
from .models import OptionJustification, RunJustification

MAX_LENGTH = 5000


def text_for(option):
    """The option's justification text ('' if none). Always a fresh read:
    the reverse one-to-one cache on ``option`` may be stale after set_text."""
    return (
        OptionJustification.objects.filter(option_id=option.pk)
        .values_list("text", flat=True)
        .first()
        or ""
    )


def set_text(option, text):
    """Store (or clear) an option's justification."""
    text = (text or "").strip()[:MAX_LENGTH]
    if text:
        OptionJustification.objects.update_or_create(option=option, defaults={"text": text})
    else:
        OptionJustification.objects.filter(option=option).delete()


def copy(source_option, target_option):
    text = text_for(source_option)
    if text:
        set_text(target_option, text)


def for_question(question):
    """{option_id: text} of every non-empty justification of a question, in
    the room's language when there is a translation (quizbar/i18n.py)."""
    from . import i18n, languages

    texts = dict(
        OptionJustification.objects.filter(option__question=question)
        .exclude(text="")
        .values_list("option_id", "text")
    )
    lang = languages.room_language(question.question_set.room)
    if not lang:
        return texts
    ids = set(texts) | set(i18n._load(question)[1])
    out = {oid: i18n.justification(oid, lang, texts.get(oid, ""), question) for oid in ids}
    return {oid: text for oid, text in out.items() if text}


def is_shown(run, question):
    """Justifications are visible for this run's question: the presenter
    pressed J on it, and the correct answers are (still) revealed."""
    if question is None or not run.answers_revealed:
        return False
    return RunJustification.objects.filter(run=run, question=question).exists()


def set_shown(run, question):
    """Show the justifications of ``question`` (None hides them)."""
    RunJustification.objects.update_or_create(run=run, defaults={"question": question})


def attach(rows, justifications):
    """Add a ``justification`` key to result rows that have one (in place)."""
    for row in rows:
        text = justifications.get(row["id"])
        if text:
            row["justification"] = text
    return rows
