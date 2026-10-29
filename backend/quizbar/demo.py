# SPDX-License-Identifier: Apache-2.0
"""Demo present: try a quiz out (present, answer on your own phone) without
leaving anything behind. A demo run is an ordinary run marked by a
``DemoRun`` row, so presenting works exactly as usual; it is hidden from
every statistic and results list, and deleted with its votes when the
presenter leaves it, when any presentation starts in the same room, or
after ``STALE`` (a forgotten browser tab)."""
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from live.models import Run
from rooms.models import Room

from .models import DemoRun

STALE = timedelta(hours=6)


def is_demo(run):
    return run is not None and DemoRun.objects.filter(run=run).exists()


def real(runs):
    """``runs`` (a Run queryset) without demo runs."""
    return runs.filter(qb_demo__isnull=True)


def visible(runs, request):
    """Results lists: no demo runs, except the one named by ``?demo=<run id>``
    (the self-paced walkthrough of a demo right after it ended)."""
    keep = request.query_params.get("demo", "") if request is not None else ""
    if keep.isdigit():
        return runs.filter(Q(qb_demo__isnull=True) | Q(pk=int(keep)))
    return real(runs)


def purge_stale():
    """Delete demo runs nobody touched for ``STALE``."""
    old = timezone.now() - STALE
    Run.objects.filter(qb_demo__isnull=False, updated_at__lt=old).delete()


def clear(room):
    """Delete the demo runs of ``room`` (and stale ones anywhere)."""
    purge_stale()
    return Run.objects.filter(question_set__room=room, qb_demo__isnull=False).delete()[0] > 0


def start(question_set, mode):
    """Start a demo run of ``question_set`` (mode "live" or "self_paced").
    Like a fresh start: other runs of the room are finished or dropped
    exactly as when presenting normally; an unfinished real run of this set
    is kept as a finished result (or dropped when it has no answers)."""
    from live import mindmap
    from live.views import _finish_other_room_runs

    with transaction.atomic():
        room = Room.objects.select_for_update().get(pk=question_set.room_id)
        clear(room)
        _finish_other_room_runs(room, question_set)
        for stale in Run.objects.filter(question_set=question_set).exclude(phase=Run.Phase.FINISHED):
            if mindmap.run_has_answers(stale) or stale.recording_token:
                stale.phase = Run.Phase.FINISHED
                stale.ended_at = timezone.now()
                stale.save(update_fields=["phase", "ended_at", "updated_at"])
            else:
                stale.delete()
        run = Run(question_set=question_set, mode=mode, phase=Run.Phase.LOBBY)
        if mode == Run.Mode.SELF_PACED:
            run.phase = Run.Phase.OPEN
            run.first_opened_at = timezone.now()
            if question_set.quiz_time_limit:
                run.quiz_ends_at = run.first_opened_at + timedelta(seconds=question_set.quiz_time_limit)
        run.save()
        DemoRun.objects.create(run=run)
    return run


def end(run):
    """Delete a demo run (votes, points, peer rounds … go with it)."""
    if is_demo(run):
        run.delete()
        return True
    return False


def attach(run, participant, presenter):
    """Payload flag: the beamer and the phones say "demo, nothing is saved"."""
    if is_demo(run):
        participant["qb_demo"] = True
        presenter["qb_demo"] = True
