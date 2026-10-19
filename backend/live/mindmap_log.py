# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Moderation log of a live mind map (#201).

Every presenter merge, move, rename and applied AI proposal is recorded (by
``live.mindmap``, under the run lock, in the transaction of the action) with
its undo data and a readable label (term texts only — no participant data).
The beamer lists the active entries (presenter payload) and can reset any
one of them through the same restore paths as its own undo: ``restore`` for
merge/rename, ``undo_ops`` for an AI batch, a move back for a move. Undoing a
step through those paths directly (the beamer's top undo) marks the matching
entry reset as well, matched by its undo data.
"""
from django.db import transaction

from . import mindmap
from .models import MindmapModerationEntry, MindmapNode

Entry = MindmapModerationEntry

ALREADY_RESET = "This change has already been reset."
TERM_GONE = "The term no longer exists."
MOVED_AGAIN = "The term has been moved again since."
PLACE_GONE = "The original place no longer exists."
PLACE_TAKEN = "A term with this name already exists at the original place."


def payload(run, question):
    """Active entries, newest first: ``[{id, kind, label, created_at}]``
    (presenter payload; the undo data stays on the server)."""
    return [
        {"id": pk, "kind": kind, "label": label, "created_at": created.isoformat()}
        for pk, kind, label, created in Entry.objects.filter(
            run=run, question=question, state=Entry.State.ACTIVE
        )
        .order_by("-created_at", "-pk")
        .values_list("pk", "kind", "label", "created_at")
    ]


def reset(run, question, entry_id):
    """Reset one active entry — all or nothing: 404 unknown entry, 409 already
    reset / rating stage / the map changed so that it no longer applies
    cleanly (``detail`` says why; the entry stays active). Returns the
    entry's kind."""
    with transaction.atomic():
        mindmap._lock_run(run)
        entry = Entry.objects.filter(pk=entry_id, run=run, question=question).first()
        if entry is None:
            raise mindmap.MindmapError("Unknown entry.", 404)
        if entry.state != Entry.State.ACTIVE:
            raise mindmap.MindmapError(ALREADY_RESET, 409)
        mindmap._refuse_while_rating(run, question)
        if entry.kind in (Entry.Kind.MERGE, Entry.Kind.RENAME):
            mindmap.restore(run, question, entry.undo)
        elif entry.kind == Entry.Kind.AI:
            mindmap.undo_ops(run, question, entry.undo)
        else:
            _reset_move(run, question, entry.undo)
        Entry.objects.filter(pk=entry.pk).update(state=Entry.State.RESET)
    return entry.kind


def _reset_move(run, question, undo):
    node = MindmapNode.objects.filter(pk=undo["node"], run=run, question=question).first()
    if node is None:
        raise mindmap.MindmapError(TERM_GONE, 409)
    if node.parent_id != undo["to"]:
        raise mindmap.MindmapError(MOVED_AGAIN, 409)
    try:
        mindmap.move_node(run, question, node.pk, undo["parent"])
    except mindmap.MindmapError as error:
        if error.status == 404:
            raise mindmap.MindmapError(PLACE_GONE, 409) from error
        if "conflict" in error.extra:
            raise mindmap.MindmapError(PLACE_TAKEN, 409) from error
        raise mindmap.MindmapError(error.detail, 409) from error
