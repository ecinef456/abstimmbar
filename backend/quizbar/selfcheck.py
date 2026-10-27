# SPDX-License-Identifier: Apache-2.0
"""Self-checks that fill themselves from other sets of the room.

A self-check with sources holds a copy of every source question its type
allows (single/multiple choice, ordering, free text), one section per
source set, in source order. Copies are updated in place, so their ids —
and the per-question attempt statistics — survive edits of the originals.
Questions added to the self-check by hand are kept, after the copies.

Syncing is lazy: whenever a self-check is opened (editor, student page),
``ensure_synced`` compares a fingerprint of its sources and re-copies only
if something changed.
"""
import hashlib

from django.db import transaction

from rooms import set_types
from rooms.models import AnswerOption, Question, QuestionSet, Section
from rooms.transfer import (
    QUESTION_CONTENT_FIELDS,
    QUESTION_TRANSLATED_FIELDS,
    _copy_options,
    _lang_columns,
    duplicate_question,
)

from . import i18n
from .models import (
    OptionJustification,
    SelfCheckSource,
    SelfCheckState,
    SyncedQuestion,
    SyncedSection,
)


def sources(self_check):
    return [link.source for link in self_check.qb_sources.select_related("source")]


def set_sources(self_check, source_sets):
    """Replace the self-check's source list (same room, not itself)."""
    with transaction.atomic():
        SelfCheckSource.objects.filter(self_check=self_check).delete()
        for position, source in enumerate(source_sets):
            if source.room_id != self_check.room_id or source.pk == self_check.pk:
                raise ValueError("Sources must be other sets of the same room.")
            SelfCheckSource.objects.create(self_check=self_check, source=source, position=position)
    ensure_synced(self_check, force=True)


def _eligible(question_set, kinds):
    return [q for q in question_set.questions.order_by("position", "id") if q.kind in kinds]


def fingerprint(self_check):
    kinds = set(set_types.allowed_kinds(QuestionSet.SetType.SELF_CHECK))
    digest = hashlib.sha256()
    for source in sources(self_check):
        digest.update(f"S{source.pk}|{source.updated_at.isoformat()}|".encode())
        for title in _lang_columns(source, "title").values():
            digest.update(f"{title}|".encode())
        questions = _eligible(source, kinds)
        ids = [q.pk for q in questions]
        for q in questions:
            digest.update(f"Q{q.pk}|{q.position}|{q.updated_at.isoformat()}|".encode())
        for row in AnswerOption.objects.filter(question_id__in=ids).values_list(
            "pk", "updated_at"
        ).order_by("pk"):
            digest.update(f"O{row[0]}|{row[1].isoformat()}|".encode())
        for row in OptionJustification.objects.filter(option__question_id__in=ids).values_list(
            "option_id", "text"
        ).order_by("option_id"):
            digest.update(f"J{row[0]}|{row[1]}|".encode())
        digest.update(repr(i18n.fingerprint_rows(ids)).encode())
    return digest.hexdigest()


def ensure_synced(self_check, force=False):
    """Re-copy the sources if they changed since the last sync. No-op for
    sets without sources."""
    if self_check.type != QuestionSet.SetType.SELF_CHECK:
        return False
    has_sources = self_check.qb_sources.exists()
    state, _ = SelfCheckState.objects.get_or_create(self_check=self_check)
    if not has_sources and not state.fingerprint:
        return False
    current = fingerprint(self_check) if has_sources else ""
    if not force and current == state.fingerprint:
        return False
    with transaction.atomic():
        _sync(self_check)
        state.fingerprint = current
        state.save(update_fields=["fingerprint"])
    return True


def _update_copy(source, copy, *, section, position):
    for base in QUESTION_TRANSLATED_FIELDS:
        for column, value in _lang_columns(source, base).items():
            setattr(copy, column, value)
    for field in QUESTION_CONTENT_FIELDS:
        setattr(copy, field, getattr(source, field))
    copy.kind = source.kind
    copy.section = section
    copy.position = position
    copy.save()
    copy.options.all().delete()
    _copy_options(source, copy)  # also copies the justifications and translations
    i18n.copy_question(source, copy)


def _sync(self_check):
    kinds = set(set_types.allowed_kinds(QuestionSet.SetType.SELF_CHECK))
    copies = {
        link.source_id: link.copy
        for link in SyncedQuestion.objects.filter(copy__question_set=self_check).select_related(
            "copy"
        )
        if link.source_id
    }
    sections = {
        link.source_set_id: link.section
        for link in SyncedSection.objects.filter(section__question_set=self_check).select_related(
            "section"
        )
        if link.source_set_id
    }
    kept_questions, kept_sections = set(), set()
    position = 0
    for source_set in sources(self_check):
        questions = _eligible(source_set, kinds)
        if not questions:
            continue
        section = sections.get(source_set.pk)
        if section is None:
            section = Section.objects.create(question_set=self_check, position=position)
            SyncedSection.objects.create(section=section, source_set=source_set)
        for column, value in _lang_columns(source_set, "title").items():
            setattr(section, column, value)
        section.position = position
        section.save()
        kept_sections.add(section.pk)
        position += 1
        for question in questions:
            copy = copies.get(question.pk)
            if copy is None:
                copy = duplicate_question(
                    question, question_set=self_check, section=section, position=position
                )
                SyncedQuestion.objects.create(copy=copy, source=question)
            else:
                _update_copy(question, copy, section=section, position=position)
            kept_questions.add(copy.pk)
            position += 1
    # Copies whose original is gone (or no longer a source) go away.
    Question.objects.filter(
        question_set=self_check, qb_synced_from__isnull=False
    ).exclude(pk__in=kept_questions).delete()
    Section.objects.filter(
        question_set=self_check, qb_synced_from__isnull=False
    ).exclude(pk__in=kept_sections).delete()
    # Hand-made questions and sections follow the copies.
    manual = list(
        Question.objects.filter(question_set=self_check, qb_synced_from__isnull=True).order_by(
            "position", "id"
        )
    )
    manual_sections = list(
        Section.objects.filter(question_set=self_check, qb_synced_from__isnull=True).order_by(
            "position", "id"
        )
    )
    outline = sorted(
        [(s.position, 0, s) for s in manual_sections] + [(q.position, 1, q) for q in manual],
        key=lambda item: (item[0], item[1]),
    )
    for _old, _kind, item in outline:
        item.position = position
        item.save(update_fields=["position"])
        position += 1


def strip_synced_copy(original, clone):
    """After duplicating a self-check: remove the clone's copies of synced
    content (same positions as in the original); a sync of the clone then
    rebuilds them with fresh links to its own sources."""
    question_positions = list(
        Question.objects.filter(question_set=original, qb_synced_from__isnull=False).values_list(
            "position", flat=True
        )
    )
    section_positions = list(
        Section.objects.filter(question_set=original, qb_synced_from__isnull=False).values_list(
            "position", flat=True
        )
    )
    Question.objects.filter(question_set=clone, position__in=question_positions).delete()
    Section.objects.filter(question_set=clone, position__in=section_positions).delete()
