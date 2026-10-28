# SPDX-License-Identifier: Apache-2.0
"""The question library: every question a teacher writes, tagged.

- A question created in one of the teacher's rooms becomes a library entry
  (``on_created``); the editor can opt out ("In library" checkbox).
- Copies (duplicating a question, set or room, inserting from the library,
  self-check copies) join the entry of their original (``join_copy``), so
  copying never adds entries.
- The library shows the entry's ``master`` copy. Deleting the master moves
  the entry to another copy; deleting the last copy keeps a copy in a hidden
  per-teacher "vault" set (``rescue``), so the library never loses questions
  when sets or rooms are deleted.

Imports of rooms.transfer / rooms.serializers are local: both modules import
this one for their hooks.
"""
import re
from functools import partial

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q, QuerySet

from common.i18n_fields import translated_map
from rooms import set_types
from rooms.models import Question, QuestionSet, Room

from .models import LibraryEntry, LibraryTag, LibraryVault, QuestionLineage

TAG_MAX = 60
# Shown only in the editor's breadcrumb of library-only questions.
VAULT_TITLE = "Question library"


# -- ownership ---------------------------------------------------------------


def owner_of(question_set):
    """The teacher whose library a set's questions belong to: the room's
    owner, else its first member (None: example rooms, the hidden vault)."""
    room = question_set.room
    if room.is_example or LibraryVault.objects.filter(room_id=room.pk).exists():
        return None
    if room.owner_id is not None:
        return room.owner
    return room.owners.order_by("id").first()


def vault_set_id(owner):
    return (
        LibraryVault.objects.filter(owner=owner).values_list("question_set_id", flat=True).first()
    )


def vault_for(owner):
    vault = LibraryVault.objects.filter(owner=owner).select_related("question_set").first()
    if vault is not None:
        return vault.question_set
    # No owner, no owners: invisible in every room list (and excluded from
    # the staff-wide list by a hook in rooms/views.py).
    room = Room.objects.create(title=VAULT_TITLE, title_de=VAULT_TITLE, title_en=VAULT_TITLE, owner=None)
    # A member (not the owner) so the teacher may edit library-only
    # questions; the room is still never listed (rooms/views.py).
    room.owners.add(owner)
    question_set = QuestionSet.objects.create(
        room=room, title=VAULT_TITLE, title_de=VAULT_TITLE, title_en=VAULT_TITLE
    )
    LibraryVault.objects.create(owner=owner, room=room, question_set=question_set)
    return question_set


def entry_of(question):
    lineage = QuestionLineage.objects.filter(question=question).select_related("entry").first()
    return lineage.entry if lineage else None


# -- hooks -------------------------------------------------------------------


def on_created(question):
    """post_save hook: a new question in a teacher's room joins the library."""
    owner = owner_of(question.question_set)
    if owner is None:
        return
    entry = LibraryEntry.objects.create(owner=owner, master=question)
    QuestionLineage.objects.create(question=question, entry=entry)


def join_copy(source, clone):
    """duplicate_question hook: the copy belongs to its original's entry
    (when both are the same teacher's), instead of a new one."""
    fresh = QuestionLineage.objects.filter(question=clone).select_related("entry").first()
    source_entry = entry_of(source)
    target_owner = owner_of(clone.question_set)
    if source_entry is None or (
        target_owner is not None and target_owner.pk != source_entry.owner_id
    ):
        return  # an original outside the library: the copy keeps its own state
    if fresh is not None:
        if fresh.entry.master_id == clone.pk:
            fresh.entry.delete()
        else:
            fresh.delete()
    QuestionLineage.objects.create(question=clone, entry=source_entry)


def _deleting_user(origin):
    user_model = get_user_model()
    if isinstance(origin, user_model):
        return True
    return isinstance(origin, QuerySet) and origin.model is user_model


