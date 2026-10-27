# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Question-set duplication and JSON file export/import (roadmap M3).

The export format is deliberately small and versioned. Results (runs/votes)
are never part of a transfer. Image references inside question HTML are
instance-local media URLs — they survive duplication within one instance,
but not a move to a different instance (known v1 limitation, roadmap).
Imported HTML is untrusted and goes through the nh3 allowlist.

Format v2 (#33 MR2 Task 6): every translatable field (QuestionSet
title/description, Section.title/description, Question.text, AnswerOption.text) is a
{"de": ..., "en": ...} map, like the authoring API's TranslatedMapMixin
(common/i18n_fields.py). v1 files — a plain string per translatable field —
are still accepted on import, written to the canonical language only (the
same "legacy plain string" convention TranslatedMapMixin uses).

CRITICAL: never read/write a translatable field through the bare accessor
here. The active language during a request is the author's UI language
(mozilla-django-oidc/i18next), which may differ from the content-canonical
language (settings.MODELTRANSLATION_DEFAULT_LANGUAGE) — always go through
the explicit ``<field>_de``/``<field>_en`` columns instead.
"""
from django.conf import settings
from rest_framework import serializers

from common.i18n_fields import LANGS, translated_map
from quizbar import justifications as quizbar_justifications
from quizbar import library as quizbar_library

from . import matrix, mindmap, set_types
from .models import AnswerOption, Question, QuestionSet, Section
from .naming import unique_title
from .question_fields import clean_evaluation_categories
from .sanitize import clean_html, clean_media_url

EXPORT_FORMAT = "abstimmbar-set-v2"
LEGACY_FORMAT = "abstimmbar-set-v1"
VALID_KINDS = {k.value for k in Question.Kind}
CONTENT_DEFAULT_LANGUAGE = settings.MODELTRANSLATION_DEFAULT_LANGUAGE


def _unique_in_room(room, base):
    # Dedupe on the canonical-language column — consistent with the
    # serializers' own uniqueness check (Task 2, keyed on title_<default>),
    # not the bare (active-language) accessor.
    canonical_key = f"title_{CONTENT_DEFAULT_LANGUAGE}"
    return unique_title(
        base,
        lambda t: room.question_sets.filter(**{f"{canonical_key}__iexact": t}).exists(),
    )


def _lang_columns(obj, base):
    """{"<base>_<lang>": value, ...} — an object's own per-language columns
    for a translatable field, read directly (never the bare accessor)."""
    return {f"{base}_{lang}": getattr(obj, f"{base}_{lang}") for lang in LANGS}


def _lang_map(value):
    """A v2 {lang: text} map, or a v1 plain string (-> canonical language
    only, e.g. every other legacy-string entry point in this MR)."""
    if isinstance(value, dict):
        return {lang: str(value.get(lang) or "").strip() for lang in LANGS}
    m = {lang: "" for lang in LANGS}
    m[CONTENT_DEFAULT_LANGUAGE] = str(value or "").strip()
    return m


# Non-translatable Question fields copied verbatim by duplicate_question and
# by the after-question sync (#54). `kind` and the `text_<lang>` columns are
# handled separately; `position`, `section`, `before_question` and results are
# deliberately excluded.
QUESTION_CONTENT_FIELDS = (
    "shuffle_options",
    "binary_choice",
    "time_limit",
    "allow_multiple",
    "wordcloud_live",
    "wordcloud_ai_enabled",
    "wordcloud_grouping",
    "wordcloud_grouping_use_solution",
    "wordcloud_merge_variants",
    "wordcloud_merge_synonyms",
    "wordcloud_merge_concepts",
    "wordcloud_max_answers",
    "wordcloud_batch_submit",
    "reveal_answers",
    "ai_evaluate",
    "evaluation_hint",
    "evaluation_categories",
    "evaluation_chart",
    "model_solution",
    "participant_feedback",
    "mindmap_depth",
    "mindmap_max_per_person",
    "mindmap_descriptions",
    "mindmap_highlight_duplicates",
    "mindmap_seed",
    "mindmap_rating_mode",
    "mindmap_rating_budget",
    "mindmap_rating_multi",
    "mindmap_rating_live",
    "mindmap_ai_merge",
    "mindmap_ai_translate",
    "mindmap_ai_target_lang",
    "mindmap_ai_restructure",
    "matrix_edges",
    "matrix_descriptions",
    "matrix_max_per_person",
    "matrix_category_mode",
    "matrix_categories",
    "matrix_rating_mode",
    "matrix_rating_budget",
    "matrix_rating_multi",
    "matrix_rating_live",
)
# Translatable Question fields copied column by column (never the bare
# accessor): the question text and the mindmap root label.
QUESTION_TRANSLATED_FIELDS = (
    "text", "mindmap_root",
    "matrix_x_from", "matrix_x_to", "matrix_y_from", "matrix_y_to",
)


def _copy_options(source, target):
    """Deep-copy ``source``'s answer options onto ``target`` (bulk create).

    Reads the options with a fresh query rather than ``source.options.all()``:
    the source may carry a stale prefetch cache (e.g. right after the
    before-question's options were rewritten in the same request, #54).
    """
    sources = list(AnswerOption.objects.filter(question=source))
    copies = AnswerOption.objects.bulk_create(
        AnswerOption(
            question=target,
            **_lang_columns(option, "text"),
            image=option.image,
            is_correct=option.is_correct,
            is_abstention=option.is_abstention,
            position=option.position,
        )
        for option in sources
    )
    # quizbar (fork): justifications travel with copies.
    for option, copied in zip(sources, copies, strict=True):
        quizbar_justifications.copy(option, copied)


def duplicate_question(question, *, question_set, section, position):
    """Deep-copy a single question (content + options, no results) into a set.

    Reused by ``duplicate_set`` (whole-set copy) and by the "add after-question"
    action (#54). Language columns are copied verbatim; ``position``/``section``
    are set by the caller. The ``before_question`` link is the caller's job.
    """
    clone = Question.objects.create(
        question_set=question_set,
        kind=question.kind,
        **{
            col: value
            for base in QUESTION_TRANSLATED_FIELDS
            for col, value in _lang_columns(question, base).items()
        },
        **{field: getattr(question, field) for field in QUESTION_CONTENT_FIELDS},
        position=position,
        section=section,
    )
    _copy_options(question, clone)
    # quizbar (fork): a copy belongs to its original's library entry.
    quizbar_library.join_copy(question, clone)
    return clone


def sync_after_question(before):
    """Mirror ``before``'s content onto its linked after-question, if any (#54).

    Copies text + all content fields and replaces the after-question's options;
    keeps the after-question's own id/position/section/link and its results.
    No-op when the question has no after-question.
    """
    after = Question.objects.filter(before_question=before).first()
    if after is None:
        return
    after.kind = before.kind
    for base in QUESTION_TRANSLATED_FIELDS:
        for lang in LANGS:
            setattr(after, f"{base}_{lang}", getattr(before, f"{base}_{lang}"))
    for field in QUESTION_CONTENT_FIELDS:
        setattr(after, field, getattr(before, field))
    after.save()
    after.options.all().delete()
    _copy_options(before, after)


def duplicate_set(question_set, target_room, title=None):
    """Deep-copy a set (questions + options, no results) into a room.

    Every translatable field's language columns are copied verbatim from the
    source. ``title``, if given, overrides the canonical language only (the
    caller — the ``duplicate`` API action — builds it as a single string,
    e.g. "<title> (Kopie)"); the copied non-canonical title is left as-is.
    """
    canonical_key = f"title_{CONTENT_DEFAULT_LANGUAGE}"
    title_cols = _lang_columns(question_set, "title")
    canonical_title = title if title is not None else title_cols[canonical_key]
    title_cols[canonical_key] = _unique_in_room(target_room, canonical_title or "")
    clone = QuestionSet.objects.create(
        room=target_room,
        # Copies never collide: a taken title gets a numbered suffix.
        **title_cols,
        **_lang_columns(question_set, "description"),
        type=question_set.type,
        quiz_time_limit=question_set.quiz_time_limit,
        reveal_answers=question_set.reveal_answers,
        open_on_show=question_set.open_on_show,
        show_results_to_participants=question_set.show_results_to_participants,
        present_results_after=question_set.present_results_after,
        allow_back_navigation=question_set.allow_back_navigation,
        shuffle_questions=question_set.shuffle_questions,
        reveal_only_in_summary=question_set.reveal_only_in_summary,
        # The license statement travels with the copy; the share link does not.
        license=question_set.license,
        license_holder=question_set.license_holder,
    )
    # Copy sections first so questions can point at the new ones (v2).
    section_map = {
        section.pk: Section.objects.create(
            question_set=clone,
            position=section.position,
            **_lang_columns(section, "title"),
            **_lang_columns(section, "description"),
        )
        for section in question_set.sections.all()
    }
    for question in question_set.questions.prefetch_related("options"):
        duplicate_question(
            question,
            question_set=clone,
            section=section_map.get(question.section_id),
            position=question.position,
        )
    return clone


def export_set(question_set):
    # Sections are referenced from questions by their index in this list.
    sections = list(question_set.sections.all())
    section_index = {section.pk: i for i, section in enumerate(sections)}
    return {
        "format": EXPORT_FORMAT,
        "title": translated_map(question_set, "title"),
        "description": translated_map(question_set, "description"),
        "type": question_set.type,
        "quiz_time_limit": question_set.quiz_time_limit,
        "reveal_answers": question_set.reveal_answers,
        "open_on_show": question_set.open_on_show,
        "show_results_to_participants": question_set.show_results_to_participants,
        "present_results_after": question_set.present_results_after,
        "allow_back_navigation": question_set.allow_back_navigation,
        "shuffle_questions": question_set.shuffle_questions,
        "reveal_only_in_summary": question_set.reveal_only_in_summary,
        "license": question_set.license,
        "license_holder": question_set.license_holder,
        "sections": [
            {
                "title": translated_map(section, "title"),
                "description": translated_map(section, "description"),
            }
            for section in sections
        ],
        "questions": [
            {
                "kind": question.kind,
                "text": translated_map(question, "text"),
                "shuffle_options": question.shuffle_options,
                "binary_choice": question.binary_choice,
                "time_limit": question.time_limit,
                "allow_multiple": question.allow_multiple,
                "wordcloud_live": question.wordcloud_live,
                "wordcloud_ai_enabled": question.wordcloud_ai_enabled,
                "wordcloud_grouping": question.wordcloud_grouping,
                "wordcloud_grouping_use_solution": (
                    question.wordcloud_grouping_use_solution
                ),
                "wordcloud_merge_variants": question.wordcloud_merge_variants,
                "wordcloud_merge_synonyms": question.wordcloud_merge_synonyms,
                "wordcloud_merge_concepts": question.wordcloud_merge_concepts,
                "wordcloud_max_answers": question.wordcloud_max_answers,
                "wordcloud_batch_submit": question.wordcloud_batch_submit,
                "reveal_answers": question.reveal_answers,
                "ai_evaluate": question.ai_evaluate,
                "evaluation_hint": question.evaluation_hint,
                "evaluation_categories": question.evaluation_categories,
                "evaluation_chart": question.evaluation_chart,
                "model_solution": question.model_solution,
                "participant_feedback": question.participant_feedback,
                "mindmap_root": translated_map(question, "mindmap_root"),
                "mindmap_depth": question.mindmap_depth,
                "mindmap_max_per_person": question.mindmap_max_per_person,
                "mindmap_descriptions": question.mindmap_descriptions,
                "mindmap_highlight_duplicates": question.mindmap_highlight_duplicates,
                "mindmap_seed": question.mindmap_seed,
                "mindmap_rating_mode": question.mindmap_rating_mode,
                "mindmap_rating_budget": question.mindmap_rating_budget,
                "mindmap_rating_multi": question.mindmap_rating_multi,
                "mindmap_rating_live": question.mindmap_rating_live,
                "mindmap_ai_merge": question.mindmap_ai_merge,
                "mindmap_ai_translate": question.mindmap_ai_translate,
                "mindmap_ai_target_lang": question.mindmap_ai_target_lang,
                "mindmap_ai_restructure": question.mindmap_ai_restructure,
                **{
                    base: translated_map(question, base)
                    for base in matrix.AXIS_LABEL_FIELDS
                },
                "matrix_edges": question.matrix_edges,
                "matrix_descriptions": question.matrix_descriptions,
                "matrix_max_per_person": question.matrix_max_per_person,
                "matrix_category_mode": question.matrix_category_mode,
                "matrix_categories": question.matrix_categories,
                "matrix_rating_mode": question.matrix_rating_mode,
                "matrix_rating_budget": question.matrix_rating_budget,
                "matrix_rating_multi": question.matrix_rating_multi,
                "matrix_rating_live": question.matrix_rating_live,
                "section": section_index.get(question.section_id),
                "options": [
                    {
                        "text": translated_map(option, "text"),
                        "image": option.image,
                        "is_correct": option.is_correct,
                        "is_abstention": option.is_abstention,
                        # quizbar (fork); ignored by upstream importers.
                        "justification": quizbar_justifications.text_for(option),
                    }
                    for option in question.options.all()
                ],
            }
            for question in question_set.questions.prefetch_related("options")
        ],
    }


def import_set(room, data):
    """Create a set in ``room`` from an export file's parsed JSON.

    Accepts both v2 files (translatable fields as {de,en} maps) and legacy
    v1 files (translatable fields as plain strings — written to the
    canonical language only). Detected per field by value type, so a v1
    file's plain strings and a v2 file's maps are both handled by the same
    code path; only the overall ``format`` marker is validated strictly.
    """
    if not isinstance(data, dict) or data.get("format") not in {
        EXPORT_FORMAT, LEGACY_FORMAT,
    }:
        raise serializers.ValidationError(
            {"format": f"Expected an {EXPORT_FORMAT} export file."}
        )
    title_map = {lang: v[:200] for lang, v in _lang_map(data.get("title")).items()}
    if not title_map[CONTENT_DEFAULT_LANGUAGE]:
        raise serializers.ValidationError({"title": "Missing title."})
    reveal = data.get("reveal_answers", QuestionSet.RevealAnswers.AFTER_CLOSE)
    if reveal not in {r.value for r in QuestionSet.RevealAnswers}:
        raise serializers.ValidationError({"reveal_answers": "Invalid value."})
    set_type = data.get("type", QuestionSet.SetType.LIVE_POLL)
    if set_type not in QuestionSet.SetType.values:
        set_type = QuestionSet.SetType.LIVE_POLL

    # #75: quiz_time_limit travels with the export/import round-trip too —
    # foreign input, so validate defensively (plausible range, and only
    # meaningful for self_paced sets).
    quiz_time_limit = data.get("quiz_time_limit")
    if not (isinstance(quiz_time_limit, int) and 0 < quiz_time_limit <= 24 * 3600):
        quiz_time_limit = None
    if set_type != QuestionSet.SetType.SELF_PACED:
        quiz_time_limit = None

    questions = data.get("questions") or []
    if not isinstance(questions, list):
        raise serializers.ValidationError({"questions": "Must be a list."})
    allowed_kinds = set_types.allowed_kinds(set_type)
    for item in questions:
        if not isinstance(item, dict) or item.get("kind") not in VALID_KINDS:
            raise serializers.ValidationError({"questions": "Invalid question."})
        # Hard reject only for mindmap and matrix (shared live activities;
        # live polls only). Other kinds a set type would not offer in the editor still
        # import as before — legacy exports must keep working.
        if (
            item["kind"] in (Question.Kind.MINDMAP, Question.Kind.MATRIX)
            and item["kind"] not in allowed_kinds
        ):
            raise serializers.ValidationError(
                {"questions": "Question type not allowed in this set type."}
            )

    # Foreign file: sanitize like any client input — per language (#49).
    description_map = {
        lang: clean_html(v) for lang, v in _lang_map(data.get("description")).items()
    }
    title_map[CONTENT_DEFAULT_LANGUAGE] = _unique_in_room(
        room, title_map[CONTENT_DEFAULT_LANGUAGE]
    )
    question_set = QuestionSet.objects.create(
        room=room,
        **{f"title_{lang}": (v or None) for lang, v in title_map.items()},
        **{f"description_{lang}": (v or None) for lang, v in description_map.items()},
        type=set_type,
        quiz_time_limit=quiz_time_limit,
        reveal_answers=reveal,
        open_on_show=bool(data.get("open_on_show")),
        show_results_to_participants=bool(data.get("show_results_to_participants")),
        present_results_after=bool(data.get("present_results_after", True)),
        allow_back_navigation=bool(data.get("allow_back_navigation", True)),
        shuffle_questions=bool(data.get("shuffle_questions", False)),
        reveal_only_in_summary=bool(data.get("reveal_only_in_summary", False)),
        license=(
            data.get("license")
            if data.get("license") in {c.value for c in QuestionSet.License}
            else ""
        ),
        license_holder=str(data.get("license_holder") or "")[:200],
    )
    # Sections first, so questions can reference them by index.
    imported_sections = []
    raw_sections = data.get("sections") or []
    if isinstance(raw_sections, list):
        for position, raw in enumerate(raw_sections):
            raw_title = raw.get("title") if isinstance(raw, dict) else None
            section_title = {
                lang: v[:200] for lang, v in _lang_map(raw_title).items()
            }
            if not section_title[CONTENT_DEFAULT_LANGUAGE]:
                section_title[CONTENT_DEFAULT_LANGUAGE] = f"Abschnitt {position + 1}"
            # Foreign file: sanitize the rich description per language (#49).
            raw_description = raw.get("description") if isinstance(raw, dict) else None
            section_description = {
                lang: clean_html(v) for lang, v in _lang_map(raw_description).items()
            }
            imported_sections.append(
                Section.objects.create(
                    question_set=question_set,
                    position=position,
                    **{f"title_{lang}": (v or None) for lang, v in section_title.items()},
                    **{
                        f"description_{lang}": (v or None)
                        for lang, v in section_description.items()
                    },
                )
            )
    for position, item in enumerate(questions):
        raw_limit = item.get("time_limit")
        time_limit = (
            int(raw_limit)
            if isinstance(raw_limit, int) and 0 < raw_limit <= 3600
            else None
        )
        raw_max = item.get("wordcloud_max_answers")
        wc_max = int(raw_max) if isinstance(raw_max, int) and raw_max >= 0 else 5
        raw_section = item.get("section")
        section = (
            imported_sections[raw_section]
            if isinstance(raw_section, int) and 0 <= raw_section < len(imported_sections)
            else None
        )
        # Foreign file: sanitize like any client input — per language.
        text_map = {
            lang: clean_html(v) for lang, v in _lang_map(item.get("text")).items()
        }
        root_map = {
            lang: mindmap.normalize_text(v)[: mindmap.MINDMAP_TEXT_MAX].strip()
            for lang, v in _lang_map(item.get("mindmap_root")).items()
        }
        mm_depth = mindmap.clamp_depth(item.get("mindmap_depth"))
        axis_columns = {
            f"{base}_{lang}": matrix.clean_label(v)
            for base in matrix.AXIS_LABEL_FIELDS
            for lang, v in _lang_map(item.get(base)).items()
        }
        mx_mode = matrix.clamp_category_mode(item.get("matrix_category_mode"))
        try:
            mx_categories = matrix.clean_categories(
                item.get("matrix_categories"), mx_mode
            )
        except matrix.CategoryError:
            # Foreign file: drop an invalid list rather than reject the import.
            mx_mode, mx_categories = matrix.CATEGORY_OFF, []
        # Matrix rating settings only make sense for matrix questions.
        if item["kind"] == Question.Kind.MATRIX:
            mx_rating = {
                "matrix_rating_mode": mindmap.clamp_rating_mode(
                    item.get("matrix_rating_mode")
                ),
                "matrix_rating_budget": mindmap.clamp_rating_budget(
                    item.get("matrix_rating_budget")
                ),
                "matrix_rating_multi": bool(item.get("matrix_rating_multi", True)),
                "matrix_rating_live": bool(item.get("matrix_rating_live", False)),
            }
        else:
            mx_rating = {}
        question = Question.objects.create(
            question_set=question_set,
            kind=item["kind"],
            **{f"text_{lang}": (v or None) for lang, v in text_map.items()},
            **{f"mindmap_root_{lang}": v for lang, v in root_map.items()},
            **axis_columns,
            matrix_edges=bool(item.get("matrix_edges")),
            matrix_descriptions=bool(item.get("matrix_descriptions")),
            matrix_max_per_person=matrix.clamp_max_per_person(
                item.get("matrix_max_per_person")
            ),
            matrix_category_mode=mx_mode,
            matrix_categories=mx_categories,
            **mx_rating,
            mindmap_depth=mm_depth,
            mindmap_max_per_person=mindmap.clamp_max_per_person(
                item.get("mindmap_max_per_person")
            ),
            mindmap_descriptions=bool(item.get("mindmap_descriptions")),
            mindmap_highlight_duplicates=bool(
                item.get("mindmap_highlight_duplicates", True)
            ),
            # Foreign file: drop/truncate rather than reject (lenient).
            mindmap_seed=mindmap.clean_seed(
                item.get("mindmap_seed"), mm_depth, strict=False
            ),
            mindmap_rating_mode=mindmap.clamp_rating_mode(
                item.get("mindmap_rating_mode")
            ),
            mindmap_rating_budget=mindmap.clamp_rating_budget(
                item.get("mindmap_rating_budget")
            ),
            mindmap_rating_multi=bool(item.get("mindmap_rating_multi", True)),
            mindmap_rating_live=bool(item.get("mindmap_rating_live", False)),
            mindmap_ai_merge=bool(item.get("mindmap_ai_merge", True)),
            mindmap_ai_translate=bool(item.get("mindmap_ai_translate", True)),
            mindmap_ai_target_lang=mindmap.clamp_target_lang(
                item.get("mindmap_ai_target_lang")
            ),
            mindmap_ai_restructure=bool(item.get("mindmap_ai_restructure", True)),
            shuffle_options=bool(item.get("shuffle_options")),
            binary_choice=bool(item.get("binary_choice")),
            time_limit=time_limit,
            allow_multiple=bool(item.get("allow_multiple")),
            wordcloud_live=bool(item.get("wordcloud_live", True)),
            wordcloud_ai_enabled=bool(item.get("wordcloud_ai_enabled")),
            # Same cap as the authoring serializer / ai-settings endpoint.
            wordcloud_grouping=str(item.get("wordcloud_grouping") or "")[:1000],
            wordcloud_grouping_use_solution=bool(
                item.get("wordcloud_grouping_use_solution", True)
            ),
            # Missing (older exports) → the model defaults.
            wordcloud_merge_variants=bool(item.get("wordcloud_merge_variants", True)),
            wordcloud_merge_synonyms=bool(item.get("wordcloud_merge_synonyms", True)),
            wordcloud_merge_concepts=bool(item.get("wordcloud_merge_concepts", False)),
            wordcloud_max_answers=wc_max,
            wordcloud_batch_submit=bool(item.get("wordcloud_batch_submit")),
            ai_evaluate=bool(item.get("ai_evaluate")),
            evaluation_hint=str(item.get("evaluation_hint") or "")[:2000],
            evaluation_categories=clean_evaluation_categories(
                item.get("evaluation_categories")
            ),
            evaluation_chart=bool(item.get("evaluation_chart")),
            # Missing in older exports → empty solution, feedback off.
            model_solution=str(item.get("model_solution") or "")[:2000],
            participant_feedback=bool(item.get("participant_feedback")),
            reveal_answers=(
                item.get("reveal_answers")
                if item.get("reveal_answers") in Question.RevealAnswers.values
                else Question.RevealAnswers.INHERIT
            ),
            position=position,
            section=section,
        )
        if item["kind"] in Question.OPTIONLESS_KINDS:
            continue
        options = [option for option in (item.get("options") or []) if isinstance(option, dict)]
        created_options = AnswerOption.objects.bulk_create(
            AnswerOption(
                question=question,
                **{
                    f"text_{lang}": (v[:500] or None)
                    for lang, v in _lang_map(option.get("text")).items()
                },
                # Foreign file: same media-only rule as client input.
                image=clean_media_url(str(option.get("image") or "")),
                is_correct=bool(option.get("is_correct")),
                is_abstention=bool(option.get("is_abstention")),
                position=position_option,
            )
            for position_option, option in enumerate(options)
        )
        # quizbar (fork): per-option justification, if the file has one.
        for option, created in zip(options, created_options, strict=True):
            quizbar_justifications.set_text(created, str(option.get("justification") or ""))
    return question_set
