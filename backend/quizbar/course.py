# SPDX-License-Identifier: Apache-2.0
"""Course structures: build a room with week folders, and duplicate rooms.

The default structure (TA exercise class): folders "Week 1" … "Week N",
each with four live polls and a self-check that fills itself from the
in-class quizzes and the end-of-class activators.
"""
from django.conf import settings
from django.db import transaction

from rooms.models import QuestionSet, Room
from rooms.naming import unique_title
from rooms.transfer import _lang_columns, duplicate_set

from . import folders, languages, selfcheck
from .models import SelfCheckSource, SetFolder, SetPlacement

CANONICAL = settings.MODELTRANSLATION_DEFAULT_LANGUAGE
LIVE, CHECK = QuestionSet.SetType.LIVE_POLL, QuestionSet.SetType.SELF_CHECK

# (name, type, description, reveal_answers, feeds the self-check)
WEEK_SETS = (
    ("Activators PRE", LIVE,
     "Activators done at the beginning of the class (no solution given)", "never", False),
    ("Quiz 1", LIVE, "In-class quiz about XX", None, True),
    ("Quiz 2", LIVE, "In-class quiz about XX", None, True),
    ("Activators POST", LIVE,
     "Activators done at the end of the class (with solutions)", None, True),
    ("Self-check", CHECK,
     ("All questions of Quiz 1, Quiz 2 and Activators POST of this week, "
      "with instant feedback."), None, False),
)


def _canonical(**columns):
    """Model kwargs writing text into the canonical content column."""
    return {f"{base}_{CANONICAL}": value for base, value in columns.items()}


def _unique_room_title(user, base):
    owned = Room.objects.filter(owners=user)
    key = f"title_{CANONICAL}__iexact"
    return unique_title(base, lambda t: owned.filter(**{key: t}).exists())


def _new_room(user, title, **extra):
    room = Room.objects.create(
        **_canonical(title=_unique_room_title(user, title)),
        owner=user,
        created_by=user,
        updated_by=user,
        **extra,
    )
    room.owners.add(user)
    return room


@transaction.atomic
def create_course(user, title, weeks=14, archived=False, language="en"):
    """A room with ``weeks`` numbered week folders of the default structure.
    ``language`` is the room's content language ('' = each viewer's own)."""
    room = _new_room(user, title)
    languages.set_room_language(room, language)
    for week in range(1, weeks + 1):
        folder = folders.create_folder(room, f"Week {week}", ordered=True)
        feeds, check = [], None
        for name, set_type, description, reveal, feeds_check in WEEK_SETS:
            question_set = QuestionSet.objects.create(
                room=room,
                type=set_type,
                **_canonical(title=f"Week {week} – {name}", description=f"<p>{description}</p>"),
                **({"reveal_answers": reveal} if reveal else {}),
            )
            folders.place(question_set, folder)
            if feeds_check:
                feeds.append(question_set)
            if set_type == CHECK:
                check = question_set
        if check is not None:
            selfcheck.set_sources(check, feeds)
    if archived:
        room.archived_by.add(user)
    return room


@transaction.atomic
def duplicate_room(room, user, title=None):
    """Copy a room for ``user``: settings, language, all question sets (no
    results), folders with their order, and the self-checks' sources."""
    new_title = title or f"{_lang_columns(room, 'title')[f'title_{CANONICAL}'] or room.title} (copy)"
    copy = _new_room(
        user,
        new_title,
        **{k: v for k, v in _lang_columns(room, "description").items()},
        **{k: v for k, v in _lang_columns(room, "closing_info").items()},
        show_logo_in_presentation=room.show_logo_in_presentation,
        show_qr_in_presentation=room.show_qr_in_presentation,
        show_code_in_presentation=room.show_code_in_presentation,
        presentation_corner=room.presentation_corner,
    )
    language = languages.room_language(room)
    if language:
        languages.set_room_language(copy, language)

    set_map = {}
    for question_set in room.question_sets.all().order_by("id"):
        title_now = _lang_columns(question_set, "title")[f"title_{CANONICAL}"] or question_set.title
        clone = duplicate_set(question_set, copy, title=title_now)
        if question_set.qb_sources.exists():
            selfcheck.strip_synced_copy(question_set, clone)
        set_map[question_set.pk] = clone

    for folder in SetFolder.objects.filter(room=room):
        new_folder = SetFolder.objects.create(
            room=copy, title=folder.title, ordered=folder.ordered, position=folder.position
        )
        for placement in folder.placements.all():
            SetPlacement.objects.create(
                question_set=set_map[placement.question_set_id],
                folder=new_folder,
                position=placement.position,
            )

    for link in SelfCheckSource.objects.filter(self_check__room=room).order_by("position"):
        SelfCheckSource.objects.create(
            self_check=set_map[link.self_check_id],
            source=set_map[link.source_id],
            position=link.position,
        )
    for clone in set_map.values():
        if clone.type == CHECK and clone.qb_sources.exists():
            selfcheck.ensure_synced(clone, force=True)
    return copy
