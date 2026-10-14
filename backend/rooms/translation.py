# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)
"""Translatable authoring fields (django-modeltranslation, #33 MR2).

Registering a model adds per-language columns (title_de/title_en) and makes the
bare attribute (obj.title) language-aware. Only participant-/presentation-facing
free text is translated; internal authoring aids (evaluation_hint,
wordcloud_grouping, evaluation_categories) and identifiers stay single-valued.
"""
from modeltranslation.translator import TranslationOptions, register

from .models import AnswerOption, Question, QuestionSet, Room, Section


@register(Room)
class RoomTranslationOptions(TranslationOptions):
    fields = ("title", "description", "closing_info")


@register(QuestionSet)
class QuestionSetTranslationOptions(TranslationOptions):
    fields = ("title", "description")


@register(Section)
class SectionTranslationOptions(TranslationOptions):
    fields = ("title", "description")


@register(Question)
class QuestionTranslationOptions(TranslationOptions):
    fields = ("text", "mindmap_root")


@register(AnswerOption)
class AnswerOptionTranslationOptions(TranslationOptions):
    fields = ("text",)
