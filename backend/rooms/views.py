# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Authoring API: rooms, question sets, questions, image upload.

Everything here requires a logged-in user (OIDC); visibility is limited to
rooms the user owns (staff sees all). The anonymous participant side lives in
the `live` app (M2) — never here.
"""
import operator
from functools import reduce
from typing import ClassVar

import nh3
from basicbar_integrations import ai
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Case, Count, Exists, IntegerField, Max, OuterRef, Q, Sum, When
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils.html import strip_tags
from rest_framework import parsers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from common import documents
from common.i18n_fields import resolve_translated_text, translated_map
from live.models import MatrixCard, MindmapContribution, MindmapNode, Vote

from . import ai_generate, ai_prompts, generation, set_types
from .images import InvalidImageError, normalize_image
from .models import GenerationJob, Question, QuestionSet, Room, Section
from .serializers import (
    QuestionSerializer,
    QuestionSetSerializer,
    RoomSerializer,
    SectionSerializer,
    UploadedImageSerializer,
    next_outline_position,
)
from .transfer import duplicate_question, duplicate_set, export_set, import_set

MAX_IMAGE_BYTES = 5 * 1024 * 1024


def _display_name(user):
    return user.get_full_name() or user.username


def _owner_list(room, viewer):
    return [
        {
            "id": owner.pk,
            "username": owner.username,
            "name": _display_name(owner),
            "is_self": owner.pk == viewer.pk,
            "is_owner": owner.pk == room.owner_id,
        }
        for owner in room.owners.order_by("first_name", "username")
    ]


def _plain(html):
    """Strip all markup (plain-text preview of question texts)."""
    return " ".join(nh3.clean(html or "", tags=set()).split())


def _i18n_icontains(field, query):
    """OR-combine an ``icontains`` lookup across every content-language
    column of a translatable field.

    A bare lookup like ``Q(title__icontains=q)`` gets rewritten by
    django-modeltranslation to the *active UI language* column
    (``title_en``/``title_de``) — so search would silently only cover
    content authored in whatever language the searching user's interface
    happens to be in. Search must cover all authored content regardless of
    the active language, so build the Q explicitly across
    ``MODELTRANSLATION_LANGUAGES`` instead. ``field`` may include ``__``
    relation traversal (e.g. ``"questions__text"``).
    """
    return reduce(
        operator.or_,
        (
            Q(**{f"{field}_{lang}__icontains": query})
            for lang in settings.MODELTRANSLATION_LANGUAGES
        ),
    )


def _touch(question_set):
    """Bump the set's updated_at when its questions change (table column)."""
    question_set.save(update_fields=["updated_at"])


def _clamp_int(value, *, default, lo, hi):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _clamp_float(value, default, lo, hi):
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return default


def _job_payload(job):
    return {
        "id": job.id, "status": job.status,
        "done_chunks": job.done_chunks, "total_chunks": job.total_chunks,
        "drafts": job.drafts, "truncated": job.truncated,
        "source_chars": job.source_chars, "notice": job.notice,
        "unsuitable_reason": job.unsuitable_reason, "error": job.error,
        "pages": job.pages, "density": job.density,
        "target_count": job.target_count, "reviewed": job.reviewed,
    }


def _ai_distractors_response(request, fallback_question=None):
    """Suggest plausible-but-wrong answer options (not saved). AI only.

    Reads the draft from the request body first (the question may be
    unsaved, e.g. still being created in the editor); falls back to a
    stored ``fallback_question`` when the caller has one.
    """
    if not ai.is_enabled():
        return Response({"detail": "AI is not configured."}, status=503)
    text = _plain(request.data.get("text") or "")
    if not text and fallback_question is not None:
        text = _plain(fallback_question.text)
    body_options = request.data.get("options")
    if isinstance(body_options, list):
        existing = [str(o.get("text", "")).strip() for o in body_options]
        existing = [t for t in existing if t]
        correct = [
            str(o.get("text", "")).strip()
            for o in body_options
            if o.get("is_correct") and str(o.get("text", "")).strip()
        ]
    elif fallback_question is not None:
        options = list(fallback_question.options.all())
        existing = [o.text for o in options if o.text]
        correct = [o.text for o in options if o.is_correct and o.text]
    else:
        existing, correct = [], []
    count = _clamp_int(request.data.get("count"), default=3, lo=1, hi=8)
    try:
        data = ai.chat_json(
            ai_prompts.distractors_system(),
            ai_prompts.build_distractors_prompt(text, correct, existing, count),
        )
    except ai.AIError as exc:
        return Response({"detail": f"AI error: {exc}"}, status=502)
    # Re-validate: strings only, trimmed, deduped against existing + each
    # other (case-insensitive), capped in length and count.
    seen = {e.casefold() for e in existing}
    result = []
    for item in data.get("distractors", []) if isinstance(data, dict) else []:
        text = str(item).strip()[:500]
        if text and text.casefold() not in seen:
            seen.add(text.casefold())
            result.append(text)
    return Response({"distractors": result[:count]})