def rescue(question, origin=None):
    """pre_delete hook: keep a deleted master in the vault until we know
    (after commit) whether another copy survived."""
    if _deleting_user(origin):
        return
    for entry in LibraryEntry.objects.filter(master=question).select_related("owner"):
        vault = vault_for(entry.owner)
        if question.question_set_id == vault.pk:
            continue
        from rooms.transfer import duplicate_question

        clone = duplicate_question(
            question, question_set=vault, section=None, position=vault.questions.count()
        )
        if not QuestionLineage.objects.filter(question=clone).exists():
            QuestionLineage.objects.create(question=clone, entry=entry)
        entry.master = clone
        entry.save(update_fields=["master"])
        transaction.on_commit(partial(settle, entry.pk))


def settle(entry_id):
    """After a delete: if a copy outside the vault survived, it becomes the
    master again and the vault copy goes."""
    entry = LibraryEntry.objects.filter(pk=entry_id).first()
    if entry is None:
        return
    vault_id = vault_set_id(entry.owner_id)
    members = Question.objects.filter(qb_lineage__entry=entry)
    survivor = members.exclude(question_set_id=vault_id).order_by("-updated_at", "-id").first()
    if survivor is None:
        return
    with transaction.atomic():
        entry.master = survivor
        entry.save(update_fields=["master"])
        members.filter(question_set_id=vault_id).delete()


# -- editing -----------------------------------------------------------------


def normalize_tag(raw):
    """One spelling per tag: lower case, spaces (and commas) become "-".
    "Week 3" → "week-3". The frontend's normalizeTag does the same."""
    name = re.sub(r"[\s,]+", "-", str(raw).strip().lower())
    return re.sub(r"-{2,}", "-", name).strip("-")[:TAG_MAX].strip("-")


def clean_tag_names(names):
    out = []
    for raw in names or []:
        name = normalize_tag(raw)
        if name and name not in out:
            out.append(name)
    return out


def tags_named(owner, names):
    tags = []
    for name in clean_tag_names(names):
        tag = LibraryTag.objects.filter(owner=owner, name__iexact=name).first()
        if tag is None:
            tag = LibraryTag.objects.create(owner=owner, name=name)
        tags.append(tag)
    return tags


def rename_tag(owner, tag, name):
    """Rename ``tag`` (merging into an existing tag of that name); an empty
    name deletes it. Returns the tag that remains (None if deleted)."""
    name = normalize_tag(name)
    if not name:
        tag.delete()
        return None
    other = LibraryTag.objects.filter(owner=owner, name__iexact=name).exclude(pk=tag.pk).first()
    if other is not None:
        for entry in tag.entries.all():
            entry.tags.add(other)
        tag.delete()
        return other
    if tag.name != name:
        tag.name = name
        tag.save(update_fields=["name"])
    return tag


def replace_in_tags(owner, find, replace, whole=False, apply=False):
    """Search and replace in tag names: ``whole`` — tags equal to ``find``,
    else every tag containing it (that part replaced). An empty result
    deletes the tag. Returns [{"id", "name", "new" (None = deleted),
    "questions"}]; changes them only with ``apply``."""
    find = str(find or "").strip().lower()
    if whole:
        find = normalize_tag(find)
    if not find:
        return []
    plan = []
    for tag in LibraryTag.objects.filter(owner=owner).order_by("name"):
        if whole and tag.name != find:
            continue
        if not whole and find not in tag.name:
            continue
        new = normalize_tag(str(replace or "") if whole else tag.name.replace(find, str(replace or "").lower()))
        plan.append({"id": tag.pk, "name": tag.name, "new": new or None, "questions": tag.entries.count()})
    if apply:
        with transaction.atomic():
            for row in plan:
                tag = LibraryTag.objects.filter(pk=row["id"], owner=owner).first()
                if tag is not None:
                    rename_tag(owner, tag, row["new"] or "")
    return plan


def set_tags(entry, names):
    entry.tags.set(tags_named(entry.owner, names))


