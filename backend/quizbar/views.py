# SPDX-License-Identifier: Apache-2.0
from django.http import Http404
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from live.models import Run
from live.state import broadcast

from . import justifications


def _owner(user, room):
    return user.is_authenticated and (
        user.is_staff or room.owners.filter(pk=user.pk).exists()
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def run_justification(request, run_id):
    """Presenter key J: show/hide the active question's justifications.

    Showing also reveals the correct answers (a justification says why an
    answer is right or wrong, so it makes no sense without the solution) and
    switches to the results. Body: {"show": true|false}.
    """
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    room = run.question_set.room
    if not _owner(request.user, room):
        raise Http404
    if not run.is_active or run.mode != Run.Mode.LIVE:
        return Response({"detail": "No live run."}, status=409)
    question = run.active_question
    if question is None:
        return Response({"detail": "No active question."}, status=400)

    show = bool(request.data.get("show", True))
    if show:
        fields = []
        if run.phase != Run.Phase.RESULTS:
            run.phase = Run.Phase.RESULTS
            fields.append("phase")
        if not run.answers_revealed:
            run.answers_revealed = True
            fields.append("answers_revealed")
        if run.presenter_away:
            run.presenter_away = False
            fields.append("presenter_away")
        if fields:
            run.save(update_fields=[*fields, "updated_at"])
    justifications.set_shown(run, question if show else None)
    broadcast(room)
    return Response({"status": "ok", "shown": show})
