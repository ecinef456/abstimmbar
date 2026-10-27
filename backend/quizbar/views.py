# SPDX-License-Identifier: Apache-2.0
from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from common.i18n_fields import translated_map
from live.models import Run
from live.state import broadcast
from rooms.models import QuestionSet, Room

from . import (
    course,
    export,
    folders,
    game,
    justifications,
    library,
    peer,
    report,
    selfcheck,
    stats,
    translate,
    typst_import,
)
from .models import LibraryEntry, LibraryTag, SetFolder, SetPlacement


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


# --- self-checks filled from other sets; room duplication ---------------------


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def self_check_sources(request, set_id):
    """GET: sync if needed, then the source ids and the possible sources
    (other presentable sets of the room). PUT {"sources": [id, …]}."""
    question_set = _owned_set(request.user, set_id)
    if question_set.type != QuestionSet.SetType.SELF_CHECK:
        if request.method == "PUT":
            return Response({"detail": "Only self-checks have sources."}, status=400)
        return Response({"self_check": False, "sources": [], "candidates": [], "folder": None})
    if request.method == "PUT":
        try:
            ids = [int(x) for x in request.data.get("sources") or []]
        except (TypeError, ValueError):
            return Response({"detail": "Invalid sources."}, status=400)
        by_id = {s.pk: s for s in question_set.room.question_sets.filter(pk__in=ids)}
        if len(by_id) != len(set(ids)):
            return Response({"detail": "Sources must be sets of this room."}, status=400)
        try:
            selfcheck.set_sources(question_set, [by_id[i] for i in ids])
        except ValueError as error:
            return Response({"detail": str(error)}, status=400)
    else:
        selfcheck.ensure_synced(question_set)
    candidates = (
        question_set.room.question_sets.exclude(pk=question_set.pk)
        .exclude(type=QuestionSet.SetType.SELF_CHECK)
        .order_by("id")
    )
    placement = {
        p.question_set_id: p.folder_id
        for p in SetPlacement.objects.filter(question_set__room=question_set.room)
    }
    return Response(
        {
            "self_check": True,
            "sources": [s.pk for s in selfcheck.sources(question_set)],
            "candidates": [
                {
                    "id": s.pk,
                    "title": translated_map(s, "title"),
                    "type": s.type,
                    "folder": placement.get(s.pk),
                }
                for s in candidates
            ],
            "folder": placement.get(question_set.pk),
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def duplicate_room(request, room_id):
    """Copy a room with its sets, folders and self-check sources (no results)."""
    room = _owned_room(request.user, room_id)
    title = str(request.data.get("title") or "").strip()[:200] or None
    copy = course.duplicate_room(room, request.user, title=title)
    return Response({"id": copy.pk}, status=201)


# -- question library --------------------------------------------------------


def _own_entries(user, ids):
    if not isinstance(ids, list):
        return []
    return list(
        LibraryEntry.objects.filter(owner=user, pk__in=[i for i in ids if isinstance(i, int)])
        .select_related("master", "owner")
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def library_list(request):
    """The teacher's whole library (entries + tags); filtered in the browser."""
    return Response(
        {"entries": library.listing(request.user), "tags": library.tag_listing(request.user)}
    )


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def library_entry(request, entry_id):
    """PATCH {tags: [names]}; DELETE takes the question out of the library."""
    entry = get_object_or_404(LibraryEntry, pk=entry_id, owner=request.user)
    if request.method == "DELETE":
        library.remove(entry)
        return Response(status=204)
    tags = request.data.get("tags")
    if not isinstance(tags, list):
        return Response({"tags": "A list of names."}, status=400)
    library.set_tags(entry, tags)
    return Response({"tags": library.tag_listing(request.user)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def library_bulk_tags(request):
    """{entries: [ids], add: [names], remove: [names]} — tag many at once."""
    entries = _own_entries(request.user, request.data.get("entries"))
    add = library.tags_named(request.user, request.data.get("add") or [])
    remove = {name.lower() for name in library.clean_tag_names(request.data.get("remove"))}
    drop = [tag for tag in LibraryTag.objects.filter(owner=request.user) if tag.name.lower() in remove]
    for entry in entries:
        if add:
            entry.tags.add(*add)
        if drop:
            entry.tags.remove(*drop)
    return Response({"updated": len(entries), "tags": library.tag_listing(request.user)})


@api_view(["PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def library_tag(request, tag_id):
    """PATCH {name} renames (merging into an existing tag of that name);
    DELETE removes the tag from every question."""
    tag = get_object_or_404(LibraryTag, pk=tag_id, owner=request.user)
    if request.method == "DELETE":
        tag.delete()
        return Response(status=204)
    names = library.clean_tag_names([request.data.get("name")])
    if not names:
        return Response({"name": "Required."}, status=400)
    other = (
        LibraryTag.objects.filter(owner=request.user, name__iexact=names[0])
        .exclude(pk=tag.pk)
        .first()
    )
    if other is not None:
        for entry in tag.entries.all():
            entry.tags.add(other)
        tag.delete()
    else:
        tag.name = names[0]
        tag.save(update_fields=["name"])
    return Response({"tags": library.tag_listing(request.user)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def library_insert(request):
    """{set: id, entries: [ids]} — copy library questions to the end of a set."""
    set_id = request.data.get("set")
    if not isinstance(set_id, int):
        return Response({"set": "Required."}, status=400)
    question_set = _owned_set(request.user, set_id)
    entries = _own_entries(request.user, request.data.get("entries"))
    order = {pk: i for i, pk in enumerate(request.data.get("entries") or [])}
    entries.sort(key=lambda entry: order.get(entry.pk, 0))
    copies, skipped = library.insert(entries, question_set)
    return Response({"inserted": [q.pk for q in copies], "skipped": skipped}, status=201)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser])
def import_typst(request, room_id):
    """Upload a quiz written with quizbar.typ (``files``: the .typ, figures,
    or a .zip of the folder; optional ``folder`` id) → a new question set."""
    room = _owned_room(request.user, room_id)
    folder = None
    if request.data.get("folder"):
        try:
            folder = _owned_folder(request.user, int(request.data["folder"]))
        except (TypeError, ValueError):
            folder = None
        if folder is not None and folder.room_id != room.pk:
            folder = None
    uploads = request.FILES.getlist("files")
    if not uploads:
        return Response({"detail": "No file uploaded."}, status=400)
    try:
        question_set, warnings = typst_import.import_quiz(room, request.user, uploads, folder)
    except typst_import.TypstImportError as exc:
        return Response({"detail": str(exc)}, status=400)
    return Response(
        {"id": question_set.pk, "questions": question_set.questions.count(), "warnings": warnings},
        status=201,
    )


# -- PDF export ----------------------------------------------------------------


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def export_pdf(request):
    """{scope: "room"|"folder"|"library", id (room / folder), entries (library:
    entry ids as shown), label?, langs: ["en", …], solutions: bool,
    blank: bool} → one PDF, or a zip of PDFs and Typst sources."""
    data = request.data
    scope = data.get("scope")
    try:
        if scope == "room":
            document = export.room_document(_owned_room(request.user, int(data.get("id"))))
        elif scope == "folder":
            document = export.folder_document(_owned_folder(request.user, int(data.get("id"))))
        elif scope == "library":
            ids = data.get("entries")
            ids = [i for i in ids if isinstance(i, int)] if isinstance(ids, list) else []
            label = str(data.get("label") or "").strip()[:80]
            document = export.library_document(request.user, ids, label)
        else:
            return Response({"detail": "Unknown scope."}, status=400)
    except (TypeError, ValueError):
        return Response({"detail": "Missing id."}, status=400)
    langs = data.get("langs") if isinstance(data.get("langs"), list) else []
    try:
        name, content_type, payload = export.build(
            document,
            langs,
            bool(data.get("solutions")),
            bool(data.get("blank")),
            versions=bool(data.get("versions")),
        )
    except export.ExportError as exc:
        return Response({"detail": str(exc)}, status=400)
    response = HttpResponse(payload, content_type=content_type)
    response["Content-Disposition"] = f'attachment; filename="{name}"'
    response["Access-Control-Expose-Headers"] = "Content-Disposition"  # dev: other port
    return response


# -- statistics ----------------------------------------------------------------


def _folder_scope(request, room):
    folder = request.query_params.get("folder") or "all"
    if folder in ("all", "none"):
        return folder
    try:
        return _owned_folder(request.user, int(folder)).pk if room.qb_folders.filter(pk=int(folder)).exists() else "all"
    except (TypeError, ValueError):
        return "all"


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def room_stats(request, room_id):
    """?folder=all|none|<id> → per folder: the sets' statistics (latest
    run) and the PRE → POST pairs."""
    room = _owned_room(request.user, room_id)
    return Response(stats.room_stats(room, _folder_scope(request, room)))


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def set_stats(request, set_id):
    """?run=latest|all|<id> → one set's statistics question by question."""
    question_set = _owned_set(request.user, set_id)
    data = stats.set_stats(question_set, request.query_params.get("run") or "latest")
    data["title"] = translated_map(question_set, "title")
    return Response(data)


def _report_lang(request, room):
    from .languages import room_language

    lang = request.query_params.get("lang") or room_language(room) or "en"
    return lang if lang in ("en", "de", "fr") else "en"


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def room_stats_csv(request, room_id):
    room = _owned_room(request.user, room_id)
    folder, lang = _folder_scope(request, room), _report_lang(request, room)
    response = HttpResponse(report.csv_bytes(room, folder, lang), content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{report.csv_name(room, folder, lang)}"'
    response["Access-Control-Expose-Headers"] = "Content-Disposition"
    return response


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def room_stats_pdf(request, room_id):
    room = _owned_room(request.user, room_id)
    try:
        name, pdf = report.pdf_bytes(room, _folder_scope(request, room), _report_lang(request, room))
    except export.ExportError as exc:
        return Response({"detail": str(exc)}, status=400)
    response = HttpResponse(pdf, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{name}"'
    response["Access-Control-Expose-Headers"] = "Content-Disposition"
    return response


# -- automatic translation -------------------------------------------------------


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def translate_question(request):
    """GET: is a translation service set up? POST {source ("" = detect),
    targets: [...], text: html, options: [{text, justification}]} →
    {lang: {text, options}} — a draft for the editor's translation panel."""
    if request.method == "GET":
        return Response({"enabled": bool(translate.provider()), "provider": translate.provider()})
    data = request.data
    source = data.get("source") or ""
    targets = data.get("targets") if isinstance(data.get("targets"), list) else []
    try:
        result = translate.question(source, targets, str(data.get("text") or ""), data.get("options"))
    except translate.TranslateError as exc:
        return Response({"detail": str(exc)}, status=502)
    return Response(result)


# -- peer instruction and confidence ------------------------------------------


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def peer_start(request, run_id):
    """Presenter (key D): keep the first vote of the active question and
    let the class vote on it again."""
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    room = run.question_set.room
    if not _owner(request.user, room):
        raise Http404
    try:
        peer.start(run)
    except peer.PeerError as exc:
        return Response({"detail": str(exc)}, status=409)
    broadcast(room)
    return Response({"status": "ok"})


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def set_confidence(request, set_id):
    """GET / PUT {enabled}: phones ask how sure students are (default off)."""
    question_set = _owned_set(request.user, set_id)
    if request.method == "PUT":
        peer.set_confidence_enabled(question_set, request.data.get("enabled"))
        broadcast(question_set.room)
    return Response({"enabled": peer.confidence_enabled(question_set)})


@api_view(["POST"])
@permission_classes([AllowAny])
def confidence(request, code):
    """Phone: {token, question, value 0–10} for the answer just given."""
    from live.models import ParticipantToken
    from live.state import active_run

    room = get_object_or_404(Room, code=(code or "").strip().lower())
    token = ParticipantToken.objects.filter(room=room, key=request.data.get("token") or "").first()
    run = active_run(room)
    if token is None or run is None:
        return Response({"detail": "No running poll."}, status=409)
    question = run.active_question
    if question is None or question.pk != request.data.get("question"):
        return Response({"detail": "This question is no longer open."}, status=409)
    try:
        peer.save_confidence(run, question, token, request.data.get("value"))
    except peer.PeerError as exc:
        return Response({"detail": str(exc)}, status=400)
    broadcast(room, debounce=True)
    return Response({"status": "ok"})


# -- game mode ---------------------------------------------------------------


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def set_game(request, set_id):
    """GET / PUT {enabled?, nicknames?, avatars?}: game mode of a live poll."""
    question_set = _owned_set(request.user, set_id)
    if request.method == "PUT":
        if question_set.type != QuestionSet.SetType.LIVE_POLL:
            return Response({"detail": "Game mode is for live polls."}, status=400)
        game.set_options(question_set, **{k: request.data.get(k) for k in game.OPTIONS})
        broadcast(question_set.room)
    return Response(game.options(question_set))


def _player(request, code):
    from live.models import ParticipantToken

    room = get_object_or_404(Room, code=(code or "").strip().lower())
    token = ParticipantToken.objects.filter(room=room, key=request.data.get("token") or "").first()
    if token is None:
        return room, None, None
    run_id = request.data.get("run")
    run = game.latest_game_run(room, run_id if isinstance(run_id, int) else None)
    return room, token, run


@api_view(["POST"])
@permission_classes([AllowAny])
def game_me(request, code):
    """Phone: {token, run?} → own nickname, score, rank (token-scoped)."""
    _, token, run = _player(request, code)
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    if run is None:
        return Response({"game": False})
    if game.auto_enter(run, token):
        broadcast(run.question_set.room)
    return Response(game.me(run, token))


@api_view(["POST"])
@permission_classes([AllowAny])
def game_enter(request, code):
    """Phone: {token, run, nickname} → play this run under a nickname."""
    room, token, run = _player(request, code)
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    if run is None or not run.is_active:
        return Response({"detail": "No game running."}, status=409)
    _, error = game.enter(run, token, request.data.get("nickname"), str(request.data.get("avatar") or ""))
    if error:
        return Response({"error": error}, status=409 if error == "taken" else 400)
    broadcast(room)
    return Response(game.me(run, token), status=201)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def game_leaderboard(request, run_id):
    """Beamer: the leaderboard of a game run (top 10; ?final=1 for the
    podium: every question counts)."""
    run = get_object_or_404(
        Run.objects.select_related("question_set__room", "active_question"), pk=run_id
    )
    if not _owner(request.user, run.question_set.room):
        raise Http404
    return Response(game.leaderboard(run, final=request.query_params.get("final") == "1"))
