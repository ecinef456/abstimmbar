# SPDX-License-Identifier: Apache-2.0
"""Course structures: build a room with week folders, and duplicate rooms.

The default structure (TA exercise class): folders "Week 1" … "Week N",
each with Activators PRE, Quiz 1 … Quiz 10, Activators POST (live polls)
and a self-check that fills itself from the quizzes and Activators POST.
Empty quizzes cost nothing: "Next quiz" skips them, and so do self-checks.
"""
import re

from django.conf import settings
from django.db import transaction
from django.db.models import Max

from rooms.models import QuestionSet, Room
from rooms.naming import unique_title
from rooms.transfer import _lang_columns, duplicate_set

from . import folders, game, languages, selfcheck
from .models import SelfCheckSource, SetFolder, SetPlacement

CANONICAL = settings.MODELTRANSLATION_DEFAULT_LANGUAGE
LIVE, CHECK = QuestionSet.SetType.LIVE_POLL, QuestionSet.SetType.SELF_CHECK

QUIZZES = 10

# (name, type, description, reveal_answers, feeds the self-check)
WEEK_SETS = (
    ("Activators PRE", LIVE,
     "Activators done at the beginning of the class (no solution given)", "never", False),
    # the quizzes: the solution only when you show it (key L)
    *(
        (f"Quiz {n}", LIVE, "In-class quiz about XX", "after_close", True)
        for n in range(1, QUIZZES + 1)
    ),
    ("Activators POST", LIVE,
     "Activators done at the end of the class (with solutions)", "immediately", True),
    ("Self-check", CHECK,
     ("All questions of the quizzes and Activators POST of this week, "
      "with instant feedback."), None, False),
)

# Every live poll of the structure: answerable as soon as a question is
# shown, results only on the beamer (not on the phones).
LIVE_SETTINGS = {"open_on_show": True, "show_results_to_participants": False}


def _settings(set_type, reveal):
    settings_ = dict(LIVE_SETTINGS) if set_type == LIVE else {}
    if reveal:
        settings_["reveal_answers"] = reveal
    return settings_


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
                **_settings(set_type, reveal),
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


WEEK = re.compile(r"^Week (\d+)$")
QUIZ = re.compile(r"^Quiz (\d+)$")


def _structure_name(question_set, week):
    """"Quiz 3" for "Week 2 – Quiz 3" in week 2, else None."""
    title = _lang_columns(question_set, "title")[f"title_{CANONICAL}"] or question_set.title or ""
    prefix = f"Week {week} – "
    return title[len(prefix):] if title.startswith(prefix) else None


@transaction.atomic
def update_course(room):
    """Bring an existing course room up to the current structure, without
    removing or emptying anything:

    - each "Week N" folder gets the quizzes it lacks (Quiz 1 … Quiz 10),
      right after its last quiz (else after Activators PRE), and the week's
      self-check copies them too (before Activators POST);
    - sets of the structure that were never presented get the current
      settings (reveal, answerable on open, results not on phones).

    Returns {"added": n, "settings": n}."""
    added = updated = 0
    structure = {name: (set_type, reveal) for name, set_type, _d, reveal, _f in WEEK_SETS}
    for folder in room.qb_folders.order_by("position", "id"):
        match = WEEK.match(folder.title)
        if not match:
            continue
        week = int(match.group(1))
        order = list(
            folder.placements.order_by("position", "id").select_related("question_set")
        )
        sets = [p.question_set for p in order]
        named = {}
        for question_set in sets:
            name = _structure_name(question_set, week)
            if name in structure and name not in named:
                named[name] = question_set

        for name, (set_type, reveal) in structure.items():
            question_set = named.get(name)
            if question_set is None or question_set.runs.exists():
                continue
            changes = {
                field: value
                for field, value in _settings(set_type, reveal).items()
                if getattr(question_set, field) != value
            }
            if changes:
                QuestionSet.objects.filter(pk=question_set.pk).update(**changes)
                updated += 1

        new_quizzes = []
        for n in range(1, QUIZZES + 1):
            name = f"Quiz {n}"
            if name in named:
                continue
            question_set = QuestionSet.objects.create(
                room=room,
                type=LIVE,
                **_canonical(title=f"Week {week} – {name}", description="<p>In-class quiz about XX</p>"),
                **_settings(LIVE, "after_close"),
            )
            named[name] = question_set
            new_quizzes.append(question_set)
            # right after the previous quiz, else after Activators PRE, else first
            before = next(
                (named[f"Quiz {k}"] for k in range(n - 1, 0, -1) if f"Quiz {k}" in named),
                named.get("Activators PRE"),
            )
            index = sets.index(before) + 1 if before in sets else 0
            sets.insert(index, question_set)
            added += 1
        if not new_quizzes:
            continue
        last = folder.placements.aggregate(m=Max("position"))["m"] or 0
        for offset, question_set in enumerate(new_quizzes, start=1):
            folders.place(question_set, folder, position=last + offset)
        folders.reorder(folder, [s.pk for s in sets])

        check = named.get("Self-check")
        if check is not None and check.type == CHECK:
            links = list(check.qb_sources.order_by("position", "id"))
            linked = [link.source_id for link in links]
            post = named.get("Activators POST")
            cut = linked.index(post.pk) if post is not None and post.pk in linked else len(linked)
            wanted = linked[:cut] + [q.pk for q in new_quizzes] + linked[cut:]
            # keep the existing links (and the copies made from them), add the new
            for q in new_quizzes:
                SelfCheckSource.objects.create(self_check=check, source=q, position=0)
            for position, source_id in enumerate(wanted):
                SelfCheckSource.objects.filter(self_check=check, source_id=source_id).update(
                    position=position
                )
            selfcheck.ensure_synced(check, force=True)
    return {"added": added, "settings": updated}


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
        game.copy_setting(question_set, clone)
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
