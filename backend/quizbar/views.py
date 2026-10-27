# SPDX-License-Identifier: Apache-2.0
from django.http import Http404
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from live.models import Run
from live.state import broadcast
from rooms.models import QuestionSet, Room

from . import folders, justifications
from .models import SetFolder


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


# --- folders of question sets (Phase 2) ---------------------------------------


def _owned_room(user, room_id):
    room = get_object_or_404(Room, pk=room_id)
    if not _owner(user, room):
        raise Http404
    return room


def _owned_folder(user, folder_id):
    folder = get_object_or_404(SetFolder.objects.select_related("room"), pk=folder_id)
    if not _owner(user, folder.room):
        raise Http404
    return folder


def _owned_set(user, set_id):
    question_set = get_object_or_404(QuestionSet.objects.select_related("room"), pk=set_id)
    if not _owner(user, question_set.room):
        raise Http404
    return question_set


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def room_folders(request, room_id):
    """GET: the room's folders with their sets in order. POST {title, ordered}."""
    room = _owned_room(request.user, room_id)
    if request.method == "POST":
        folder = folders.create_folder(
            room, request.data.get("title"), request.data.get("ordered", True)
        )
        return Response(folders.folder_payload(folder), status=201)
    return Response({"folders": folders.room_folders(room)})


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def folder_detail(request, folder_id):
    """PATCH {title?, ordered?}; DELETE keeps the sets (they leave the folder)."""
    folder = _owned_folder(request.user, folder_id)
    if request.method == "DELETE":
        folder.delete()
        return Response(status=204)
    if "title" in request.data:
        title = str(request.data.get("title") or "").strip()[: folders.MAX_TITLE]
        if not title:
            return Response({"title": "A folder needs a name."}, status=400)
        folder.title = title
    if "ordered" in request.data:
        folder.ordered = bool(request.data.get("ordered"))
    folder.save()
    return Response(folders.folder_payload(folder))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def folder_order(request, folder_id):
    """{"sets": [id, …]} — the folder's new sequence."""
    folder = _owned_folder(request.user, folder_id)
    try:
        set_ids = [int(x) for x in request.data.get("sets") or []]
        folders.reorder(folder, set_ids)
    except (TypeError, ValueError) as error:
        return Response({"detail": str(error)}, status=400)
    return Response(folders.folder_payload(folder))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def set_folder(request, set_id):
    """{"folder": id|null} — move a set into a folder (at its end) or out."""
    question_set = _owned_set(request.user, set_id)
    folder_id = request.data.get("folder")
    folder = None
    if folder_id not in (None, ""):
        folder = _owned_folder(request.user, folder_id)
        if folder.room_id != question_set.room_id:
            return Response({"detail": "The folder is in another room."}, status=400)
    folders.place(question_set, folder)
    return Response({"folder": folder.pk if folder else None})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def set_next(request, set_id):
    """The set's folder, its number there and the next presentable set."""
    return Response(folders.next_info(_owned_set(request.user, set_id)))