def add(question):
    entry = entry_of(question)
    if entry is not None:
        return entry
    owner = owner_of(question.question_set)
    if owner is None:
        return None
    entry = LibraryEntry.objects.create(owner=owner, master=question)
    QuestionLineage.objects.create(question=question, entry=entry)
    return entry


@transaction.atomic
def remove(entry):
    """Take an entry out of the library; its copies in sets stay."""
    vault_id = vault_set_id(entry.owner_id)
    kept = list(
        Question.objects.filter(qb_lineage__entry=entry, question_set_id=vault_id).values_list(
            "pk", flat=True
        )
    )
    entry.delete()
    Question.objects.filter(pk__in=kept).delete()


def apply(question, data):
    """The editor's "library" field: {"in_library": bool, "tags": [names]}."""
    if not isinstance(data, dict):
        return
    in_library = data.get("in_library")
    entry = entry_of(question)
    if in_library is False:
        if entry is not None:
            remove(entry)
        return
    if in_library is True and entry is None:
        entry = add(question)
    if entry is not None and isinstance(data.get("tags"), list):
        set_tags(entry, data["tags"])


def info(question):
    """What the editor shows: is the question in the library, with which tags."""
    lineage = (
        QuestionLineage.objects.filter(question=question)
        .select_related("entry")
        .prefetch_related("entry__tags")
        .first()
    )
    if lineage is None:
        return {"in_library": False, "entry": None, "tags": []}
    entry = lineage.entry
    return {
        "in_library": True,
        "entry": entry.pk,
        "tags": [tag.name for tag in entry.tags.all()],
        "copies": entry.members.count(),
    }


def insert(entries, question_set):
    """Copy library entries into a set (they join their entries). Kinds the
    set's type does not allow are skipped. Returns (copies, skipped ids)."""
    from rooms.serializers import next_outline_position
    from rooms.transfer import duplicate_question

    allowed = set(set_types.allowed_kinds(question_set.type))
    copies, skipped = [], []
    with transaction.atomic():
        for entry in entries:
            master = entry.master
            if master is None or master.kind not in allowed:
                skipped.append(entry.pk)
                continue
            last = question_set.questions.order_by("-position").first()
            copy = duplicate_question(
                master,
                question_set=question_set,
                section=last.section if last else None,
                position=next_outline_position(question_set),
            )
            copies.append(copy)
            # A question kept only in the vault is back in a set: that copy
            # becomes the one the library shows (and edits).
            if master.question_set_id == vault_set_id(entry.owner_id) and (
                QuestionLineage.objects.filter(question=copy, entry=entry).exists()
            ):
                entry.master = copy
                entry.save(update_fields=["master"])
                master.delete()
    return copies, skipped


# -- listing -----------------------------------------------------------------


