# SPDX-License-Identifier: Apache-2.0
"""Folders of question sets inside a room, and the "next quiz" lookup."""
from django.db import transaction
from django.db.models import F, Max

from common.i18n_fields import translated_map
from rooms.models import QuestionSet

from . import languages
from .models import SetFolder, SetPlacement

MAX_TITLE = 200


def folder_payload(folder):
    return {
        "id": folder.pk,
        "title": folder.title,
        "ordered": folder.ordered,
        "position": folder.position,
        "sets": list(folder.placements.values_list("question_set_id", flat=True)),
    }


def room_folders(room):
    return [folder_payload(f) for f in room.qb_folders.prefetch_related("placements")]


def create_folder(room, title, ordered=True):
    last = room.qb_folders.aggregate(m=Max("position"))["m"]
    return SetFolder.objects.create(
        room=room,
        title=(title or "").strip()[:MAX_TITLE] or "Folder",
        ordered=bool(ordered),
        position=0 if last is None else last + 1,
    )


def place(question_set, folder, position=None):
    """Put a set into ``folder`` (at the end unless ``position``), or take it
    out of any folder with ``folder=None``. Folder and set share a room."""
    if folder is None:
        SetPlacement.objects.filter(question_set=question_set).delete()
        return None
    if folder.room_id != question_set.room_id:
        raise ValueError("Folder and question set belong to different rooms.")
    current = SetPlacement.objects.filter(question_set=question_set).first()
    if current and current.folder_id == folder.pk and position is None:
        return current
    if position is None:
        last = folder.placements.exclude(question_set=question_set).aggregate(
            m=Max("position")
        )["m"]
        position = 0 if last is None else last + 1
    placement, _ = SetPlacement.objects.update_or_create(
        question_set=question_set, defaults={"folder": folder, "position": position}
    )
    return placement


@transaction.atomic
def reorder(folder, set_ids):
    """Set the folder's sequence; ``set_ids`` must be exactly its sets."""
    current = set(folder.placements.values_list("question_set_id", flat=True))
    if set(set_ids) != current or len(set_ids) != len(current):
        raise ValueError("The list must contain exactly the folder's sets.")
    for index, set_id in enumerate(set_ids):
        SetPlacement.objects.filter(folder=folder, question_set_id=set_id).update(position=index)


def follow_original(original, clone):
    """A duplicate in the same room goes into the original's folder, right
    after it (e.g. copying last week's quiz)."""
    placement = SetPlacement.objects.filter(question_set=original).first()
    if placement is None or clone.room_id != original.room_id:
        return
    with transaction.atomic():
        placement.folder.placements.filter(position__gt=placement.position).update(
            position=F("position") + 1
        )
        SetPlacement.objects.update_or_create(
            question_set=clone,
            defaults={"folder": placement.folder, "position": placement.position + 1},
        )


def presentable(question_set):
    return question_set.type != QuestionSet.SetType.SELF_CHECK and question_set.questions.exists()


def next_info(question_set):
    """Folder, number and next presentable set of ``question_set``."""
    placement = (
        SetPlacement.objects.filter(question_set=question_set).select_related("folder").first()
    )
    if placement is None:
        return {"folder": None, "number": None, "next": None}
    folder = placement.folder
    ordered_ids = list(folder.placements.values_list("question_set_id", flat=True))
    info = {
        "folder": {"id": folder.pk, "title": folder.title, "ordered": folder.ordered},
        "number": ordered_ids.index(question_set.pk) + 1 if folder.ordered else None,
        "next": None,
    }
    if not folder.ordered:
        return info
    later = ordered_ids[ordered_ids.index(question_set.pk) + 1 :]
    sets = {s.pk: s for s in QuestionSet.objects.filter(pk__in=later)}
    for offset, set_id in enumerate(later, start=1):
        candidate = sets.get(set_id)
        if candidate is not None and presentable(candidate):
            info["next"] = {
                "id": candidate.pk,
                "title": languages.set_title_map(candidate),  # in the room's language
                "type": candidate.type,
                "number": info["number"] + offset,
            }
            break
    return info
