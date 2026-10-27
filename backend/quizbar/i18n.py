# SPDX-License-Identifier: Apache-2.0
"""Questions in several languages (English, German, French).

A question keeps its own text (the original, e.g. English); translations
live in QuestionTranslation / OptionTranslation. Wherever a question is
*shown* (beamer, phones, self-check, results) its text comes as a
{en, de, fr} map: the translation for a language if there is one, else the
original. The clients pick the room's language (or the viewer's) from it.
The library always shows English.
"""
from django.conf import settings

from common.i18n_fields import translated_map

from .models import OptionTranslation, QuestionTranslation

LANGS = ("en", "de", "fr")


def _original(obj):
    values = translated_map(obj, "text")
    canonical = values.get(settings.MODELTRANSLATION_DEFAULT_LANGUAGE)
    return values, canonical or next((v for v in values.values() if v), "")


def _load(question):
    """Translations of a question and its options (2 queries, cached on the
    question object)."""
    cached = getattr(question, "_qb_i18n", None)
    if cached is None:
        texts = {t.lang: t for t in QuestionTranslation.objects.filter(question_id=question.pk)}
        options = {}
        for t in OptionTranslation.objects.filter(option__question_id=question.pk):
            options.setdefault(t.option_id, {})[t.lang] = t
        cached = question._qb_i18n = (texts, options)
    return cached


def _map(obj, rows, field="text"):
    values, original = _original(obj)
    if not any(getattr(row, field) for row in rows.values()):
        return values  # no translations: exactly the upstream {de, en} map
    out = dict.fromkeys(LANGS, original)
    for lang, value in values.items():  # older two-language content (de/en columns)
        if value:
            out[lang] = value
    for lang, row in rows.items():
        if getattr(row, field) and lang in out:
            out[lang] = getattr(row, field)
    return out


def question_map(question):
    """{en, de, fr} text of a question for display."""
    return _map(question, _load(question)[0])


def option_map(option, question=None):
    """{en, de, fr} text of an answer option for display."""
    question = question or option.question
    return _map(option, _load(question)[1].get(option.pk, {}))


def preload(questions):
    """Load the translations of many questions at once (2 queries in all)."""
    by_id = {q.pk: q for q in questions}
    texts, options = {pk: {} for pk in by_id}, {pk: {} for pk in by_id}
    for t in QuestionTranslation.objects.filter(question_id__in=by_id):
        texts[t.question_id][t.lang] = t
    for t in OptionTranslation.objects.filter(option__question_id__in=by_id).select_related(
        "option"
    ):
        options[t.option.question_id].setdefault(t.option_id, {})[t.lang] = t
    for pk, question in by_id.items():
        question._qb_i18n = (texts[pk], options[pk])


def text_in(lang, question, option=None):
    """The text of a question (or of one of its options) in ``lang``: the
    translation, else the original."""
    obj = option or question
    values = question_map(question) if option is None else option_map(option, question)
    return values.get(lang) or _original(obj)[1]


def justification(option_id, lang, original, question):
    """An option's justification in ``lang`` (else the original)."""
    if lang:
        row = _load(question)[1].get(option_id, {}).get(lang)
        if row and row.justification:
            return row.justification
    return original


def english(question):
    """The library's view: English text of the question and its options."""
    texts, options = _load(question)
    en_text = texts.get("en")
    text = en_text.text if en_text and en_text.text else None
    return {
        "text": text,
        "options": {
            option_id: rows["en"]
            for option_id, rows in options.items()
            if "en" in rows
        },
    }


# -- editing -----------------------------------------------------------------


def for_editor(question):
    """{lang: {"text", "options": [{"text", "justification"}, …]}} with the
    options in position order — only languages that have something."""
    texts, options = _load(question)
    ordered = list(question.options.order_by("position", "id"))
    out = {}
    for lang in LANGS:
        rows = [options.get(o.pk, {}).get(lang) for o in ordered]
        text = texts.get(lang).text if lang in texts else ""
        if text or any(rows):
            out[lang] = {
                "text": text,
                "options": [
                    {"text": r.text if r else "", "justification": r.justification if r else ""}
                    for r in rows
                ],
            }
    return out


def save(question, data):
    """Store translations from the editor / an import:
    {lang: {"text": html, "options": [{"text", "justification"}, …]}}; the
    options list follows the question's options in position order. An empty
    language removes its translation."""
    if not isinstance(data, dict):
        return
    from rooms.sanitize import clean_html

    ordered = list(question.options.order_by("position", "id"))
    for lang, value in data.items():
        if lang not in LANGS or not isinstance(value, dict):
            continue
        text = clean_html(str(value.get("text") or ""))
        if text.strip():
            QuestionTranslation.objects.update_or_create(
                question=question, lang=lang, defaults={"text": text}
            )
        else:
            QuestionTranslation.objects.filter(question=question, lang=lang).delete()
        items = value.get("options") if isinstance(value.get("options"), list) else []
        for option, item in zip(ordered, items, strict=False):
            item = item if isinstance(item, dict) else {}
            option_text = str(item.get("text") or "").strip()[:500]
            why = str(item.get("justification") or "").strip()[:5000]
            if option_text or why:
                OptionTranslation.objects.update_or_create(
                    option=option, lang=lang, defaults={"text": option_text, "justification": why}
                )
            else:
                OptionTranslation.objects.filter(option=option, lang=lang).delete()
    question._qb_i18n = None


def copy_question(source, target):
    """Translations of the question text travel with copies (options: see
    copy_option)."""
    QuestionTranslation.objects.filter(question=target).delete()
    QuestionTranslation.objects.bulk_create(
        QuestionTranslation(question=target, lang=t.lang, text=t.text)
        for t in QuestionTranslation.objects.filter(question=source)
    )
    target._qb_i18n = None


def copy_option(source, target):
    OptionTranslation.objects.bulk_create(
        OptionTranslation(option=target, lang=t.lang, text=t.text, justification=t.justification)
        for t in OptionTranslation.objects.filter(option=source)
    )


def fingerprint_rows(question_ids):
    """For the self-check sync: everything translated, as comparable tuples."""
    q = QuestionTranslation.objects.filter(question_id__in=question_ids).values_list(
        "question_id", "lang", "text"
    )
    o = OptionTranslation.objects.filter(option__question_id__in=question_ids).values_list(
        "option__question_id", "option__position", "lang", "text", "justification"
    )
    return sorted(q), sorted(o)