def listing(owner):
    """All entries of a teacher's library, newest first, with where each is used."""
    vault_id = vault_set_id(owner)
    entries = list(
        LibraryEntry.objects.filter(owner=owner, master__isnull=False)
        .select_related("master")
        .prefetch_related("tags", "master__options")
    )
    used = {}
    lineages = (
        QuestionLineage.objects.filter(entry__owner=owner)
        .exclude(question__question_set_id=vault_id)
        .values_list("entry_id", "question_id", "question__question_set_id")
    )
    set_ids = set()
    for entry_id, question_id, set_id in lineages:
        used.setdefault(entry_id, []).append((question_id, set_id))
        set_ids.add(set_id)
    sets = {
        qs.pk: qs
        for qs in QuestionSet.objects.filter(pk__in=set_ids).select_related("room")
    }
    from quizbar import i18n, justifications, stats

    members = {}
    for entry_id, question_id in QuestionLineage.objects.filter(entry__owner=owner).values_list(
        "entry_id", "question_id"
    ):
        members.setdefault(entry_id, []).append(question_id)
    answer_stats = stats.library(members)

    out = []
    for entry in entries:
        master = entry.master
        numbers = answer_stats.get(entry.pk) or {}
        positions = [option.position for option in master.options.all()]
        top_wrong = numbers.get("top_wrong")
        # The library speaks English: a question's English translation, if any.
        english = i18n.english(master)
        out.append(
            {
                "id": entry.pk,
                "kind": master.kind,
                "text": _only(english["text"]) or translated_map(master, "text"),
                "options": [
                    {
                        "text": _only(english["options"][option.pk].text)
                        if option.pk in english["options"] and english["options"][option.pk].text
                        else translated_map(option, "text"),
                        "is_correct": option.is_correct,
                        "justification": (
                            english["options"][option.pk].justification
                            if option.pk in english["options"]
                            and english["options"][option.pk].justification
                            else justifications.text_for(option)
                        ),
                    }
                    for option in master.options.all()
                ],
                "tags": [{"id": tag.pk, "name": tag.name} for tag in entry.tags.all()],
                "master": master.pk,
                # Library-only questions live in the hidden vault set; they are
                # edited there like any other question.
                "master_set": master.question_set_id,
                "used_in": [
                    {
                        "question": question_id,
                        "set": set_id,
                        "set_title": translated_map(sets[set_id], "title"),
                        "set_type": sets[set_id].type,
                        "room": sets[set_id].room_id,
                        "room_title": translated_map(sets[set_id].room, "title"),
                    }
                    for question_id, set_id in used.get(entry.pk, [])
                    if set_id in sets
                ],
                "created_at": entry.created_at,
                "updated_at": master.updated_at,
                # answers over every copy and every run (see stats.library)
                "stats": {
                    "runs": numbers.get("runs", 0),
                    "answers": numbers.get("answers", 0),
                    "correct": numbers.get("correct"),
                    "top_wrong": positions.index(top_wrong) if top_wrong in positions else None,
                    "top_wrong_share": numbers.get("top_wrong_share"),
                },
            }
        )
    return out


def _only(text):
    """A text as a {lang: text} map that shows the same in every language."""
    return dict.fromkeys(("de", "en", "fr"), text) if text else None


def tag_listing(owner):
    from django.db.models import Count

    return [
        {"id": tag.pk, "name": tag.name, "count": tag.n}
        for tag in LibraryTag.objects.filter(owner=owner).annotate(
            n=Count("entries", filter=Q(entries__master__isnull=False))
        )
    ]


# -- existing questions ------------------------------------------------------


def _fingerprint(question):
    from rooms.transfer import _lang_columns

    return (
        question.kind,
        tuple(sorted(_lang_columns(question, "text").items())),
        tuple(
            (tuple(sorted(_lang_columns(option, "text").items())), option.is_correct)
            for option in question.options.all()
        ),
    )


@transaction.atomic
def backfill(owner):
    """Put a teacher's existing questions into the library. Identical
    questions (same kind, text and answers) become one entry; questions
    already in the library are left alone. Returns (new entries, joined)."""
    known = {}
    for entry in LibraryEntry.objects.filter(owner=owner, master__isnull=False).select_related(
        "master"
    ).prefetch_related("master__options"):
        known.setdefault(_fingerprint(entry.master), entry)
    questions = (
        Question.objects.filter(
            Q(question_set__room__owner=owner)
            | Q(question_set__room__owner__isnull=True, question_set__room__owners=owner),
            qb_lineage__isnull=True,
        )
        .distinct()
        .filter(~Q(question_set__room__is_example=True))
        .exclude(question_set__room__qb_library_vault__isnull=False)
        .prefetch_related("options")
        .order_by("created_at", "id")
    )
    created = joined = 0
    for question in questions:
        key = _fingerprint(question)
        entry = known.get(key)
        if entry is None:
            entry = LibraryEntry.objects.create(owner=owner, master=question)
            known[key] = entry
            created += 1
        else:
            joined += 1
        QuestionLineage.objects.create(question=question, entry=entry)
    return created, joined