def _ai_rephrase_response(request, fallback_question=None):
    """Suggest clearer rephrasings of the question text (not saved).

    Reads the draft text from the request body first; falls back to a
    stored ``fallback_question`` when the caller has one.
    """
    if not ai.is_enabled():
        return Response({"detail": "AI is not configured."}, status=503)
    plain = _plain(request.data.get("text") or "")
    if not plain and fallback_question is not None:
        plain = _plain(fallback_question.text)
    if not plain:
        return Response({"detail": "The question has no text yet."}, status=400)
    try:
        data = ai.chat_json(
            ai_prompts.rephrase_system(), ai_prompts.build_rephrase_prompt(plain)
        )
    except ai.AIError as exc:
        return Response({"detail": f"AI error: {exc}"}, status=502)
    variants = []
    for item in data.get("variants", []) if isinstance(data, dict) else []:
        text = str(item).strip()[:1000]
        if text:
            variants.append(text)
    return Response({"variants": variants[:5]})


class RoomViewSet(viewsets.ModelViewSet):
    serializer_class = RoomSerializer
    permission_classes: ClassVar = [IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        favorite = Room.favorited_by.through.objects.filter(
            room=OuterRef("pk"), user=user.pk
        )
        archived = Room.archived_by.through.objects.filter(
            room=OuterRef("pk"), user=user.pk
        )
        member = Room.owners.through.objects.filter(
            room=OuterRef("pk"), user=user.pk
        )
        # Local import avoids an app-import cycle (lti imports rooms.models).
        from lti.models import LtiContextLink

        lti = LtiContextLink.objects.filter(room=OuterRef("pk"))
        # Per-type set counts for the room-card breakdown (#75): one filtered
        # Count per set type, so the overview shows e.g. "2 live polls · 1
        # quiz · 3 self-checks" without an N+1. Derived from the choices so a
        # new set type is picked up automatically. Read as `set_count_<value>`.
        type_counts = {
            f"set_count_{value}": Count(
                "question_sets",
                filter=Q(question_sets__type=value),
                distinct=True,
            )
            for value, _ in QuestionSet.SetType.choices
        }
        queryset = Room.objects.annotate(
            question_set_count=Count("question_sets", distinct=True),
            owner_count=Count("owners", distinct=True),
            **type_counts,
            # Last actual use = most recent run across the room's sets.
            last_used_at=Max("question_sets__runs__created_at"),
            is_favorite=Exists(favorite),
            is_archived=Exists(archived),
            is_member=Exists(member),
            is_lti=Exists(lti),
        )
        # Non-staff are always restricted to their own/shared rooms (this is
        # the object-permission boundary for detail/edit/delete too). Staff
        # keep full object access to every room; only their LIST is personal
        # by default, with ?all=1 opting into the system-wide list.
        show_all = self.request.query_params.get("all") in ("1", "true", "True")
        if not user.is_staff or self.action == "list" and not show_all:
            queryset = queryset.filter(Q(owners=user) | Q(owner=user)).distinct()
        # The overview hides archived rooms; the archive page requests them
        # explicitly (?archived=1). Detail/actions keep every room reachable.
        if self.action == "list":
            wants_archived = self.request.query_params.get("archived") in (
                "1", "true", "True",
            )
            queryset = queryset.filter(is_archived=wants_archived)
        return queryset

    def perform_create(self, serializer):
        room = serializer.save(
            created_by=self.request.user,
            updated_by=self.request.user,
            owner=self.request.user,
        )
        room.owners.add(self.request.user)

    def perform_destroy(self, instance):
        # Deleting wipes the room for everyone, so only the Besitzer (or staff)
        # may do it — co-owners "leave" instead (#26).
        user = self.request.user
        if not (
            user.is_staff
            or instance.owner_id is None
            or instance.owner_id == user.pk
        ):
            raise PermissionDenied(
                "Only the owner can delete the room. You can leave the sharing "
                "instead."
            )
        instance.delete()

    def perform_update(self, serializer):
        serializer.save(updated_by=self.request.user)

    @action(detail=True, methods=["post", "delete"])
    def favorite(self, request, pk=None):
        """Mark/unmark this room as a favourite for the current user."""
        room = self.get_object()
        if request.method == "DELETE":
            room.favorited_by.remove(request.user)
        else:
            room.favorited_by.add(request.user)
        # Re-read with annotations so is_favorite is fresh.
        room = self.get_queryset().get(pk=room.pk)
        return Response(RoomSerializer(room, context={"request": request}).data)

    @action(detail=True, methods=["post", "delete"])
    def archive(self, request, pk=None):
        """Archive/unarchive this room for the current user (#16)."""
        room = self.get_object()
        if request.method == "DELETE":
            room.archived_by.remove(request.user)
        else:
            room.archived_by.add(request.user)
        room = self.get_queryset().get(pk=room.pk)
        return Response(RoomSerializer(room, context={"request": request}).data)

    @action(detail=True, methods=["get", "post"], url_path="owners")
    def owners(self, request, pk=None):
        """Shared editing (v2): every owner has full rights on the room.

        POST body: ``{"user": "<username or e-mail>"}`` — exact match only,
        so the endpoint cannot be used to enumerate accounts.
        """
        room = self.get_object()
        if request.method == "POST":
            query = str(request.data.get("user") or "").strip()
            if not query:
                return Response(
                    {"detail": "Enter a username or e-mail address."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            user_model = get_user_model()
            user = user_model.objects.filter(username__iexact=query).first()
            if user is None:
                matches = list(user_model.objects.filter(email__iexact=query)[:2])
                if len(matches) > 1:
                    return Response(
                        {"detail": "The e-mail address is not unique — please "
                                   "use the username."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                user = matches[0] if matches else None
            if user is None:
                return Response(
                    {"detail": "No person found with this username/e-mail (they "
                               "must have signed in at least once)."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            room.owners.add(user)  # idempotent
        return Response({"owners": _owner_list(room, request.user)})

    @action(detail=False, methods=["get"], url_path="collaborators")
    def collaborators(self, request):
        """People the requester already shares a room with (#55), most-frequent
        first — so they can be re-added as co-owners without retyping an e-mail.

        Only users already visible to the requester via a shared room's owners
        are returned (no account enumeration), and never their e-mail.
        """
        my_rooms = request.user.rooms.all()
        users = (
            get_user_model()
            .objects.filter(rooms__in=my_rooms)
            .exclude(pk=request.user.pk)
            .annotate(shared=Count("rooms", filter=Q(rooms__in=my_rooms), distinct=True))
            .order_by("-shared", "first_name", "username")
        )
        return Response(
            {
                "collaborators": [
                    {"id": user.pk, "username": user.username, "name": _display_name(user)}
                    for user in users
                ]
            }
        )

    @action(detail=True, methods=["delete"], url_path=r"owners/(?P<user_id>\d+)")
    def remove_owner(self, request, pk=None, user_id=None):
        """Remove a co-owner (also: leave a shared room yourself). The last
        owner cannot be removed — the room would become unreachable. The
        Besitzer must hand the room over before stepping down (#26)."""
        room = self.get_object()
        if room.owners.count() <= 1:
            return Response(
                {"detail": "The last owner cannot be removed."},
                status=status.HTTP_409_CONFLICT,
            )
        if str(room.owner_id) == str(user_id):
            return Response(
                {"detail": "Please transfer ownership to another person "
                           "first."},
                status=status.HTTP_409_CONFLICT,
            )
        room.owners.remove(user_id)
        return Response({"owners": _owner_list(room, request.user)})

    @action(detail=True, methods=["post"], url_path="leave")
    def leave(self, request, pk=None):
        """Leave a room shared with me (drop myself as co-owner, #26). The
        Besitzer cannot leave without transferring ownership first."""
        room = self.get_object()
        user = request.user
        if room.owner_id == user.pk:
            return Response(
                {"detail": "As the owner you cannot leave — transfer the room "
                           "first or delete it."},
                status=status.HTTP_409_CONFLICT,
            )
        room.owners.remove(user)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="transfer-owner")
    def transfer_owner(self, request, pk=None):
        """Hand the room over to another owner (#26). Only the current
        Besitzer (or staff) may do this; the target must already be a co-owner
        so ownership never lands on someone without access."""
        room = self.get_object()
        user = request.user
        if not (user.is_staff or room.owner_id in (None, user.pk)):
            raise PermissionDenied(
                "Only the owner can transfer the room."
            )
        try:
            target_id = int(request.data.get("user"))
        except (TypeError, ValueError):
            return Response(
                {"detail": "Specify the target person."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not room.owners.filter(pk=target_id).exists():
            return Response(
                {"detail": "The target person must already be a co-editor of the room."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        room.owner_id = target_id
        room.save(update_fields=["owner"])
        return Response({"owners": _owner_list(room, request.user)})

    @action(detail=True, methods=["post"], url_path="import-set")
    def import_set(self, request, pk=None):
        """Create a question set from an export file's JSON (roadmap M3)."""
        room = self.get_object()
        question_set = import_set(room, request.data)
        serializer = QuestionSetSerializer(
            question_set, context={"request": request}
        )
        data = dict(serializer.data)
        data["question_count"] = question_set.questions.count()
        return Response(data, status=status.HTTP_201_CREATED)


class QuestionSetViewSet(viewsets.ModelViewSet):
    serializer_class = QuestionSetSerializer
    permission_classes: ClassVar = [IsAuthenticated]

    def get_queryset(self):
        queryset = QuestionSet.objects.annotate(
            question_count=Count("questions", distinct=True),
            # has_results: any run with votes or mind-map contributions — as
            # EXISTS subqueries, not JOIN counts that multiply per run/vote.
            has_answers=Exists(Vote.objects.filter(run__question_set=OuterRef("pk")))
            | Exists(
                MindmapContribution.objects.filter(
                    node__run__question_set=OuterRef("pk")
                )
            )
            | Exists(
                MatrixCard.objects.filter(
                    run__question_set=OuterRef("pk"), teacher=False
                )
            ),
        )
        user = self.request.user
        if not user.is_staff:
            queryset = queryset.filter(room__owners=user)
        room_id = self.request.query_params.get("room")
        if room_id:
            queryset = queryset.filter(room_id=room_id)
        # Full-text-ish search across set, question and answer texts (§5.1).
        search = self.request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(
                _i18n_icontains("title", search)
                | _i18n_icontains("description", search)
                | _i18n_icontains("questions__text", search)
                | _i18n_icontains("questions__options__text", search)
            ).distinct()
        return queryset

    @action(detail=True, methods=["post"])
    def duplicate(self, request, pk=None):
        """Copy this set (questions, no results) — optionally into another
        of the user's rooms (semester reuse, concept §5.1)."""
        question_set = self.get_object()
        target = question_set.room
        if request.data.get("room"):
            target = Room.objects.filter(pk=request.data["room"]).first()
            user = request.user
            if target is None or not (
                user.is_staff or target.owners.filter(pk=user.pk).exists()
            ):
                return Response(
                    {"detail": "Target room not found."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        title = (request.data.get("title") or "").strip() or None
        if title is None and target == question_set.room:
            # Build the auto-title from the CANONICAL-language column, never
            # the bare accessor (which follows the active UI language and
            # would otherwise leak into the canonical title_<default> column
            # duplicate_set() writes to — see Task 6 follow-up review).
            canonical_key = f"title_{settings.MODELTRANSLATION_DEFAULT_LANGUAGE}"
            canonical = getattr(question_set, canonical_key, "") or question_set.title
            title = f"{canonical} (Kopie)"[:200]
        clone = duplicate_set(question_set, target, title=title)
        serializer = self.get_serializer(clone)
        data = dict(serializer.data)
        data["question_count"] = clone.questions.count()
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def share(self, request, pk=None):
        """Enable/disable the copy link (v2 "Teilen"): ``{"enabled": bool}``.

        Sharing hands out a non-guessable token; any logged-in person with
        the link may *copy* the set (never edit it). Disabling invalidates
        the link immediately.
        """
        question_set = self.get_object()
        if request.data.get("enabled"):
            question_set.enable_sharing()
        else:
            question_set.disable_sharing()
        return Response({"share_token": question_set.share_token})

    @action(detail=True, methods=["post"], url_path="self-check/publish")
    def self_check_publish(self, request, pk=None):
        """Publish a Lernkontrolle (#75 Phase 3): mint (or keep) the
        permanent participant link. Idempotent — calling it again returns
        the same token. Only meaningful for type == self_check."""
        question_set = self.get_object()
        if question_set.type != QuestionSet.SetType.SELF_CHECK:
            return Response(
                {"detail": "Only a Lernkontrolle can be published."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        question_set.enable_self_check()
        return Response({"self_check_token": question_set.self_check_token})

    @action(detail=True, methods=["post"], url_path="self-check/unpublish")
    def self_check_unpublish(self, request, pk=None):
        """Unpublish a Lernkontrolle: invalidate the participant link."""
        question_set = self.get_object()
        question_set.disable_self_check()
        return Response({"self_check_token": None})

    @action(detail=True, methods=["get", "delete"], url_path="self-check/stats")
    def self_check_stats(self, request, pk=None):
        """Aggregate anonymous attempt counters (#75 Phase 3): GET returns
        them, DELETE clears all attempts first and then returns the
        (now zero) aggregate."""
        question_set = self.get_object()
        qs = question_set.self_check_attempts
        if request.method == "DELETE":
            qs.all().delete()
        agg = qs.aggregate(attempts=Count("id"), correct=Sum("correct"), scored=Sum("scored"))
        correct, scored = agg["correct"] or 0, agg["scored"] or 0
        return Response(
            {
                "attempts": agg["attempts"] or 0,
                "correct": correct,
                "scored": scored,
                "ratio": (correct / scored) if scored else None,
            }
        )

    @action(detail=True, methods=["get"])
    def export(self, request, pk=None):
        """Download this set as a JSON file (roadmap M3)."""
        question_set = self.get_object()
        response = JsonResponse(
            export_set(question_set), json_dumps_params={"ensure_ascii": False, "indent": 2}
        )
        response["Content-Disposition"] = (
            f'attachment; filename="abstimmbar-set-{question_set.pk}.json"'
        )
        return response

    @action(
        detail=True,
        methods=["post"],
        url_path="ai-generate",
        parser_classes=[parsers.MultiPartParser, parsers.FormParser, parsers.JSONParser],
    )
    def ai_generate(self, request, pk=None):
        """Kick off an async question-generation job over an uploaded document
        (PDF/PPTX/ODP) or pasted text, chunked and processed in the
        background (#Wortwolke-style worker); the drafts stay unsaved for
        the teacher to review and pick (human in the loop)."""
        self.get_object()  # ownership check
        if not ai.is_enabled():
            return Response({"detail": "AI is not configured."}, status=503)
        # This feature's own ceiling (independent of common.documents.MAX_CHARS):
        # enough material for AI_GEN_MAX_CHUNKS full chunks plus a bit of slack.
        max_chars = settings.AI_CHUNK_CHARS * (settings.AI_GEN_MAX_CHUNKS + 1)
        density = _clamp_float(request.data.get("density"), settings.AI_GEN_DEFAULT_DENSITY, 0.1, 5.0)
        upload = request.FILES.get("file")
        if upload is not None:
            try:
                text, pages = documents.extract_document(upload, upload.name, max_chars=max_chars)
            except documents.DocumentTextError as exc:
                return Response({"detail": str(exc)}, status=400)
        else:
            text = str(request.data.get("text") or "").strip()[:max_chars]
            pages = max(1, round(len(text) / 2000))
        if not text:
            return Response(
                {"detail": "No text — please upload a file or paste text."},
                status=400,
            )
        raw_kinds = request.data.get("kinds") or ""
        kinds = [k.strip() for k in str(raw_kinds).split(",") if k.strip()]
        kinds = [k for k in kinds if k in ai_generate.ALLOWED_KINDS] or list(
            ai_generate.ALLOWED_KINDS
        )
        # Optional priority (#…): a subset of the chosen kinds to emphasise.
        # Constrained to the selected kinds; dropped if it would cover all of
        # them (an all-focus set carries no priority).
        raw_focus = request.data.get("focus") or ""
        focus_kinds = [k.strip() for k in str(raw_focus).split(",") if k.strip()]
        focus_kinds = [k for k in focus_kinds if k in kinds]
        if len(focus_kinds) >= len(kinds):
            focus_kinds = []
        level = request.data.get("level")
        if level not in ai_generate.LEVELS:
            level = ai_generate.DEFAULT_LEVEL
        # Optional free-text guidance from the teacher (#84), capped so it
        # can't crowd out the material in the prompt.
        guidance = str(request.data.get("guidance") or "").strip()[:1000]
        # Cancel any still-active job for *this* set (superseded by this new
        # request) — scoped to this set only, so it can't touch another
        # user's legitimately RUNNING job (restart-orphan handling lives in
        # rooms.apps.ready(), which runs once at process start).
        GenerationJob.objects.filter(
            question_set=self.get_object(), status__in=[
                GenerationJob.Status.PENDING, GenerationJob.Status.RUNNING]
        ).update(status=GenerationJob.Status.CANCELLED)
        target = max(1, min(round(density * pages), settings.AI_GEN_MAX_QUESTIONS))
        job = GenerationJob.objects.create(
            question_set=self.get_object(), created_by=request.user,
            source_text=text, source_chars=len(text), kinds=kinds, focus_kinds=focus_kinds,
            level=level, guidance=guidance,
            pages=pages, density=density, target_count=target,
        )
        generation.start_job(job)
        return Response({"job_id": job.id}, status=201)

    @action(detail=True, methods=["get"], url_path=r"ai-generate/jobs/(?P<job_id>[0-9]+)")
    def ai_generate_job(self, request, pk=None, job_id=None):
        self.get_object()
        job = get_object_or_404(GenerationJob, pk=job_id, question_set_id=pk)
        return Response(_job_payload(job))

    @action(detail=True, methods=["get"], url_path="ai-generate/active")
    def ai_generate_active(self, request, pk=None):
        self.get_object()
        job = (
            GenerationJob.objects.filter(question_set_id=pk, reviewed=False)
            .order_by("-created_at")
            .first()
        )
        return Response(_job_payload(job) if job else {})

    @action(detail=False, methods=["get"], url_path="active-generation")
    def active_generation(self, request):
        """The most relevant of the *current user's own* generation jobs
        across all their sets — running/pending first, else the newest
        unreviewed finished (done/failed) one — for a cross-set "you have a
        generation to review" banner. Reviewed jobs never surface here."""
        active = [GenerationJob.Status.PENDING, GenerationJob.Status.RUNNING]
        qs = GenerationJob.objects.filter(created_by=request.user).filter(
            Q(status__in=active)
            | Q(reviewed=False, status__in=[GenerationJob.Status.DONE, GenerationJob.Status.FAILED])
        )
        job = qs.order_by(
            Case(When(status__in=active, then=0), default=1, output_field=IntegerField()),
            "-created_at",
        ).first()
        if not job:
            return Response({})
        data = _job_payload(job)
        data["set_id"] = job.question_set_id
        data["set_title"] = resolve_translated_text(translated_map(job.question_set, "title"))
        return Response(data)

    @action(detail=True, methods=["post"], url_path=r"ai-generate/jobs/(?P<job_id>[0-9]+)/cancel")
    def ai_generate_cancel(self, request, pk=None, job_id=None):
        self.get_object()
        job = get_object_or_404(GenerationJob, pk=job_id, question_set_id=pk)
        job.status = GenerationJob.Status.CANCELLED
        job.save(update_fields=["status", "updated_at"])
        return Response({"status": "ok"})

    @action(detail=True, methods=["post"], url_path=r"ai-generate/jobs/(?P<job_id>[0-9]+)/reviewed")
    def ai_generate_reviewed(self, request, pk=None, job_id=None):
        self.get_object()
        job = get_object_or_404(GenerationJob, pk=job_id, question_set_id=pk)
        job.reviewed = True
        job.save(update_fields=["reviewed", "updated_at"])
        return Response({"status": "ok"})

    @action(detail=True, methods=["post"], url_path="ai-distractors")
    def ai_distractors(self, request, pk=None):
        """Set-scoped distractor suggestions for a question that has not
        been saved yet (still being created in the editor) — same logic as
        ``QuestionViewSet.ai_distractors``, just without a question id.
        Ownership is enforced via ``get_object()`` on the set."""
        self.get_object()  # ownership check
        return _ai_distractors_response(request, fallback_question=None)

    @action(detail=True, methods=["post"], url_path="ai-rephrase")
    def ai_rephrase(self, request, pk=None):
        """Set-scoped rephrase suggestions for a question that has not been
        saved yet — see ``ai_distractors`` above."""
        self.get_object()  # ownership check
        return _ai_rephrase_response(request, fallback_question=None)

    @action(detail=True, methods=["post"])
    def reorder(self, request, pk=None):
        """Persist a new question order: ``{"question_ids": [3, 1, 2]}``."""
        question_set = self.get_object()
        ids = request.data.get("question_ids")
        questions = {q.pk: q for q in question_set.questions.all()}
        if not isinstance(ids, list) or set(ids) != set(questions):
            return Response(
                {"detail": "question_ids must list every question of this set exactly once."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        for position, question_id in enumerate(ids):
            question = questions[question_id]
            if question.position != position:
                question.position = position
                question.save(update_fields=["position"])
        _touch(question_set)
        return Response({"status": "ok"})

    @action(detail=True, methods=["post"], url_path="reorder-outline")
    def reorder_outline(self, request, pk=None):
        """Persist the inline outline — sections and questions in one shared
        sequence. Body: ``{"items": [{"type": "section"|"question", "id": n}]}``.

        Each question's section becomes the nearest section header above it
        (or none if no header precedes it), so membership follows position.
        """
        question_set = self.get_object()
        items = request.data.get("items")
        sections = {s.pk: s for s in question_set.sections.all()}
        questions = {q.pk: q for q in question_set.questions.all()}
        if not isinstance(items, list):
            return Response({"detail": "items must be a list."}, status=400)
        seen_sections, seen_questions = set(), set()
        for item in items:
            if not isinstance(item, dict) or item.get("type") not in {"section", "question"}:
                return Response({"detail": "Invalid outline item."}, status=400)
            (seen_sections if item["type"] == "section" else seen_questions).add(item.get("id"))
        if seen_sections != set(sections) or seen_questions != set(questions):
            return Response(
                {"detail": "items must list every section and question exactly once."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        current_section = None
        for position, item in enumerate(items):
            if item["type"] == "section":
                section = sections[item["id"]]
                if section.position != position:
                    section.position = position
                    section.save(update_fields=["position"])
                current_section = section
            else:
                question = questions[item["id"]]
                new_section_id = current_section.pk if current_section else None
                if question.position != position or question.section_id != new_section_id:
                    question.position = position
                    question.section = current_section
                    question.save(update_fields=["position", "section"])
        _touch(question_set)
        return Response({"status": "ok"})

    @action(detail=True, methods=["post"], url_path="copy-questions")
    def copy_questions(self, request, pk=None):
        """Deep-copy questions (content + options, no results) from any of
        the user's sets into this set: ``{"question_ids": [id, ...]}``.

        Powers the per-question "copy to another set" menu and the
        multi-select "add questions from another set" picker (#87). Copies
        are appended at the end, in the caller's given order; the
        before/after link (#54) is intentionally not carried over — copies
        are standalone questions.
        """
        target = self.get_object()
        ids = request.data.get("question_ids")
        if not isinstance(ids, list) or not ids:
            return Response(
                {"detail": "question_ids must be a non-empty list."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Reject non-integer ids up front: a stray string would otherwise make
        # ``filter(pk__in=…)`` raise ValueError → 500. (bool is an int subclass.)
        if not all(isinstance(qid, int) and not isinstance(qid, bool) for qid in ids):
            return Response(
                {"detail": "question_ids must be a list of integers."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        sources = Question.objects.filter(pk__in=ids)
        if not request.user.is_staff:
            sources = sources.filter(question_set__room__owners=request.user)
        by_id = {q.pk: q for q in sources}
        if any(question_id not in by_id for question_id in ids):
            return Response(
                {"detail": "One or more questions were not found."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        allowed = set_types.allowed_kinds(target.type)
        for question_id in ids:
            source = by_id[question_id]
            if source.kind not in allowed:
                return Response(
                    {"detail": "Question type not allowed in this set type."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        with transaction.atomic():
            last = target.questions.order_by("-position").first()
            position = (last.position + 1) if last else 0
            activate = target.type == QuestionSet.SetType.SELF_CHECK
            ai_on = activate and ai.is_enabled()
            for question_id in ids:
                clone = duplicate_question(
                    by_id[question_id], question_set=target, section=None, position=position
                )
                if activate and clone.kind == Question.Kind.OPEN_TEXT:
                    # Self-checks always show learners their own evaluation;
                    # turn AI grading on too when a provider is configured (#75).
                    clone.participant_feedback = True
                    if ai_on:
                        clone.ai_evaluate = True
                    clone.save(update_fields=["participant_feedback", "ai_evaluate"])
                position += 1
            _touch(target)
        return Response({"copied": len(ids)}, status=status.HTTP_201_CREATED)


class QuestionViewSet(viewsets.ModelViewSet):
    serializer_class = QuestionSerializer
    permission_classes: ClassVar = [IsAuthenticated]

    def get_queryset(self):
        queryset = Question.objects.prefetch_related("options")
        user = self.request.user
        if not user.is_staff:
            queryset = queryset.filter(question_set__room__owners=user)
        set_id = self.request.query_params.get("question_set")
        if set_id:
            queryset = queryset.filter(question_set_id=set_id)
        return queryset

    def perform_create(self, serializer):
        question = serializer.save()
        _touch(question.question_set)

    def perform_update(self, serializer):
        question = serializer.save()
        _touch(question.question_set)

    def perform_destroy(self, instance):
        question_set = instance.question_set
        instance.delete()
        _touch(question_set)

    @action(detail=True, methods=["post"])
    def move(self, request, pk=None):
        """Move a question into another of the user's sets (v2):
        ``{"question_set": id}``. It is appended at the end of the target."""
        question = self.get_object()
        source = question.question_set
        target = QuestionSet.objects.filter(pk=request.data.get("question_set")).first()
        user = request.user
        if target is None or not (
            user.is_staff or target.room.owners.filter(pk=user.pk).exists()
        ):
            return Response(
                {"detail": "Target question set not found."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if target == source:
            return Response({"status": "ok", "question_set": source.pk})
        # The target's set type must allow this kind (#75; e.g. mindmap is
        # live-poll only) — same rule as copy-questions.
        if question.kind not in set_types.allowed_kinds(target.type):
            return Response(
                {"detail": "Question type not allowed in this set type."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Results live on the source set's runs — moving the question would
        # orphan its votes there. Copy instead, or delete the results first.
        if (
            question.votes.exists()
            or MindmapNode.objects.filter(
                question=question, contributions__isnull=False
            ).exists()
            or MatrixCard.objects.filter(question=question).exists()
        ):
            return Response(
                {"detail": "This question has results. Please delete the "
                           "results first or copy the set."},
                status=status.HTTP_409_CONFLICT,
            )
        last = target.questions.order_by("-position").first()
        question.question_set = target
        question.position = (last.position + 1) if last else 0
        # The old section belongs to the source set — drop it on the move.
        question.section = None
        question.save(
            update_fields=["question_set", "section", "position", "updated_at"]
        )
        if target.type == QuestionSet.SetType.SELF_CHECK and question.kind == Question.Kind.OPEN_TEXT:
            question.participant_feedback = True
            if ai.is_enabled():
                question.ai_evaluate = True
            question.save(update_fields=["participant_feedback", "ai_evaluate", "updated_at"])
        _touch(source)
        _touch(target)
        return Response({"status": "ok", "question_set": target.pk})

    @action(detail=True, methods=["post"], url_path="add-after")
    def add_after(self, request, pk=None):
        """Create a locked "after-question" mirroring this question (#54).

        A deep copy of a choice/likert question, appended at the end of the
        outline and linked back via ``before_question``. Its content is kept
        in sync when the before-question is saved; its results are separate.
        """
        question = self.get_object()
        if question.kind not in Question.CHOICE_KINDS:
            return Response(
                {"detail": "After-questions are only available for choice and "
                           "Likert questions."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if question.before_question_id is not None:
            return Response(
                {"detail": "An after-question cannot itself get an "
                           "after-question."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if Question.objects.filter(before_question=question).exists():
            return Response(
                {"detail": "This question already has an after-question."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        question_set = question.question_set
        after = duplicate_question(
            question,
            question_set=question_set,
            section=None,
            position=next_outline_position(question_set),
        )
        after.before_question = question
        after.save(update_fields=["before_question"])
        _touch(question_set)
        return Response(
            self.get_serializer(after).data, status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=["post"], url_path="ai-distractors")
    def ai_distractors(self, request, pk=None):
        """Suggest plausible-but-wrong answer options (not saved). AI only."""
        question = self.get_object()
        return _ai_distractors_response(request, fallback_question=question)

    @action(detail=True, methods=["post"], url_path="ai-rephrase")
    def ai_rephrase(self, request, pk=None):
        """Suggest clearer rephrasings of the question text (not saved)."""
        question = self.get_object()
        return _ai_rephrase_response(request, fallback_question=question)


class SectionViewSet(viewsets.ModelViewSet):
    """Named question groups within a set (v2). Owner-scoped like questions."""

    serializer_class = SectionSerializer
    permission_classes: ClassVar = [IsAuthenticated]

    def get_queryset(self):
        queryset = Section.objects.all()
        user = self.request.user
        if not user.is_staff:
            queryset = queryset.filter(question_set__room__owners=user)
        set_id = self.request.query_params.get("question_set")
        if set_id:
            queryset = queryset.filter(question_set_id=set_id)
        return queryset

    def perform_create(self, serializer):
        section = serializer.save()
        _touch(section.question_set)

    def perform_update(self, serializer):
        section = serializer.save()
        _touch(section.question_set)

    def perform_destroy(self, instance):
        question_set = instance.question_set
        instance.delete()  # SET_NULL keeps the questions, just unsectioned
        _touch(question_set)


class SharedSetView(APIView):
    """Preview of a shared set for the copy page (v2 "Teilen").

    Reachable by any logged-in person who has the link — deliberately NOT
    scoped to room owners. Exposes only what the copy decision needs; the
    owner names provide the attribution required by CC licenses.
    """

    permission_classes: ClassVar = [IsAuthenticated]

    def get(self, request, token):
        question_set = get_object_or_404(
            QuestionSet.objects.select_related("room"), share_token=token
        )
        questions = list(question_set.questions.all())
        return Response(
            {
                "title": question_set.title,
                "description": question_set.description,
                "license": question_set.license,
                "license_holder": question_set.license_holder,
                "owners": [
                    _display_name(owner)
                    for owner in question_set.room.owners.order_by("first_name")
                ],
                "question_count": len(questions),
                "questions": [
                    {"kind": q.kind, "text": _plain(q.text)} for q in questions[:20]
                ],
            }
        )


class SharedSetCopyView(APIView):
    """Copy a shared set into one of the viewer's own rooms."""

    permission_classes: ClassVar = [IsAuthenticated]

    def post(self, request, token):
        question_set = get_object_or_404(QuestionSet, share_token=token)
        room = Room.objects.filter(pk=request.data.get("room")).first()
        user = request.user
        if room is None or not (
            user.is_staff or room.owners.filter(pk=user.pk).exists()
        ):
            return Response(
                {"detail": "Target room not found."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        clone = duplicate_set(question_set, room)
        return Response(
            {"id": clone.pk, "room": room.pk, "title": clone.title},
            status=status.HTTP_201_CREATED,
        )


class SearchView(APIView):
    """Keyword search across the user's rooms, sets and questions (start page).

    Matches room titles/codes, set titles/descriptions and question/answer
    texts. Scoped to rooms the user owns (staff sees all). Each group is
    capped so the start page stays responsive; question text is stripped to
    plain text for a readable snippet.
    """

    permission_classes: ClassVar = [IsAuthenticated]
    LIMIT = 20

    def get(self, request):
        query = (request.query_params.get("q") or "").strip()
        result = {"rooms": [], "sets": [], "questions": []}
        if len(query) < 2:
            return Response(result)

        user = request.user
        rooms = Room.objects.all() if user.is_staff else Room.objects.filter(owners=user)

        matched_rooms = rooms.filter(
            _i18n_icontains("title", query) | _i18n_icontains("description", query)
            | Q(code__icontains=query)
        ).order_by(f"title_{settings.MODELTRANSLATION_DEFAULT_LANGUAGE}")[: self.LIMIT]
        result["rooms"] = [
            {"id": r.pk, "code": r.code, "title": r.title} for r in matched_rooms
        ]

        matched_sets = (
            QuestionSet.objects.filter(room__in=rooms)
            .filter(
                _i18n_icontains("title", query) | _i18n_icontains("description", query)
            )
            .select_related("room")
            .order_by(f"title_{settings.MODELTRANSLATION_DEFAULT_LANGUAGE}")[: self.LIMIT]
        )
        result["sets"] = [
            {
                "id": s.pk, "title": s.title,
                "room": s.room_id, "room_title": s.room.title,
            }
            for s in matched_sets
        ]

        matched_questions = (
            Question.objects.filter(question_set__room__in=rooms)
            .filter(
                _i18n_icontains("text", query) | _i18n_icontains("options__text", query)
            )
            .select_related("question_set", "question_set__room")
            .distinct()
            .order_by(
                f"question_set__title_{settings.MODELTRANSLATION_DEFAULT_LANGUAGE}",
                "position",
            )[: self.LIMIT]
        )
        result["questions"] = [
            {
                "id": q.pk,
                "text": strip_tags(q.text).strip()[:160] or "(ohne Fragentext)",
                "kind": q.kind,
                "question_set": q.question_set_id,
                "set_title": q.question_set.title,
                "room": q.question_set.room_id,
                "room_title": q.question_set.room.title,
            }
            for q in matched_questions
        ]
        return Response(result)


class ImageUploadView(APIView):
    """Upload target for the editor's image drag-and-drop (ADR-0007)."""

    permission_classes: ClassVar = [IsAuthenticated]
    parser_classes: ClassVar = [parsers.MultiPartParser]

    def post(self, request):
        file = request.FILES.get("file")
        if file is None:
            return Response(
                {"detail": "No file provided."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if file.size > MAX_IMAGE_BYTES:
            return Response(
                {"detail": "Image exceeds the 5 MB limit."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            normalized = normalize_image(file)
        except InvalidImageError:
            return Response(
                {"detail": "Not a valid image."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = UploadedImageSerializer(data={"file": normalized})
        serializer.is_valid(raise_exception=True)
        serializer.save(uploader=request.user)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
