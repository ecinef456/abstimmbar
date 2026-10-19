# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Live endpoints: join, vote, presenter control, SSE stream, QR code.

Participant endpoints are anonymous (concept §9); presenter endpoints
require an owner of the room. The stream is the only async view (ADR-0003).
"""
import asyncio
import csv
import io
import random

import nh3
import qrcode
from asgiref.sync import sync_to_async
from basicbar_integrations import ai
from basicbar_integrations.html_sanitize import clean_html
from django.conf import settings
from django.db import IntegrityError, connections, transaction
from django.http import Http404, HttpResponse, JsonResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404, render
from django.utils import timezone, translation
from django.views.decorators.clickjacking import xframe_options_exempt
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from common.csv_safe import csv_safe
from common.i18n_fields import resolve_translated_text, translated_map
from common.markdown import render_markdown
from common.models import SiteConfig
from rooms.models import AnswerOption, Question, QuestionSet, Room

from . import (
    ai_evaluation,
    ai_matrix,
    matrix,
    matrix_rating,
    mindmap,
    ai_freetext,
    ai_freetext_summary,
    ai_mindmap,
    ai_report,
    ai_wordcloud,
    ai_wordcloud_live,
    mindmap_rating,
)
from .ai_freetext import clean_categories
from .hub import hub, sse_frame
from .models import (
    OrderingResponse,
    ParticipantToken,
    PriorityScore,
    Run,
    SelfCheckAttempt,
    Vote,
    WordCloudModeration,
)
from .results import (
    likert_summary,
    options_with_counts,
    ordering_stats,
    priority_stats,
    run_results,
    words_with_counts,
)
from .state import active_run, broadcast, build_payloads, question_payload

KEEPALIVE_SECONDS = 25
KEEPALIVE_FRAME = "event: ping\ndata: {}\n\n"


def _room_by_code(code):
    # Word codes are stored lowercase; be forgiving about how a participant
    # typed it (case, surrounding whitespace). Numeric codes are unaffected.
    return get_object_or_404(Room, code=(code or "").strip().lower())


def _require_owner(user, room):
    return user.is_authenticated and (
        user.is_staff or room.owners.filter(pk=user.pk).exists()
    )


def _lang_from_query(request):
    """If ?lang= names a supported language, activate it for this request so
    the participant page (and the QR/short link that carries ?lang) renders in
    that language. Returns the code to persist as a cookie, else None."""
    lang = request.GET.get("lang")
    if lang and lang in dict(settings.LANGUAGES):
        translation.activate(lang)
        request.LANGUAGE_CODE = lang
        return lang
    return None


# --- participant pages (served by Django: ultra-light, same-origin) --------


@ensure_csrf_cookie
def participant_home(request):
    """The stable home URL with the code input (concept §6.2)."""
    lang = _lang_from_query(request)
    response = render(request, "live/home.html")
    if lang:
        response.set_cookie(settings.LANGUAGE_COOKIE_NAME, lang, max_age=31536000, samesite="Lax")
    return response


@ensure_csrf_cookie
def participant_page(request, code):
    lang = _lang_from_query(request)
    room = Room.objects.filter(code=(code or "").strip().lower()).first()
    if room is None:
        response = render(request, "live/not_found.html", status=404)
        if lang:
            response.set_cookie(
                settings.LANGUAGE_COOKIE_NAME, lang, max_age=31536000, samesite="Lax"
            )
        return response
    # Closing info shown once the vote is finished (#24): the site-wide text
    # first, the room's own below it. closing_info now stores sanitized HTML
    # (editor-unify #49); render it directly (defensively re-cleaned) instead
    # of through the Markdown parser, which would double-process it.
    site = SiteConfig.load()
    closing_html = clean_html(site.closing_info) + clean_html(room.closing_info)
    response = render(
        request,
        "live/participant.html",
        {
            "room": room,
            "closing_html": closing_html,
            # Content-i18n (#33 MR2): fallback language for the client-side
            # `locText` resolver when the participant's UI language isn't
            # among the authored keys.
            "CONTENT_DEFAULT_LANGUAGE": settings.MODELTRANSLATION_DEFAULT_LANGUAGE,
        },
    )
    if lang:
        response.set_cookie(settings.LANGUAGE_COOKIE_NAME, lang, max_age=31536000, samesite="Lax")
    return response


@xframe_options_exempt
@ensure_csrf_cookie
def question_preview(request, question_id):
    """Owner-only interactive preview of one question (#74).

    Reuses the participant page in a standalone "preview" mode: it renders the
    question exactly as participants see it — no run, no SSE, submissions inert.
    The question payload is the same one the live loop broadcasts.

    Deliberately NOT under the ``/p/`` prefix: the basicbar_lti frame-ancestors
    middleware rewrites framing headers there (to 'self' + LMS origins), which
    would block the editor's cross-origin dev iframe. Here we set our own CSP
    allowing only 'self' + the app's own SPA (FRONTEND_BASE_URL), so it embeds
    in dev (cross-origin) and prod (same-origin) without opening it up wider.
    """
    question = get_object_or_404(
        Question.objects.select_related("question_set__room"), pk=question_id
    )
    room = question.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    preview_state = {
        "phase": "open",
        "run_id": 0,
        "room": {
            "code": "",
            "title": translated_map(room, "title"),
            "show_logo": False,
            "show_qr": False,
            "show_code": False,
            "corner": room.presentation_corner,
        },
        "set_title": translated_map(question.question_set, "title"),
        "question": question_payload(question, shuffle_seed=0),
    }
    if question.kind == Question.Kind.MINDMAP:
        preview_state["mindmap"] = mindmap.preview_tree(question)
    elif question.kind == Question.Kind.MATRIX:
        preview_state["matrix_settings"] = matrix.settings_payload(question)
    response = render(
        request,
        "live/participant.html",
        {
            "room": room,
            "preview": True,
            "preview_state": preview_state,
            "closing_html": "",
            "CONTENT_DEFAULT_LANGUAGE": settings.MODELTRANSLATION_DEFAULT_LANGUAGE,
        },
    )
    # Frame only in our own app (SPA editor), dev cross-origin included.
    response["Content-Security-Policy"] = (
        f"frame-ancestors 'self' {settings.FRONTEND_BASE_URL}"
    )
    return response


def room_qr(request, code):
    """QR code pointing at the participant short URL."""
    room = _room_by_code(code)
    url = request.build_absolute_uri(f"/p/{room.code}")
    image = qrcode.make(url, box_size=12, border=1)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return HttpResponse(buffer.getvalue(), content_type="image/png")


# --- participant API ---------------------------------------------------------


@api_view(["POST"])
def join(request, code):
    """Issue (or confirm) a participant token for this room."""
    room = _room_by_code(code)
    key = (request.data.get("token") or "").strip()
    token = None
    if key:
        token = ParticipantToken.objects.filter(room=room, key=key).first()
    if token is None:
        token = ParticipantToken.objects.create(room=room)
    return Response({"token": token.key})


def _clean_priority_points(question, raw):
    """Validate a ``priorities`` submission (#58).

    Returns ``(points_by_option_id, None)`` with an entry for EVERY option of
    the question (options missing from ``raw`` default to 0), or
    ``(None, error_message)`` on invalid input. Total must not exceed 100.
    """
    if not isinstance(raw, dict):
        return None, "Points must be an object."
    valid_ids = list(question.options.values_list("pk", flat=True))
    valid = set(valid_ids)
    cleaned = {}
    for key, value in raw.items():
        try:
            option_id = int(key)
        except (TypeError, ValueError):
            return None, "Invalid option id."
        if option_id not in valid:
            return None, "Invalid option."
        if isinstance(value, bool) or not isinstance(value, int):
            return None, "Points must be whole numbers."
        if value < 0 or value > 100:
            return None, "Points out of range."
        cleaned[option_id] = value
    if sum(cleaned.values()) > 100:
        return None, "Total exceeds 100."
    for option_id in valid_ids:
        cleaned.setdefault(option_id, 0)
    return cleaned, None


def _clean_ordering(question, raw):
    """Validate an ``ordering`` submission (#72).

    ``raw`` must be a list of option ids that is exactly a permutation of the
    question's options (all present, no duplicates, no foreign ids). Returns
    ``(order_list_of_pks, None)`` or ``(None, error_message)``.
    """
    if not isinstance(raw, list):
        return None, "Order must be a list."
    valid_ids = list(question.options.values_list("pk", flat=True))
    cleaned = []
    for entry in raw:
        if isinstance(entry, bool):
            return None, "Invalid option id."
        try:
            option_id = int(entry)
        except (TypeError, ValueError):
            return None, "Invalid option id."
        cleaned.append(option_id)
    if sorted(cleaned) != sorted(valid_ids):
        return None, "Order must contain every option exactly once."
    return cleaned, None


def _can_replace_vote(run):
    """Answer correction (#75): may a participant replace an existing vote in
    this run? Shared by ``vote`` (enforcement) and ``my_answer`` (so the
    participant page only locks the form when the server would refuse)."""
    qs = run.question_set
    return (
        run.mode == Run.Mode.SELF_PACED
        and qs.allow_back_navigation
        and qs.reveal_answers == "never"
        and not (
            run.quiz_ends_at
            and timezone.now() > run.quiz_ends_at + timezone.timedelta(seconds=1)
        )
    )


@api_view(["POST"])
def vote(request, code):
    """Record one participant's answer to the currently open question."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)

    run = active_run(room)
    if run is None or run.phase != Run.Phase.OPEN:
        return Response({"detail": "Voting is closed."}, status=status.HTTP_409_CONFLICT)

    if run.mode == Run.Mode.SELF_PACED:
        # Self-paced (concept §6.3): every question of the set is open;
        # the participant says which one they are answering. No countdown —
        # own pace is the point.
        question = Question.objects.filter(
            question_set=run.question_set, pk=request.data.get("question")
        ).first()
        if question is None:
            return Response({"detail": "Unknown question."}, status=400)
        # Overall quiz time limit (#75): reject late votes once the deadline
        # (stamped at first open) has passed, 1 s network grace like the
        # live per-question countdown below.
        if run.quiz_ends_at:
            deadline = run.quiz_ends_at + timezone.timedelta(seconds=1)
            if timezone.now() > deadline:
                return Response({"detail": "Time is up."}, status=status.HTTP_409_CONFLICT)
    else:
        question = run.active_question
        if question is None:
            return Response(
                {"detail": "Voting is closed."}, status=status.HTTP_409_CONFLICT
            )
        # Countdown enforcement (v2): the timer is not just cosmetic — late
        # votes are rejected server-side (1 s network grace).
        if question.time_limit and run.opened_at:
            deadline = run.opened_at + timezone.timedelta(seconds=question.time_limit + 1)
            if timezone.now() > deadline:
                return Response(
                    {"detail": "Time is up."}, status=status.HTTP_409_CONFLICT
                )

    if question.kind == Question.Kind.MATRIX:
        return Response(
            {"detail": "Matrix cards are added via the matrix."}, status=400
        )
    # Mind maps collect terms via the dedicated mind-map endpoints.
    if question.kind == Question.Kind.MINDMAP:
        return Response(
            {"detail": "Mind map terms are added via the mind map."}, status=400
        )

    # Double-vote guard (app-level, since the DB constraint is gone): one
    # submission per participant/question/run — except word clouds marked
    # ``allow_multiple`` in a live run, which collect several terms (#14).
    allow_multiple = (
        run.mode == Run.Mode.LIVE
        and question.kind == Question.Kind.WORD_CLOUD
        and question.allow_multiple
    )
    existing = Vote.objects.filter(run=run, question=question, token=token)
    replace = False
    if existing.exists():
        # Answer correction (#75): a self-paced participant may replace their
        # existing vote for this question — but only while the set allows
        # going back (``allow_back_navigation``), reveals no feedback yet
        # (``reveal_answers == "never"``, so nothing was shown to "correct"
        # towards) and the overall quiz deadline (if any) has not passed.
        # Nothing is deleted here: the old vote must survive any validation
        # failure below, so the actual delete happens only once the new
        # submission is known to be well-formed, atomically with its create.
        can_replace = _can_replace_vote(run)
        if not (allow_multiple or can_replace):
            return Response({"detail": "Already voted."}, status=status.HTTP_409_CONFLICT)
        replace = can_replace

    # Per-participant cap for allow_multiple word clouds (#76): reject once the
    # token has contributed the author's maximum (0 = unlimited). Enforced here
    # so a manipulated client cannot exceed it.
    if allow_multiple and question.wordcloud_max_answers and Vote.objects.filter(
        run=run, question=question, token=token
    ).count() >= question.wordcloud_max_answers:
        return Response(
            {"detail": "Maximum reached."}, status=status.HTTP_409_CONFLICT
        )

    if question.kind == Question.Kind.PRIORITIES:
        cleaned, error = _clean_priority_points(question, request.data.get("points"))
        if error:
            return Response({"detail": error}, status=400)
        options = {o.pk: o for o in question.options.all()}
        try:
            with transaction.atomic():
                if replace:
                    # Serialize concurrent replaces for this participant,
                    # then drop the old (now validated-superseded) answer.
                    ParticipantToken.objects.select_for_update().filter(pk=token.pk).first()
                    Vote.objects.filter(run=run, question=question, token=token).delete()
                vote_obj = Vote.objects.create(run=run, question=question, token=token)
                PriorityScore.objects.bulk_create(
                    [
                        PriorityScore(vote=vote_obj, option=options[oid], points=pts)
                        for oid, pts in cleaned.items()
                    ]
                )
        except IntegrityError:
            return Response(
                {"detail": "Already voted."}, status=status.HTTP_409_CONFLICT
            )
        broadcast(room, debounce=True)
        return Response({"status": "ok"}, status=status.HTTP_201_CREATED)

    if question.kind == Question.Kind.ORDERING:
        order, error = _clean_ordering(question, request.data.get("order"))
        if error:
            return Response({"detail": error}, status=400)
        options = {o.pk: o for o in question.options.all()}
        try:
            with transaction.atomic():
                if replace:
                    ParticipantToken.objects.select_for_update().filter(pk=token.pk).first()
                    Vote.objects.filter(run=run, question=question, token=token).delete()
                vote_obj = Vote.objects.create(run=run, question=question, token=token)
                OrderingResponse.objects.bulk_create(
                    [
                        OrderingResponse(vote=vote_obj, option=options[oid], position=idx)
                        for idx, oid in enumerate(order)
                    ]
                )
        except IntegrityError:
            return Response({"detail": "Already voted."}, status=status.HTTP_409_CONFLICT)
        broadcast(room, debounce=True)
        return Response({"status": "ok"}, status=status.HTTP_201_CREATED)

    if question.kind in Question.TEXT_KINDS:
        text = str(request.data.get("text", "")).strip()
        if not text:
            return Response({"detail": "Empty answer."}, status=400)
        option_ids = []
        # One term per participant: reject a repeat of the same word cloud
        # entry (case-insensitive, matching the aggregation's merge) (#14).
        if allow_multiple:
            key = " ".join(text.split())[:60].casefold()[:60]
            if Vote.objects.filter(
                run=run, question=question, token=token, text_key=key
            ).exists():
                return Response(
                    {"detail": "Diesen Begriff haben Sie schon genannt."},
                    status=status.HTTP_409_CONFLICT,
                )
    else:
        option_ids = request.data.get("options") or []
        if not isinstance(option_ids, list) or not option_ids:
            return Response({"detail": "No option selected."}, status=400)
        single = question.kind in (Question.Kind.SINGLE_CHOICE, Question.Kind.LIKERT)
        if single and len(option_ids) > 1:
            return Response({"detail": "Only one option allowed."}, status=400)
        options = list(
            AnswerOption.objects.filter(question=question, pk__in=option_ids)
        )
        if len(options) != len(set(option_ids)):
            return Response({"detail": "Invalid option."}, status=400)
        text = ""

    try:
        with transaction.atomic():
            if replace:
                ParticipantToken.objects.select_for_update().filter(pk=token.pk).first()
                Vote.objects.filter(run=run, question=question, token=token).delete()
            vote_obj = Vote.objects.create(
                run=run, question=question, token=token, text=text
            )
            if option_ids:
                vote_obj.options.set(options)
    except IntegrityError:
        return Response({"detail": "Already voted."}, status=status.HTTP_409_CONFLICT)

    broadcast(room, debounce=True)
    # Live free-text evaluation (v2 KI): hand the fresh answer to the
    # background worker; it labels it korrekt/unklar/falsch and pushes an
    # updated presenter snapshot. Only for opted-in open_text questions.
    if question.kind == Question.Kind.OPEN_TEXT and question.ai_evaluate:
        ai_evaluation.schedule(vote_obj.pk, room.pk)
    # Live word-cloud / free-text AI (consolidate/summarise + group): only
    # recomputes while the presenter is showing an AI view (throttled).
    if question.kind in Question.TEXT_KINDS:
        ai_wordcloud_live.schedule(run.pk, question.pk, room.pk)
    payload = {"status": "ok"}
    if run.mode == Run.Mode.SELF_PACED:
        feedback = _self_paced_feedback(run, question, set(option_ids))
        if feedback is not None:
            payload.update(feedback)
    return Response(payload, status=status.HTTP_201_CREATED)


@api_view(["POST"])
def retract(request, code):
    """Withdraw one of the participant's own word-cloud terms while the
    question is open (#14). Deletes only the caller's matching vote(s) —
    identified by the opaque token — so anonymity is preserved."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if run is None or run.phase != Run.Phase.OPEN:
        return Response({"detail": "Voting is closed."}, status=status.HTTP_409_CONFLICT)
    question = run.active_question
    if question is None:
        return Response({"detail": "Voting is closed."}, status=status.HTTP_409_CONFLICT)
    raw = str(request.data.get("text", "")).strip()
    key = " ".join(raw.split())[:60].casefold()[:60]
    if not key:
        return Response({"detail": "Empty answer."}, status=400)
    deleted, _ = Vote.objects.filter(
        run=run, question=question, token=token, text_key=key
    ).delete()
    if deleted:
        broadcast(room, debounce=True)
    return Response({"deleted": deleted})


def _self_paced_feedback(run, question, chosen_ids):
    """Instant right/wrong feedback (concept §6.3), unless the set says
    "never reveal" or the question has no correct answer marked."""
    if run.question_set.reveal_answers == "never":
        return None
    if question.kind not in Question.CHOICE_KINDS:
        return None
    correct_ids = set(
        question.options.filter(is_correct=True).values_list("pk", flat=True)
    )
    if not correct_ids:
        return None
    return {"correct": sorted(correct_ids), "is_correct": chosen_ids == correct_ids}


@api_view(["GET"])
def quiz(request, code):
    """All questions of the open self-paced run (concept §6.3).

    Fetched once by the participant page; ?token= additionally returns
    which questions this participant already answered (and whether
    correctly), so a reload resumes instead of restarting.
    """
    room = _room_by_code(code)
    run = active_run(room)
    if run is None or run.mode != Run.Mode.SELF_PACED or run.phase != Run.Phase.OPEN:
        return Response(
            {"detail": "No self-paced quiz is open."}, status=status.HTTP_409_CONFLICT
        )

    questions = list(run.question_set.questions.prefetch_related("options"))
    feedback = run.question_set.reveal_answers != "never"

    token = ParticipantToken.objects.filter(
        room=room, key=request.GET.get("token", "")
    ).first()

    if run.question_set.shuffle_questions and token is not None:
        # Stable per-participant order: same token always sees the same
        # shuffle across reloads/back-navigation, different tokens generally
        # see different orders. The canonical (position) order is used when
        # shuffling is off, and `answered` is keyed by question id so the
        # order here never affects resume (#75).
        random.Random(f"{run.pk}:{token.key}").shuffle(questions)

    answered = {}
    if token is not None:
        votes = run.votes.filter(token=token).prefetch_related(
            "options", "priority_scores", "ordering_responses"
        )
        for vote_obj in votes:
            question = next(
                (q for q in questions if q.pk == vote_obj.question_id), None
            )
            entry = {"is_correct": None, "chosen": {}, "correct": None}
            kind = question.kind if question else None
            if kind in Question.CHOICE_KINDS:
                entry["chosen"] = {"options": [o.pk for o in vote_obj.options.all()]}
                if feedback:
                    correct_ids = {o.pk for o in question.options.all() if o.is_correct}
                    if correct_ids:
                        entry["correct"] = sorted(correct_ids)
                        chosen_ids = {o.pk for o in vote_obj.options.all()}
                        entry["is_correct"] = chosen_ids == correct_ids
            elif kind in Question.TEXT_KINDS:
                entry["chosen"] = {"text": vote_obj.text or ""}
            elif kind == Question.Kind.PRIORITIES:
                entry["chosen"] = {
                    "points": {
                        str(ps.option_id): ps.points
                        for ps in vote_obj.priority_scores.all()
                    }
                }
            elif kind == Question.Kind.ORDERING:
                entry["chosen"] = {
                    "order": [
                        r.option_id
                        for r in sorted(
                            vote_obj.ordering_responses.all(),
                            key=lambda r: r.position,
                        )
                    ]
                }
            answered[str(vote_obj.question_id)] = entry

    return Response(
        {
            # {de, en} map (#33 MR2), matching every other title/text field in
            # this payload (via question_payload) and the live SSE snapshot.
            "set_title": translated_map(run.question_set, "title"),
            "feedback": feedback,
            "allow_back": run.question_set.allow_back_navigation,
            "questions": [question_payload(q, shuffle_seed=run.pk) for q in questions],
            "answered": answered,
            "ends_at": run.quiz_ends_at.isoformat() if run.quiz_ends_at else None,
        }
    )


@api_view(["GET"])
def my_evaluation(request, code):
    """The AI verdict of the CALLER'S OWN answer to the current open_text
    question, for live participant feedback. Token-scoped; only when the
    question opted into participant_feedback."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.GET.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if run is None:
        return Response({"status": "off"})
    q_id = request.GET.get("question")
    if run.mode == Run.Mode.SELF_PACED and q_id:
        question = Question.objects.filter(
            question_set=run.question_set, pk=q_id
        ).first()
    else:
        question = run.active_question
    if (
        question is None
        or question.kind != Question.Kind.OPEN_TEXT
        or not question.ai_evaluate
        or not question.participant_feedback
    ):
        return Response({"status": "off"})
    vote = Vote.objects.filter(run=run, question=question, token=token).first()
    if vote is None:
        return Response({"status": "off"})
    if not vote.ai_verdict:
        return Response({"status": "pending"})
    return Response({"status": "ready", "verdict": vote.ai_verdict, "note": vote.ai_note})


@api_view(["POST"])
def my_answer(request, code):
    """The CALLER'S OWN existing answer to a question of the current run.

    Lets the participant page show "already answered" + the earlier answer
    when a question is re-opened in the same run (instead of a form the
    server would reject with 409). Token-scoped — never other participants'
    data. ``can_change`` mirrors the answer-correction rule of ``vote``.
    """
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    not_answered = {"answered": False, "answer": None, "can_change": False}
    run = active_run(room)
    if run is None:
        return Response(not_answered)
    try:
        question_id = int(request.data.get("question"))
    except (TypeError, ValueError):
        return Response({"detail": "Unknown question."}, status=404)
    question = Question.objects.filter(
        question_set=run.question_set, pk=question_id
    ).first()
    if question is None:
        return Response({"detail": "Unknown question."}, status=404)
    votes = Vote.objects.filter(run=run, question=question, token=token).order_by(
        "created_at", "pk"
    )
    if question.kind == Question.Kind.PRIORITIES:
        votes = votes.prefetch_related("priority_scores")
    elif question.kind == Question.Kind.ORDERING:
        votes = votes.prefetch_related("ordering_responses")
    elif question.kind not in Question.TEXT_KINDS:
        votes = votes.prefetch_related("options")
    votes = list(votes)
    if not votes:
        return Response(not_answered)
    answer = {"options": [], "text": [], "points": {}, "order": []}
    for vote_obj in votes:
        if question.kind in Question.TEXT_KINDS:
            if vote_obj.text:
                answer["text"].append(vote_obj.text)
        elif question.kind == Question.Kind.PRIORITIES:
            answer["points"].update(
                {str(ps.option_id): ps.points for ps in vote_obj.priority_scores.all()}
            )
        elif question.kind == Question.Kind.ORDERING:
            answer["order"] = [
                r.option_id
                for r in sorted(vote_obj.ordering_responses.all(), key=lambda r: r.position)
            ]
        else:
            answer["options"].extend(
                {"id": o.pk} for o in sorted(vote_obj.options.all(), key=lambda o: o.pk)
            )
    return Response(
        {"answered": True, "answer": answer, "can_change": _can_replace_vote(run)}
    )


# --- mind map (stage 1): shared tree, token-scoped ---------------------------


def _mindmap_context(request, code):
    """(room, token, run, question) for a contributing mind-map request, or
    a refusal Response. Contributions require the open phase of a live run
    with this mind-map question active (and its countdown not expired)."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if (
        run is None
        or run.phase != Run.Phase.OPEN
        or run.mode != Run.Mode.LIVE
        or run.active_question is None
    ):
        return Response({"detail": "Voting is closed."}, status=status.HTTP_409_CONFLICT)
    question = run.active_question
    if question.kind != Question.Kind.MINDMAP:
        return Response({"detail": "Not a mind map question."}, status=400)
    if str(request.data.get("question")) != str(question.pk):
        return Response(
            {"detail": "Question is not open."}, status=status.HTTP_409_CONFLICT
        )
    if question.time_limit and run.opened_at:
        deadline = run.opened_at + timezone.timedelta(seconds=question.time_limit + 1)
        if timezone.now() > deadline:
            return Response({"detail": "Time is up."}, status=status.HTTP_409_CONFLICT)
    return room, token, run, question


@api_view(["POST"])
def mindmap_add(request, code):
    """Add a term below ``parent`` (null = a main branch below the root), or
    join the identical term already there (one node, count + 1)."""
    context = _mindmap_context(request, code)
    if isinstance(context, Response):
        return context
    room, token, run, question = context
    try:
        node, merged = mindmap.add_term(
            run, question, token,
            request.data.get("parent"),
            request.data.get("text", ""),
            request.data.get("description", ""),
        )
    except mindmap.MindmapError as error:
        return Response({"detail": error.detail}, status=error.status)
    broadcast(room, debounce=mindmap.BROADCAST_DEBOUNCE)
    return Response(
        {
            "node_id": node.pk,
            "merged": merged,
            "mine": mindmap.own_node_ids(run, question, token),
        },
        status=status.HTTP_201_CREATED,
    )


@api_view(["POST"])
def mindmap_remove(request, code):
    """Withdraw the caller's own term while nothing hangs below it; the node
    disappears with its last contribution unless it is predefined."""
    context = _mindmap_context(request, code)
    if isinstance(context, Response):
        return context
    room, token, run, question = context
    try:
        deleted = mindmap.remove_term(run, question, token, request.data.get("node"))
    except mindmap.MindmapError as error:
        return Response({"detail": error.detail}, status=error.status)
    broadcast(room, debounce=mindmap.BROADCAST_DEBOUNCE)
    return Response(
        {
            "status": "ok",
            "deleted": deleted,
            "mine": mindmap.own_node_ids(run, question, token),
        }
    )


@api_view(["POST"])
def mindmap_mine(request, code):
    """The ids of the nodes the CALLER contributed to in the active run
    (deletability after a reload). Never anyone else's data."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if run is None:
        return Response({"nodes": []})
    question = Question.objects.filter(
        question_set=run.question_set, pk=mindmap._parse_id(request.data.get("question"))
    ).first()
    if question is None:
        return Response({"detail": "Unknown question."}, status=404)
    return Response({"nodes": mindmap.own_node_ids(run, question, token)})


# --- four-field matrix: cards on a 2-axis board, token-scoped ---------------


def _matrix_context(request, code):
    """(room, token, run, question) for a contributing matrix request, or a
    refusal Response. Like ``_mindmap_context``: open phase of a live run
    with this matrix question active and its countdown not expired."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if (
        run is None
        or run.phase != Run.Phase.OPEN
        or run.mode != Run.Mode.LIVE
        or run.active_question is None
    ):
        return Response({"detail": "Voting is closed."}, status=status.HTTP_409_CONFLICT)
    question = run.active_question
    if question.kind != Question.Kind.MATRIX:
        return Response({"detail": "Not a matrix question."}, status=400)
    if str(request.data.get("question")) != str(question.pk):
        return Response(
            {"detail": "Question is not open."}, status=status.HTTP_409_CONFLICT
        )
    if question.time_limit and run.opened_at:
        deadline = run.opened_at + timezone.timedelta(seconds=question.time_limit + 1)
        if timezone.now() > deadline:
            return Response({"detail": "Time is up."}, status=status.HTTP_409_CONFLICT)
    return room, token, run, question


def _text_field(data, field):
    value = data.get(field, "")
    return value if isinstance(value, str) else ""


@api_view(["POST"])
def matrix_add(request, code):
    """Place a new card in ``zone``: ``{token, question, zone, title,
    category?, description?}`` → 201 ``{card_id, mine}``."""
    context = _matrix_context(request, code)
    if isinstance(context, Response):
        return context
    room, token, run, question = context
    try:
        card = matrix.add_card(
            run, question, token,
            request.data.get("zone"),
            _text_field(request.data, "title"),
            _text_field(request.data, "category"),
            _text_field(request.data, "description"),
        )
    except matrix.MatrixError as error:
        return Response(error.body(), status=error.status)
    broadcast(room, debounce=matrix.BROADCAST_DEBOUNCE)
    return Response(
        {"card_id": card.pk, "mine": matrix.mine_payload(run, question, token)},
        status=status.HTTP_201_CREATED,
    )


@api_view(["POST"])
def matrix_remove(request, code):
    """Withdraw the caller's own card: ``{token, question, card}``."""
    context = _matrix_context(request, code)
    if isinstance(context, Response):
        return context
    room, token, run, question = context
    try:
        matrix.remove_card(run, question, token, mindmap._parse_id(request.data.get("card")))
    except matrix.MatrixError as error:
        return Response(error.body(), status=error.status)
    broadcast(room, debounce=matrix.BROADCAST_DEBOUNCE)
    return Response({"status": "ok", "mine": matrix.mine_payload(run, question, token)})


@api_view(["POST"])
def matrix_mine(request, code):
    """The CALLER's own cards in the active run, in any phase (so the page
    still shows them after closing). Never anyone else's data."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if run is None:
        return Response({"mine": []})
    question = Question.objects.filter(
        question_set=run.question_set, kind=Question.Kind.MATRIX,
        pk=mindmap._parse_id(request.data.get("question")),
    ).first()
    if question is None:
        return Response({"detail": "Unknown question."}, status=404)
    return Response({"mine": matrix.mine_payload(run, question, token)})


@api_view(["POST"])
def matrix_rate(request, code):
    """Rating stage: one rating step on a card. ``{token, question, card,
    delta: 1|-1}`` (points) or ``{…, value: 1|-1|0}`` (plus/minus) → 200
    ``{card, value, remaining}``. Needs the open phase AND the rating stage;
    hidden cards and stack members cannot be rated (404)."""
    context = _matrix_context(request, code)
    if isinstance(context, Response):
        return context
    room, token, run, question = context
    data = request.data
    try:
        card = _strict_id(data, "card")
        if question.matrix_rating_mode == "points":
            delta = data.get("delta")
            if isinstance(delta, bool) or not isinstance(delta, int) or delta not in (1, -1):
                raise _BadField("delta must be 1 or -1.")
            kwargs = {"delta": delta}
        elif question.matrix_rating_mode == "updown":
            value = data.get("value")
            if isinstance(value, bool) or not isinstance(value, int) or value not in (1, -1, 0):
                raise _BadField("value must be 1, -1 or 0.")
            kwargs = {"value": value}
        else:
            return Response(
                {"detail": "Rating has not started."}, status=status.HTTP_409_CONFLICT
            )
        value, remaining = matrix_rating.rate(run, question, token, card, **kwargs)
    except _BadField as error:
        return Response({"detail": str(error)}, status=400)
    except matrix.MatrixError as error:
        return Response(error.body(), status=error.status)
    broadcast(room, debounce=matrix.BROADCAST_DEBOUNCE)
    return Response({"card": card, "value": value, "remaining": remaining})


@api_view(["POST"])
def matrix_my_ratings(request, code):
    """The CALLER's ratings in the active run: ``{token, question}`` →
    ``{ratings: {"<card id>": value}, remaining, budget, mode}`` (visible
    top cards only)."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if run is None:
        return Response({"ratings": {}, "remaining": 0})
    question = Question.objects.filter(
        question_set=run.question_set, kind=Question.Kind.MATRIX,
        pk=mindmap._parse_id(request.data.get("question")),
    ).first()
    if question is None:
        return Response({"detail": "Unknown question."}, status=404)
    return Response(matrix_rating.my_ratings(run, question, token))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_stage(request, run_id, question_id):
    """Presenter: ``{stage: "collect"|"rate", open?: bool}`` → 200
    ``{stage, phase}`` — like ``mindmap_stage``. "rate" needs a rating mode
    (409 otherwise); 409 for a finished run."""

    def action(run, question, data):
        stage = data.get("stage")
        if not isinstance(stage, str):
            raise _BadField("stage must be \"collect\" or \"rate\".")
        open_vote = data.get("open", False)
        if not isinstance(open_vote, bool):
            raise _BadField("open must be true or false.")
        stage = matrix_rating.set_stage(run, question, stage, open_vote=open_vote)
        return {"stage": stage, "phase": run.phase}

    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set,
        kind=Question.Kind.MATRIX,
    )
    if not isinstance(request.data, dict):
        return Response({"detail": "Invalid request."}, status=400)
    try:
        body = action(run, question, request.data)
    except _BadField as error:
        return Response({"detail": str(error)}, status=400)
    except matrix.MatrixError as error:
        return Response(error.body(), status=error.status)
    broadcast(room, debounce=matrix.BROADCAST_DEBOUNCE)
    return Response(body)


def _matrix_owner(request, run_id, question_id):
    """``(run, room, question)`` of a matrix question for the room's owner;
    404 for anyone else and for non-matrix questions."""
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set,
        kind=Question.Kind.MATRIX,
    )
    return run, room, question


def _matrix_moderate(request, run_id, question_id, action, http_status=200):
    """Owner-only shell for the presenter endpoints: 404 for anyone else and
    for non-matrix questions, MatrixError mapping, board echo + broadcast."""
    run, room, question = _matrix_owner(request, run_id, question_id)
    if not isinstance(request.data, dict):
        return Response({"detail": "Invalid request."}, status=400)
    try:
        action(run, question, request.data)
    except matrix.MatrixError as error:
        return Response(error.body(), status=error.status)
    broadcast(room, debounce=matrix.BROADCAST_DEBOUNCE)
    return Response(
        {"matrix": matrix.board_payload(run, question, presenter=True)}, status=http_status
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_move(request, run_id, question_id):
    """Presenter: ``{card, x, y}`` — drop a card (its stack) at a point."""
    return _matrix_moderate(
        request, run_id, question_id,
        lambda run, q, d: matrix.move_card(
            run, q, mindmap._parse_id(d.get("card")), d.get("x"), d.get("y")
        ),
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_stack(request, run_id, question_id):
    """Presenter: ``{card, onto}`` — put a card (with its stack) onto another."""
    return _matrix_moderate(
        request, run_id, question_id,
        lambda run, q, d: matrix.stack_card(
            run, q, mindmap._parse_id(d.get("card")), mindmap._parse_id(d.get("onto"))
        ),
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_unstack(request, run_id, question_id):
    """Presenter: ``{card}`` — take a card out of its stack."""
    return _matrix_moderate(
        request, run_id, question_id,
        lambda run, q, d: matrix.unstack_card(run, q, mindmap._parse_id(d.get("card"))),
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_hide(request, run_id, question_id):
    """Presenter: ``{card, hidden: bool}`` — hide/unhide for everyone."""

    def action(run, question, data):
        hidden = data.get("hidden")
        if not isinstance(hidden, bool):
            raise matrix.MatrixError("hidden must be true or false.")
        matrix.set_hidden(run, question, mindmap._parse_id(data.get("card")), hidden)

    return _matrix_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_teacher_add(request, run_id, question_id):
    """Presenter adds a card: ``{zone, title, category?, description?}``."""
    return _matrix_moderate(
        request, run_id, question_id,
        lambda run, q, d: matrix.add_teacher_card(
            run, q, d.get("zone"), _text_field(d, "title"),
            _text_field(d, "category"), _text_field(d, "description"),
        ),
        http_status=201,
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_teacher_delete(request, run_id, question_id):
    """Undo of a presenter's add: ``{card}``."""
    return _matrix_moderate(
        request, run_id, question_id,
        lambda run, q, d: matrix.delete_teacher_card(
            run, q, mindmap._parse_id(d.get("card"))
        ),
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_ai_propose(request, run_id, question_id):
    """Presenter (expert mode): ask the LLM which cards of a field belong
    together. Body ``{level: "spelling"|"same"|"similar"}`` → 200 ``{groups,
    hints, dropped, proposal}`` (``matrix.simulate_groups``/``simulate_hints``;
    ``dropped`` = malformed reply entries + skipped groups + dropped hints;
    ``proposal`` = the signed parsed reply for ai-apply, 24 h). Nothing
    changes. 503 AI not configured, 400 invalid level / AI switch off /
    fewer than 3 visible cards, 409 rating stage, 502 AI error."""
    run, _room, question = _matrix_owner(request, run_id, question_id)
    data = request.data
    if not isinstance(data, dict) or data.get("level") not in ai_matrix.LEVELS:
        return Response(
            {"detail": "level must be one of: " + ", ".join(ai_matrix.LEVELS) + "."},
            status=400,
        )
    if not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=503)
    if not question.wordcloud_ai_enabled:
        return Response(
            {"detail": "KI-Funktionen sind für diese Frage nicht aktiviert."}, status=400
        )
    if matrix.is_rating(run, question):
        return Response({"detail": matrix.STACKS_LOCKED}, status=409)
    if len(ai_matrix.visible_cards(run, question)) < 3:
        return Response({"detail": "At least 3 cards are needed."}, status=400)
    system, user = ai_matrix.build_prompt(run, question, data["level"])
    try:
        reply = ai.chat_json(system, user)
    except ai.AIError as exc:
        return Response({"detail": f"KI-Fehler: {exc}"}, status=502)
    groups, hints, malformed = ai_matrix.parse_reply(reply)
    previews = matrix.simulate_groups(run, question, groups)
    hint_previews = matrix.simulate_hints(run, question, hints)
    skipped = sum(1 for g in previews if g["status"] != "ok")
    return Response({
        "groups": previews,
        "hints": hint_previews,
        "dropped": malformed + skipped + len(hints) - len(hint_previews),
        "proposal": matrix.sign_proposal(
            run, question, matrix.with_tops(groups, previews), hints, malformed
        ),
    })


def _matrix_ai_edits(data, count):
    """``{index: {title?, description?, category?}}`` from the JSON body
    (string keys); _BadField for anything else."""
    raw = data.get("edits", {})
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise _BadField("edits must be an object.")
    edits = {}
    for key, edit in raw.items():
        if not (isinstance(key, str) and key.isdecimal() and int(key) < count):
            raise _BadField("edits must be keyed by proposal indices.")
        if not isinstance(edit, dict) or not all(
            edit.get(field) is None or isinstance(edit[field], str)
            for field in ("title", "description", "category")
        ):
            raise _BadField("An edit has title/description/category strings.")
        edits[int(key)] = edit
    return edits


def _matrix_ai_moderate(request, run_id, question_id, action):
    """Owner-only shell for ai-apply/ai-undo: _BadField/MatrixError mapping,
    then one broadcast (none when an apply applied nothing); the body gets
    the presenter board."""
    run, room, question = _matrix_owner(request, run_id, question_id)
    if not isinstance(request.data, dict):
        return Response({"detail": "Invalid request."}, status=400)
    try:
        body = action(run, question, request.data)
    except _BadField as error:
        return Response({"detail": str(error)}, status=400)
    except matrix.MatrixError as error:
        return Response(error.body(), status=error.status)
    if body.get("applied", True):  # ai-undo bodies carry no "applied"
        broadcast(room, debounce=matrix.BROADCAST_DEBOUNCE)
    return Response({**body, "matrix": matrix.board_payload(run, question, presenter=True)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_ai_apply(request, run_id, question_id):
    """Apply the selected groups of a proposal in one step: ``{proposal,
    selected: [index], edits?: {index: {title?, description?, category?}}}``
    → 200 ``{applied, skipped, undo, matrix}`` (``skipped`` = selected groups
    that no longer fit the board). One broadcast; 409 while rating."""

    def action(run, question, data):
        groups, _hints, _malformed = matrix.unsign_proposal(run, question, data.get("proposal"))
        selected = data.get("selected")
        if not isinstance(selected, list) or not all(
            isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(groups)
            for i in selected
        ):
            raise _BadField("selected must be a list of proposal indices.")
        edits = _matrix_ai_edits(data, len(groups))
        return matrix.apply_groups(run, question, groups, selected, edits)

    return _matrix_ai_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def matrix_ai_undo(request, run_id, question_id):
    """Undo an applied step: ``{undo}`` (from ai-apply) → 200 ``{status: "ok",
    matrix}``; 409 ``{detail}`` (nothing changed) when a stack changed since."""

    def action(run, question, data):
        matrix.undo_groups(run, question, data.get("undo"))
        return {"status": "ok"}

    return _matrix_ai_moderate(request, run_id, question_id, action)


@api_view(["POST"])
def mindmap_rate(request, code):
    """Rating phase: one rating step on an entry. ``{token, question, node,
    delta: 1|-1}`` (points) or ``{…, value: 1|-1|0}`` (plus/minus) →
    200 ``{node, value, remaining}``. Needs the open phase AND the rating
    stage; the root (``node: null``) and hidden entries cannot be rated."""
    context = _mindmap_context(request, code)
    if isinstance(context, Response):
        return context
    room, token, run, question = context
    data = request.data
    try:
        node = _strict_id(data, "node")
        if question.mindmap_rating_mode == "points":
            delta = data.get("delta")
            if isinstance(delta, bool) or not isinstance(delta, int) or delta not in (1, -1):
                raise _BadField("delta must be 1 or -1.")
            kwargs = {"delta": delta}
        else:
            value = data.get("value")
            if isinstance(value, bool) or not isinstance(value, int) or value not in (1, -1, 0):
                raise _BadField("value must be 1, -1 or 0.")
            kwargs = {"value": value}
        value, remaining = mindmap_rating.rate(run, question, token, node, **kwargs)
    except _BadField as error:
        return Response({"detail": str(error)}, status=400)
    except mindmap.MindmapError as error:
        return Response(error.body(), status=error.status)
    broadcast(room, debounce=mindmap.BROADCAST_DEBOUNCE)
    return Response({"node": node, "value": value, "remaining": remaining})


@api_view(["POST"])
def mindmap_my_ratings(request, code):
    """The CALLER's ratings in the active run: ``{token, question}`` →
    ``{ratings: {"<node id>": value}, remaining}`` (visible entries only)."""
    room = _room_by_code(code)
    token = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    run = active_run(room)
    if run is None:
        return Response({"ratings": {}, "remaining": 0})
    question = Question.objects.filter(
        question_set=run.question_set, kind=Question.Kind.MINDMAP,
        pk=mindmap._parse_id(request.data.get("question")),
    ).first()
    if question is None:
        return Response({"detail": "Unknown question."}, status=404)
    return Response(mindmap_rating.my_ratings(run, question, token))


# --- recording mode (#53): async viewer voting ------------------------------


def _recording_run(token):
    """The recorded run for a deep-link token, or 404. Independent of the
    room's active run — a recorded run may be finished and still accept
    async votes."""
    run = (
        Run.objects.filter(recording_token=token)
        .select_related("question_set__room")
        .first()
        if token
        else None
    )
    if run is None:
        raise Http404
    return run


class _AnswerError(Exception):
    """Payload validation error for a single vote."""

    def __init__(self, detail):
        self.detail = detail


def _parse_answer(question, data):
    """Validate a vote payload for ``question``; return (text, option_ids,
    options). Raises _AnswerError(detail) on invalid input. Shared shape with
    the live vote view."""
    if question.kind in Question.TEXT_KINDS:
        text = str(data.get("text", "")).strip()
        if not text:
            raise _AnswerError("Empty answer.")
        return text, [], []
    option_ids = data.get("options") or []
    if not isinstance(option_ids, list) or not option_ids:
        raise _AnswerError("No option selected.")
    single = question.kind in (Question.Kind.SINGLE_CHOICE, Question.Kind.LIKERT)
    if single and len(option_ids) > 1:
        raise _AnswerError("Only one option allowed.")
    options = list(AnswerOption.objects.filter(question=question, pk__in=option_ids))
    if len(options) != len(set(option_ids)):
        raise _AnswerError("Invalid option.")
    return "", option_ids, options


def _question_results(run, question):
    """Combined per-question results (all sources) for the viewer client."""
    if question.kind == Question.Kind.MATRIX:
        return {"matrix": matrix.board_payload(run, question, presenter=False)}
    if question.kind == Question.Kind.MINDMAP:
        return {"mindmap": mindmap.build_tree(run, question, presenter=False)}
    if question.kind in Question.TEXT_KINDS:
        return {"words": words_with_counts(run, question)}
    if question.kind == Question.Kind.PRIORITIES:
        return {"priorities": priority_stats(run, question)}
    if question.kind == Question.Kind.ORDERING:
        return {"ordering": ordering_stats(run, question)}
    payload = {"results": options_with_counts(run, question)}
    if question.kind == Question.Kind.LIKERT:
        payload["likert"] = likert_summary(payload["results"])
    return payload


@api_view(["GET"])
def recording_questions(request, token):
    """All questions of a recorded run for the async viewer (#53).

    Mirrors ``quiz`` but is keyed by the run's recording token and returns the
    combined results for questions this viewer already answered (?token=), so a
    reload/resume shows results for answered questions.
    """
    run = _recording_run(token)
    # Mind maps are built live only — a recording viewer can't contribute
    # after the fact, so they are not listed at all.
    questions = list(
        run.question_set.questions.exclude(
            kind__in=(Question.Kind.MINDMAP, Question.Kind.MATRIX)
        )
        .prefetch_related("options")
    )
    feedback = run.question_set.reveal_answers != "never"

    answered = {}
    token_obj = ParticipantToken.objects.filter(
        room=run.question_set.room, key=request.GET.get("token", "")
    ).first()
    if token_obj is not None:
        votes = run.votes.filter(
            token=token_obj, source=Vote.Source.RECORDING
        ).prefetch_related("options")
        by_id = {q.pk: q for q in questions}
        for vote_obj in votes:
            question = by_id.get(vote_obj.question_id)
            if question is None:
                continue
            entry = {"is_correct": None, **_question_results(run, question)}
            if feedback and question.kind in Question.CHOICE_KINDS:
                correct_ids = {o.pk for o in question.options.all() if o.is_correct}
                if correct_ids:
                    chosen_ids = {o.pk for o in vote_obj.options.all()}
                    entry["is_correct"] = chosen_ids == correct_ids
                    entry["correct"] = sorted(correct_ids)
            answered[str(vote_obj.question_id)] = entry

    return Response(
        {
            "set_title": translated_map(run.question_set, "title"),
            "room_code": run.question_set.room.code,
            "feedback": feedback,
            "questions": [question_payload(q, shuffle_seed=run.pk) for q in questions],
            "answered": answered,
        }
    )


@api_view(["POST"])
def recording_vote(request, token):
    """Record an async viewer's answer against the recorded run (#53).

    Dedicated path: bypasses ``active_run``/phase gating; no server-side time
    limit (client countdown only). Tags the vote ``source=recording`` so it
    attributes to the original run yet stays separable from on-site votes.
    Returns the combined results for the question so the viewer sees them.
    """
    run = _recording_run(token)
    room = run.question_set.room
    token_obj = ParticipantToken.objects.filter(
        room=room, key=request.data.get("token", "")
    ).first()
    if token_obj is None:
        return Response({"detail": "Unknown participant token."}, status=403)
    question = Question.objects.filter(
        question_set=run.question_set, pk=request.data.get("question")
    ).first()
    if question is None:
        return Response({"detail": "Unknown question."}, status=400)
    if question.kind == Question.Kind.MATRIX:
        return Response(
            {"detail": "Matrix cards are added via the matrix."}, status=400
        )
    if question.kind == Question.Kind.MINDMAP:
        # Mind maps are built live only; recordings cannot add terms.
        return Response(
            {"detail": "Mind map terms are added via the mind map."}, status=400
        )

    allow_multiple = (
        question.kind == Question.Kind.WORD_CLOUD and question.allow_multiple
    )
    if not allow_multiple and Vote.objects.filter(
        run=run, question=question, token=token_obj, source=Vote.Source.RECORDING
    ).exists():
        return Response({"detail": "Already voted."}, status=status.HTTP_409_CONFLICT)

    # Per-participant cap for allow_multiple word clouds (#76), recording path.
    if allow_multiple and question.wordcloud_max_answers and Vote.objects.filter(
        run=run, question=question, token=token_obj, source=Vote.Source.RECORDING
    ).count() >= question.wordcloud_max_answers:
        return Response(
            {"detail": "Maximum reached."}, status=status.HTTP_409_CONFLICT
        )

    if question.kind == Question.Kind.PRIORITIES:
        cleaned, error = _clean_priority_points(question, request.data.get("points"))
        if error:
            return Response({"detail": error}, status=400)
        options = {o.pk: o for o in question.options.all()}
        with transaction.atomic():
            vote_obj = Vote.objects.create(
                run=run, question=question, token=token_obj,
                source=Vote.Source.RECORDING,
            )
            PriorityScore.objects.bulk_create(
                [PriorityScore(vote=vote_obj, option=options[oid], points=pts)
                 for oid, pts in cleaned.items()]
            )
        return Response(
            {"status": "ok", **_question_results(run, question)},
            status=status.HTTP_201_CREATED,
        )

    if question.kind == Question.Kind.ORDERING:
        order, error = _clean_ordering(question, request.data.get("order"))
        if error:
            return Response({"detail": error}, status=400)
        options = {o.pk: o for o in question.options.all()}
        with transaction.atomic():
            vote_obj = Vote.objects.create(
                run=run, question=question, token=token_obj,
                source=Vote.Source.RECORDING,
            )
            OrderingResponse.objects.bulk_create(
                [OrderingResponse(vote=vote_obj, option=options[oid], position=idx)
                 for idx, oid in enumerate(order)]
            )
        return Response(
            {"status": "ok", **_question_results(run, question)},
            status=status.HTTP_201_CREATED,
        )

    try:
        text, option_ids, options = _parse_answer(question, request.data)
    except _AnswerError as error:
        return Response({"detail": error.detail}, status=400)

    if allow_multiple and text:
        key = " ".join(text.split())[:60].casefold()[:60]
        if Vote.objects.filter(
            run=run, question=question, token=token_obj,
            source=Vote.Source.RECORDING, text_key=key,
        ).exists():
            return Response(
                {"detail": "Diesen Begriff haben Sie schon genannt."},
                status=status.HTTP_409_CONFLICT,
            )

    with transaction.atomic():
        vote_obj = Vote.objects.create(
            run=run, question=question, token=token_obj, text=text,
            source=Vote.Source.RECORDING,
        )
        if option_ids:
            vote_obj.options.set(options)

    payload = {"status": "ok", **_question_results(run, question)}
    feedback = _self_paced_feedback(run, question, set(option_ids))
    if feedback is not None:
        payload.update(feedback)
    return Response(payload, status=status.HTTP_201_CREATED)


def recording_qr(request, token):
    """QR code for a recorded run's per-question deep link (#53)."""
    _recording_run(token)  # 404 for an unknown/disabled token
    url = request.build_absolute_uri(f"/r/{token}/")
    question_id = request.GET.get("q")
    if question_id and question_id.isdigit():
        url += f"?q={question_id}"
    image = qrcode.make(url, box_size=8, border=1)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return HttpResponse(buffer.getvalue(), content_type="image/png")


@ensure_csrf_cookie
def recording_page(request, token):
    """The async viewer page for a recording (#53) — reuses participant.html
    in recording mode (no SSE; drives the question flow via the recording
    endpoints)."""
    lang = _lang_from_query(request)
    run = _recording_run(token)
    room = run.question_set.room
    site = SiteConfig.load()
    closing_html = clean_html(site.closing_info) + clean_html(room.closing_info)
    entry = request.GET.get("q") or ""
    response = render(
        request,
        "live/participant.html",
        {
            "room": room,
            "closing_html": closing_html,
            "CONTENT_DEFAULT_LANGUAGE": settings.MODELTRANSLATION_DEFAULT_LANGUAGE,
            "recording_token": token,
            "entry_question": entry if entry.isdigit() else "",
        },
    )
    if lang:
        response.set_cookie(settings.LANGUAGE_COOKIE_NAME, lang, max_age=31536000, samesite="Lax")
    return response


# --- self-check mode (#75 Phase 3): async, permanent Lernkontrolle link -----


def _self_check_set(token):
    """The published Lernkontrolle for a token, or 404 (unpublished = 404).

    Type-guarded: a token that got onto a non-self_check set (shouldn't
    happen via the UI, but keep the lookup honest) is treated as unknown."""
    qs = (
        QuestionSet.objects.filter(
            self_check_token=token, type=QuestionSet.SetType.SELF_CHECK
        )
        .select_related("room")
        .first()
        if token
        else None
    )
    if qs is None:
        raise Http404
    return qs


def _self_check_solution(question):
    """Solution data added to a self-check question payload — never sent on
    any other participant path (#75 Phase 3 is the only place answers leak
    to the client ahead of time)."""
    correct = []
    model_solution = ""
    correct_order = []
    if question.kind in Question.CHOICE_KINDS:
        correct = sorted(o.pk for o in question.options.all() if o.is_correct)
    elif question.kind == Question.Kind.OPEN_TEXT:
        model_solution = question.model_solution
    elif question.kind == Question.Kind.ORDERING:
        correct_order = [
            o.pk for o in sorted(question.options.all(), key=lambda o: o.position)
        ]
    return {
        "correct": correct,
        "model_solution": model_solution,
        "correct_order": correct_order,
    }


@api_view(["GET"])
def check_questions(request, token):
    """All questions of a published Lernkontrolle, with solutions, for the
    self-check participant page (#75 Phase 3).

    No participant token/identity involved — self-check is anonymous and
    stateless per attempt, unlike recording/self-paced resume. ``?q=<id>``
    restricts to a single question (per-question QR deep link)."""
    qs = _self_check_set(token)
    questions = list(qs.questions.prefetch_related("options"))
    q_id = request.GET.get("q")
    single = bool(q_id and q_id.isdigit())
    if single:
        questions = [q for q in questions if q.pk == int(q_id)]
        if not questions:
            raise Http404
    elif qs.shuffle_questions:
        # Fresh per call = per attempt (no seed/token to key a stable order
        # on — self-check is anonymous).
        random.shuffle(questions)

    return Response(
        {
            "set_title": translated_map(qs, "title"),
            "shuffle_questions": qs.shuffle_questions,
            "reveal_only_in_summary": qs.reveal_only_in_summary,
            "single": single,
            "questions": [
                {
                    **question_payload(q, shuffle_seed=random.randrange(1 << 30)),
                    **_self_check_solution(q),
                    "ai_evaluate": q.kind == Question.Kind.OPEN_TEXT and q.ai_evaluate,
                }
                for q in questions
            ],
        }
    )


@api_view(["POST"])
def check_attempt(request, token):
    """Record an anonymous attempt counter for a Lernkontrolle (#75 Phase 3).

    No auth, no token: participants are anonymous by design. The client
    reports how it scored itself (correct/scored are computed there against
    the solutions from ``check_questions``); this endpoint only clamps and
    counts — it never re-derives correctness server-side."""
    qs = _self_check_set(token)

    question = None
    question_id = request.data.get("question")
    if question_id not in (None, ""):
        try:
            question_id = int(question_id)
        except (TypeError, ValueError):
            return Response({"detail": "Unknown question."}, status=400)
        question = Question.objects.filter(question_set=qs, pk=question_id).first()
        if question is None:
            return Response({"detail": "Unknown question."}, status=400)

    try:
        correct = int(request.data.get("correct"))
        scored = int(request.data.get("scored"))
    except (TypeError, ValueError):
        return Response({"detail": "Invalid attempt data."}, status=400)

    total = 1 if question is not None else qs.questions.count()
    scored = max(0, min(scored, total))
    correct = max(0, min(correct, scored))

    SelfCheckAttempt.objects.create(
        question_set=qs, question=question, correct=correct, scored=scored
    )
    return Response({"status": "ok"}, status=status.HTTP_201_CREATED)


@api_view(["POST"])
def check_grade(request, token):
    """AI-assess one free-text answer in a Lernkontrolle (#75 Phase 3).

    Anonymous like the other check endpoints, but synchronous: the stateless
    viewer has no SSE to poll. Guarded by a per-set rate limit and a dedup
    cache (live/self_check_ai). Returns the verdict on the question's scale;
    the client marks the answer correct iff it is the first category."""
    from . import self_check_ai

    qs = _self_check_set(token)
    try:
        question_id = int(request.data.get("question"))
    except (TypeError, ValueError):
        return Response({"detail": "Not gradable."}, status=400)
    question = Question.objects.filter(question_set=qs, pk=question_id).first()
    if (
        question is None
        or question.kind != Question.Kind.OPEN_TEXT
        or not question.ai_evaluate
    ):
        return Response({"detail": "Not gradable."}, status=400)
    answer = str(request.data.get("answer", "")).strip()
    if not answer:
        return Response({"detail": "Empty answer."}, status=400)
    if not ai.is_enabled():
        return Response({"detail": "ai-unavailable"}, status=409)
    if not self_check_ai.allow(qs.pk):
        return Response({"detail": "rate-limited"}, status=429)

    verdict, note = self_check_ai.grade(question, answer)
    categories = clean_categories(question.evaluation_categories)
    index = categories.index(verdict) if verdict in categories else len(categories) // 2
    return Response(
        {
            "verdict": verdict,
            "note": note,
            "categories": categories,
            "index": index,
            "correct": index == 0,
        }
    )


def check_qr(request, token):
    """QR code for a Lernkontrolle's (optionally per-question) link."""
    _self_check_set(token)  # 404 for an unknown/unpublished token
    url = request.build_absolute_uri(f"/c/{token}/")
    question_id = request.GET.get("q")
    if question_id and question_id.isdigit():
        url += f"?q={question_id}"
    image = qrcode.make(url, box_size=8, border=1)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return HttpResponse(buffer.getvalue(), content_type="image/png")


@ensure_csrf_cookie
def check_page(request, token):
    """The Lernkontrolle participant page (#75 Phase 3) — reuses
    participant.html like the recording viewer (no SSE; drives the question
    flow via the check endpoints)."""
    lang = _lang_from_query(request)
    qs = _self_check_set(token)
    room = qs.room
    site = SiteConfig.load()
    closing_html = clean_html(site.closing_info) + clean_html(room.closing_info)
    entry = request.GET.get("q") or ""
    response = render(
        request,
        "live/participant.html",
        {
            "room": room,
            "closing_html": closing_html,
            "CONTENT_DEFAULT_LANGUAGE": settings.MODELTRANSLATION_DEFAULT_LANGUAGE,
            "check_token": token,
            "entry_question": entry if entry.isdigit() else "",
        },
    )
    if lang:
        response.set_cookie(settings.LANGUAGE_COOKIE_NAME, lang, max_age=31536000, samesite="Lax")
    return response


# --- presenter API -----------------------------------------------------------


# An ongoing presentation: a question opened within this window on a still-
# running (non-finished) run means "same session" — the presenter skips the
# start dialog and the lobby (#recent-session).
RECENT_START_WINDOW = timezone.timedelta(minutes=120)


def _recently_started(question_set):
    cutoff = timezone.now() - RECENT_START_WINDOW
    return (
        Run.objects.filter(question_set=question_set, opened_at__gte=cutoff)
        .exclude(phase=Run.Phase.FINISHED)
        .exists()
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def live_status(request, set_id):
    """For the start dialog: is there an active run / stored votes?"""
    question_set = get_object_or_404(QuestionSet, pk=set_id)
    if not _require_owner(request.user, question_set.room):
        raise Http404
    run = (
        Run.objects.filter(question_set=question_set)
        .exclude(phase=Run.Phase.FINISHED)
        .first()
    )
    # "Votes" here means any stored answers, mind-map contributions included.
    has_votes = question_set.runs.filter(mindmap.answered_runs_q()).exists()
    # Whether the run the start dialog would resume already carries answers —
    # lets the UI offer archive/delete instead of silently appending (#70).
    active_run_has_votes = bool(run and mindmap.run_has_answers(run))
    # The set overview's „Umfrage beenden" (spec PR 2) only for a run that is
    # actually in use: past the lobby, left by the presenter (participants
    # see „paused", even if nobody answered yet), or carrying answers — not
    # the empty lobby run that „Ergebnisse archivieren" prepares.
    active_run_in_use = bool(
        run
        and (
            run.phase != Run.Phase.LOBBY
            or run.presenter_away
            or active_run_has_votes
        )
    )
    return Response(
        {
            "active_run": run.pk if run else None,
            "active_run_phase": run.phase if run else None,
            "active_run_in_use": active_run_in_use,
            "has_votes": has_votes,
            "active_run_has_votes": active_run_has_votes,
            "recently_started": _recently_started(question_set),
            "room_code": question_set.room.code,
        }
    )


def _finish_other_room_runs(room, keep_set):
    """Enforce one active run per room: archive (has votes or mind-map
    contributions, or a minted
    recording token) or delete (neither) the unfinished runs of *other* sets
    in ``room`` before a new run is activated. The participant page shows a
    single active run, but the per-set constraint
    (``one_active_run_per_set``) still allows a different set to hold an
    unfinished run — this closes that gap. A run with a recording token
    must be archived rather than deleted: the recording vote path
    (``recording_vote``/``_recording_run``) is phase-independent, so a
    finished run still serves its shared ``/r/<token>/`` link and accepts
    future async votes — deleting it would break that link and lose them.
    The target set (``keep_set``) keeps its own continue/archive/delete
    flow."""
    others = (
        Run.objects.filter(question_set__room=room)
        .exclude(phase=Run.Phase.FINISHED)
        .exclude(question_set=keep_set)
    )
    for other in others:
        if mindmap.run_has_answers(other) or other.recording_token:
            other.phase = Run.Phase.FINISHED
            other.ended_at = timezone.now()
            other.save(update_fields=["phase", "ended_at", "updated_at"])
        else:
            other.delete()


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def start_run(request, set_id):
    """Start presenting: reuse the unfinished run, or reset (delete results).

    Body: {"reset": bool, "mode": "live"|"self_paced"} — reset deletes all
    previous runs of this set including votes ("Ergebnisse löschen? ja");
    otherwise new votes add to the existing ones (Cliqr behaviour).
    Teacher-paced ↔ self-paced is switchable (concept §6.3): starting in
    the other mode repurposes the unfinished run.
    """
    question_set = get_object_or_404(QuestionSet.objects.select_related("room"), pk=set_id)
    if not _require_owner(request.user, question_set.room):
        raise Http404
    mode = request.data.get("mode") or Run.Mode.LIVE
    if mode not in {m.value for m in Run.Mode}:
        return Response({"detail": "Invalid mode."}, status=400)

    # Serialize concurrent starts (#66): two presenters opening the same set
    # within milliseconds both read "no active run" and both try to create
    # one, tripping the ``one_active_run_per_set`` constraint as an
    # unhandled 500. Locking the room row makes the second request wait for
    # the first to commit, then see (and reuse) the run it created.
    with transaction.atomic():
        Room.objects.select_for_update().get(pk=question_set.room_id)

        # One active run per room: a room's participant page shows a single
        # active run, so finish/drop any unfinished run of *other* sets first.
        _finish_other_room_runs(question_set.room, question_set)

        # What to do with prior results of this set (start dialog, #17):
        #   delete   — wipe all previous runs and start empty
        #   continue — keep counting into the most recent run (same Durchführung)
        #   archive  — leave previous runs as named archives, start a fresh one
        # (legacy ``reset`` maps to delete / continue.)
        existing = request.data.get("existing")
        user = request.user
        if (
            existing is None
            and not request.data.get("reset")
            and getattr(user, "effective_easy_mode", False)
        ):
            # Easy mode (#52): no start dialog — auto-archive when the latest
            # non-empty run is from another calendar day, else continue. Driven
            # by ``effective_easy_mode`` (explicit choice, else Pro default for
            # staff / Simple default for everyone else) so an admin who opted
            # into Simple gets this too, not just non-staff users. Only kicks in
            # when the request carries no explicit signal at all (no
            # ``existing``, no legacy ``reset``) — an easy-mode UI never sends
            # either, but pre-existing/legacy callers that do must be unaffected.
            if _recently_started(question_set):
                # An ongoing session (a question opened within the window) always
                # continues, even across a calendar-day boundary.
                existing = "continue"
            else:
                last = (
                    question_set.runs.filter(mindmap.answered_runs_q())
                    .order_by("-created_at")
                    .first()
                )
                if last is not None and timezone.localdate(last.created_at) != timezone.localdate():
                    existing = "archive"
                else:
                    existing = "continue"
        if existing not in {"delete", "continue", "archive"}:
            existing = "delete" if request.data.get("reset") else "continue"

        if existing == "delete":
            Run.objects.filter(question_set=question_set).delete()
        elif existing == "archive":
            # Keep the current Durchführung as an archive. This must also handle an
            # UNFINISHED run that already carries answers (the presenter closed the
            # tab without ending it) — otherwise the code below would reactivate it
            # and new votes would land on the old run instead of a fresh one (#70).
            # An empty unfinished run needs no archiving; it is reused below.
            for stale in (
                Run.objects.filter(question_set=question_set)
                .exclude(phase=Run.Phase.FINISHED)
            ):
                if mindmap.run_has_answers(stale):
                    stale.phase = Run.Phase.FINISHED
                    stale.ended_at = timezone.now()
                    stale.save(update_fields=["phase", "ended_at", "updated_at"])

        initial_phase = Run.Phase.OPEN if mode == Run.Mode.SELF_PACED else Run.Phase.LOBBY

        # An unfinished run is always resumed (the start dialog only appears once
        # every run is finished). Otherwise: continue reactivates the latest run;
        # archive/delete begin a brand-new one alongside/without the old.
        run = (
            Run.objects.filter(question_set=question_set)
            .exclude(phase=Run.Phase.FINISHED)
            .first()
        )
        if run is None and existing == "continue":
            run = Run.objects.filter(question_set=question_set).order_by("-created_at").first()

        if run is None:
            run = Run.objects.create(question_set=question_set, mode=mode, phase=initial_phase)
            if mode == Run.Mode.SELF_PACED:
                run.first_opened_at = timezone.now()
                update_fields = ["first_opened_at"]
                if question_set.quiz_time_limit:
                    run.quiz_ends_at = run.first_opened_at + timezone.timedelta(
                        seconds=question_set.quiz_time_limit
                    )
                    update_fields.append("quiz_ends_at")
                run.save(update_fields=update_fields)
        else:
            run.mode = mode
            # Recent ongoing session (#recent-session): resume in place — keep the
            # current phase / active question / reveal so the presenter lands back
            # on the live question instead of the lobby. Otherwise start fresh.
            if not _recently_started(question_set):
                run.phase = initial_phase
                run.active_question = None
                run.answers_revealed = False
                # #75: a fresh self-paced session gets a fresh overall deadline
                # (or none); otherwise a re-run would inherit the previous run's
                # already-passed clock.
                if mode == Run.Mode.SELF_PACED:
                    run.quiz_ends_at = (
                        timezone.now()
                        + timezone.timedelta(seconds=question_set.quiz_time_limit)
                        if question_set.quiz_time_limit
                        else None
                    )
            run.ended_at = None
            # The presenter is back: participants leave the „paused" screen.
            run.presenter_away = False
            if mode == Run.Mode.SELF_PACED and run.first_opened_at is None:
                run.first_opened_at = timezone.now()
                if question_set.quiz_time_limit:
                    run.quiz_ends_at = run.first_opened_at + timezone.timedelta(
                        seconds=question_set.quiz_time_limit
                    )
            run.save()
        # Recording mode (#53): opt-in per presentation, live only. Mints a
        # recording token so viewers of the recording can vote later via
        # /r/<token>/. Never for self-paced (already async). Pro feature — the
        # easy-mode start flow never sends it.
        if mode == Run.Mode.LIVE and request.data.get("recording"):
            run.enable_recording()
        else:
            # Start without recording clears a stale token from a resumed run.
            run.disable_recording()
    broadcast(question_set.room)
    return Response(
        {
            "run": run.pk,
            "room_code": question_set.room.code,
            "recording_token": run.recording_token,
        }
    )


VALID_PHASES = {p.value for p in Run.Phase}


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def control_run(request, run_id):
    """Presenter phase machine: {"phase": …, "question": id|null}."""
    run = get_object_or_404(
        Run.objects.select_related("question_set__room"), pk=run_id
    )
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    if not run.is_active:
        return Response({"detail": "Run is finished."}, status=409)

    # Leave without ending (✕/Esc in the presenter): close an open vote and
    # mark the presenter away so participant devices show „paused". The run
    # stays unfinished — it is ended from the set overview, or resumed by
    # presenting again.
    if request.data.get("away"):
        run.presenter_away = True
        fields = ["presenter_away", "updated_at"]
        if run.phase == Run.Phase.OPEN and run.mode == Run.Mode.LIVE:
            run.phase = Run.Phase.CLOSED
            fields.append("phase")
        run.save(update_fields=fields)
        broadcast(room)
        return Response({"status": "ok", "phase": run.phase})
    # Any other (valid) presenter action means the presenter is back — cleared
    # below only once the request passed validation, and saved + broadcast
    # together with the action itself.
    # Reveal correct answers (v2): server state so participant devices
    # highlight in sync with the beamer (presenter key "A").
    if "reveal" in request.data:
        run.answers_revealed = bool(request.data["reveal"])
        run.presenter_away = False
        run.save(update_fields=["answers_revealed", "presenter_away", "updated_at"])
        broadcast(room)
        return Response({"status": "ok", "phase": run.phase})

    # Recording mode (#53): turn the current run into a recorded one so the
    # beamer shows per-question deep links; live only (self-paced is already
    # async). Mints a token once; broadcast carries it to the beamer.
    if request.data.get("recording") and run.mode == Run.Mode.LIVE:
        if run.presenter_away:
            run.presenter_away = False
            run.save(update_fields=["presenter_away", "updated_at"])
        run.enable_recording()
        broadcast(room)
        return Response({"status": "ok", "recording_token": run.recording_token})

    phase = request.data.get("phase")
    if phase not in VALID_PHASES:
        return Response({"detail": "Invalid phase."}, status=400)

    if "question" in request.data:
        question_id = request.data["question"]
        if question_id is None:
            run.active_question = None
        else:
            run.active_question = get_object_or_404(
                Question, pk=question_id, question_set=run.question_set
            )

    needs_question = phase in {
        Run.Phase.PREVIEW, Run.Phase.OPEN, Run.Phase.CLOSED, Run.Phase.RESULTS
    }
    if needs_question and run.active_question is None:
        return Response({"detail": "No active question."}, status=400)

    run.phase = phase
    run.presenter_away = False
    if phase == Run.Phase.OPEN:
        run.opened_at = timezone.now()
        if run.first_opened_at is None:
            run.first_opened_at = run.opened_at
    if phase in (Run.Phase.PREVIEW, Run.Phase.OPEN):
        run.answers_revealed = False
    if phase == Run.Phase.FINISHED:
        run.ended_at = timezone.now()
    run.save()
    # Eager AI word-cloud (#75): start computing as soon as the vote closes so
    # the presenter can switch to the AI views instantly (kept warm afterwards).
    if phase in (Run.Phase.CLOSED, Run.Phase.RESULTS):
        q = run.active_question
        if q and q.kind in Question.TEXT_KINDS and q.wordcloud_ai_enabled:
            ai_wordcloud_live.ensure_result(run.pk, q.pk, room.pk)
    broadcast(room)
    return Response({"status": "ok", "phase": run.phase})


# --- results (management view, M3) -------------------------------------------


def _plain(html):
    """Strip all markup (CSV/plain-text rendering of question texts)."""
    return " ".join(nh3.clean(html or "", tags=set()).split())


def _owned_question_set(user, set_id):
    question_set = get_object_or_404(
        QuestionSet.objects.select_related("room"), pk=set_id
    )
    if not _require_owner(user, question_set.room):
        raise Http404
    return question_set


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def set_results(request, set_id):
    """All runs of a set with per-question aggregations (concept §7)."""
    question_set = _owned_question_set(request.user, set_id)
    # Skip runs without any votes (e.g. a freshly prepared archive run, #27):
    # a Durchführung is only worth listing once it collected answers.
    runs = (
        question_set.runs.filter(mindmap.answered_runs_q())
        .order_by("-created_at")
    )
    return Response({"results": [run_results(run) for run in runs]})


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def delete_run(request, run_id):
    """Delete one run including its votes (concept §7)."""
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    if not _require_owner(request.user, run.question_set.room):
        raise Http404
    room = run.question_set.room
    run.delete()
    broadcast(room)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def wordcloud_moderation(request, run_id, question_id):
    """Presenter curation of a word cloud (#Wortwolke): hide/unhide a term,
    merge/unmerge terms, rename a merge. Reversible overlay; votes untouched."""
    run = get_object_or_404(
        Run.objects.select_related("question_set__room"), pk=run_id
    )
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set
    )
    op = request.data.get("op")
    keys = [str(k) for k in (request.data.get("keys") or [])]
    label = request.data.get("label")
    mod, _ = WordCloudModeration.objects.get_or_create(run=run, question=question)
    if op == "hide":
        mod.hidden = sorted(set(mod.hidden) | set(keys))
    elif op == "unhide":
        mod.hidden = [k for k in mod.hidden if k not in set(keys)]
    elif op == "merge":
        # Dissolve any existing merge that overlaps these keys, then regroup all.
        keyset = set(keys)
        remaining = []
        for m in mod.merges:
            if keyset & set(m.get("keys", [])):
                keyset |= set(m["keys"])
            else:
                remaining.append(m)
        remaining.append({"keys": sorted(keyset), "label": str(label or "")})
        mod.merges = remaining
    elif op == "unmerge":
        keyset = set(keys)
        mod.merges = [m for m in mod.merges if set(m.get("keys", [])) != keyset]
    elif op == "rename":
        keyset = set(keys)
        for m in mod.merges:
            if set(m.get("keys", [])) == keyset:
                m["label"] = str(label or "")
    else:
        return Response({"detail": "Unknown op."}, status=400)
    mod.save()
    # Moderated terms feed the AI views too — refresh a shown/warm AI result
    # (no-op when AI is off or never computed for this word cloud).
    ai_wordcloud_live.refresh(run.pk, question.pk, room.pk)
    broadcast(room)
    return Response({"status": "ok"})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_hide(request, run_id, question_id):
    """Presenter moderation (expert mode): hide/unhide a mind-map node and,
    implicitly, its subtree — for everyone. Reversible; nothing is deleted."""
    run = get_object_or_404(
        Run.objects.select_related("question_set__room"), pk=run_id
    )
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set,
        kind=Question.Kind.MINDMAP,
    )
    hidden = request.data.get("hidden")
    if not isinstance(hidden, bool):
        return Response({"detail": "hidden must be true or false."}, status=400)
    node = mindmap._parse_id(request.data.get("node"))
    if node is None or not mindmap.set_hidden(run, question, node, hidden):
        raise Http404
    broadcast(room)
    # Echo for the beamer's undo stack (inverse = the same call with !hidden).
    return Response({"status": "ok", "node": node, "hidden": hidden})


def _mindmap_moderation(request, run_id, question_id):
    """(run, room, question) for the owner-only moderation endpoints; 404
    for anyone else and for non-mindmap questions."""
    run = get_object_or_404(
        Run.objects.select_related("question_set__room"), pk=run_id
    )
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set,
        kind=Question.Kind.MINDMAP,
    )
    return run, room, question


class _BadField(Exception):
    pass


def _strict_id(data, field, *, nullable=False):
    """A JSON integer node id (``null`` only when ``nullable``); the field
    must be present. Strings and booleans are refused."""
    if field not in data:
        raise _BadField(f"{field} is required.")
    value = data[field]
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise _BadField(f"{field} must be a node id.")
    return value


def _strict_str(data, field, *, required=True):
    value = data.get(field, None if required else "")
    if not isinstance(value, str):
        raise _BadField(f"{field} must be text.")
    return value


def _mindmap_moderate(request, run_id, question_id, action, status=200):
    """Shared shell: ownership, strict-type and MindmapError mapping, then a
    broadcast after the change. ``action`` returns the body, or
    ``(body, status)`` to override ``status``."""
    run, room, question = _mindmap_moderation(request, run_id, question_id)
    if not isinstance(request.data, dict):
        return Response({"detail": "Invalid request."}, status=400)
    try:
        body = action(run, question, request.data)
    except _BadField as error:
        return Response({"detail": str(error)}, status=400)
    except mindmap.MindmapError as error:
        return Response(error.body(), status=error.status)
    if isinstance(body, tuple):
        body, status = body
    broadcast(room)
    return Response(body, status=status)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_stage(request, run_id, question_id):
    """Presenter: ``{stage: "collect"|"rate", open?: bool}`` → 200
    ``{stage, phase}``. "rate" needs a rating mode on the question (409
    otherwise); 409 for a finished run. Without ``open`` the run phase stays
    as it is; ``open: true`` also makes the question active and opens the
    vote (timer reset) in the same request — one broadcast, no intermediate
    state on the beamer."""

    def action(run, question, data):
        stage = data.get("stage")
        if not isinstance(stage, str):
            raise _BadField("stage must be \"collect\" or \"rate\".")
        open_vote = data.get("open", False)
        if not isinstance(open_vote, bool):
            raise _BadField("open must be true or false.")
        stage = mindmap_rating.set_stage(run, question, stage, open_vote=open_vote)
        return {"stage": stage, "phase": run.phase}

    return _mindmap_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_teacher_add(request, run_id, question_id):
    """Presenter adds a term: ``{parent: id|null, text, description?}`` →
    201 ``{node_id, merged: false}`` (new) or 200 ``{node_id, merged: true}``
    (the term already existed there, visible); 409 ``{detail, conflict,
    hidden: true}`` when it exists but is hidden."""

    def action(run, question, data):
        parent = _strict_id(data, "parent", nullable=True)
        text = _strict_str(data, "text")
        description = _strict_str(data, "description", required=False)
        node, merged = mindmap.teacher_add(run, question, parent, text, description)
        return {"node_id": node.pk, "merged": merged}, 200 if merged else 201

    return _mindmap_moderate(request, run_id, question_id, action, status=201)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_teacher_delete(request, run_id, question_id):
    """Undo of a presenter's add: ``{node}`` → 200 ``{status: "ok"}``."""

    def action(run, question, data):
        mindmap.teacher_delete(run, question, _strict_id(data, "node"))
        return {"status": "ok"}

    return _mindmap_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_merge(request, run_id, question_id):
    """``{source, target}`` → 200 ``{undo: "<signed>"}``."""

    def action(run, question, data):
        source = _strict_id(data, "source")
        target = _strict_id(data, "target")
        return {"undo": mindmap.merge_nodes(run, question, source, target)}

    return _mindmap_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_unmerge(request, run_id, question_id):
    """Undo a merge or rename: ``{undo: "<signed>"}`` → 200 ``{status: "ok"}``
    or 409 ``{detail}`` when the map changed in between."""

    def action(run, question, data):
        mindmap.restore(run, question, data.get("undo"))
        return {"status": "ok"}

    return _mindmap_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_move(request, run_id, question_id):
    """``{node, parent: id|null}`` → 200 ``{undo: {node, parent}}``."""

    def action(run, question, data):
        node = _strict_id(data, "node")
        parent = _strict_id(data, "parent", nullable=True)
        return {"undo": mindmap.move_node(run, question, node, parent)}

    return _mindmap_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_rename(request, run_id, question_id):
    """``{node, text}`` → 200 ``{node_id, merged, undo: "<signed>"}``."""

    def action(run, question, data):
        node = _strict_id(data, "node")
        text = _strict_str(data, "text")
        node_id, merged, undo = mindmap.rename_node(run, question, node, text)
        return {"node_id": node_id, "merged": merged, "undo": undo}

    return _mindmap_moderate(request, run_id, question_id, action)


MINDMAP_AI_FLAGS = ("merge", "translate", "restructure")


def _mindmap_ai_overrides(data):
    """Validated ``{field: value}`` of the optional settings overrides in an
    ai-optimize body (``merge``/``translate``/``restructure`` booleans,
    ``target_lang`` a content language code or "")."""
    updates = {}
    for key in MINDMAP_AI_FLAGS:
        if key in data:
            if not isinstance(data[key], bool):
                raise _BadField(f"{key} must be true or false.")
            updates[f"mindmap_ai_{key}"] = data[key]
    if "target_lang" in data:
        lang = data["target_lang"]
        if not isinstance(lang, str) or lang not in ("", *(c for c, _ in settings.LANGUAGES)):
            raise _BadField("target_lang must be a content language.")
        updates["mindmap_ai_target_lang"] = lang
    return updates


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_ai_optimize(request, run_id, question_id):
    """Presenter (expert mode): ask the LLM for an optimisation proposal of
    the live mind map. Body: optional settings overrides ``{merge?,
    translate?, target_lang?, restructure?}`` — saved on the question. →
    200 ``{ops, dropped, preview, active, proposal, settings}`` (see
    ``mindmap.simulate_ops``; ``proposal`` = signed ops for ai-preview/
    ai-apply, 24 h). Nothing in the map changes. 503 AI not configured,
    400 AI switch off / nothing selected / fewer than 3 visible terms,
    409 rating stage, 502 AI error."""
    run, room, question = _mindmap_moderation(request, run_id, question_id)
    data = request.data
    if not isinstance(data, dict):
        return Response({"detail": "Invalid request."}, status=400)
    try:
        updates = _mindmap_ai_overrides(data)
    except _BadField as error:
        return Response({"detail": str(error)}, status=400)
    if not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=503)
    if not question.wordcloud_ai_enabled:
        return Response(
            {"detail": "KI-Funktionen sind für diese Frage nicht aktiviert."}, status=400
        )
    changed = [f for f, v in updates.items() if v != getattr(question, f)]
    for field in changed:
        setattr(question, field, updates[field])
    options = mindmap.ai_settings(question)
    if not any(options[key] for key in MINDMAP_AI_FLAGS):
        return Response({"detail": "Select at least one optimisation."}, status=400)
    if mindmap.is_rating(run, question):
        return Response({"detail": mindmap.MODERATION_WHILE_RATING}, status=409)
    mindmap.ensure_seed(run, question)
    tree = mindmap.build_tree(run, question, presenter=True)
    if len(ai_mindmap.visible_nodes(tree)) < 3:
        return Response({"detail": "At least 3 terms are needed."}, status=400)
    if changed:
        question.save(update_fields=changed)
        broadcast(room)  # presenter payload carries the settings
    system, user = ai_mindmap.build_prompt(tree, question, options)
    try:
        reply = ai.chat_json(system, user)
    except ai.AIError as exc:
        return Response({"detail": f"KI-Fehler: {exc}"}, status=502)
    ops = ai_mindmap.parse_ops(reply)
    malformed = ai_mindmap.raw_count(reply) - len(ops)
    result = mindmap.simulate_ops(run, question, ops, options)
    result["dropped"] += malformed
    result["proposal"] = mindmap.sign_proposal(run, question, ops, options, malformed)
    result["settings"] = options
    return Response(result)


def _strict_indices(data):
    selected = data.get("selected")
    if not isinstance(selected, list) or len(selected) > mindmap.AI_OPS_MAX or not all(
        isinstance(i, int) and not isinstance(i, bool) for i in selected
    ):
        raise _BadField("selected must be a list of proposal indices.")
    return selected


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_ai_preview(request, run_id, question_id):
    """Re-simulate a proposal for a selection (no LLM call, no change):
    ``{proposal, selected: [index]}`` → 200 ``{ops, dropped, preview,
    active}`` (same shapes as ai-optimize)."""
    run, _room, question = _mindmap_moderation(request, run_id, question_id)
    data = request.data
    if not isinstance(data, dict):
        return Response({"detail": "Invalid request."}, status=400)
    try:
        selected = _strict_indices(data)
        ops, options, malformed = mindmap.unsign_proposal(run, question, data.get("proposal"))
    except _BadField as error:
        return Response({"detail": str(error)}, status=400)
    except mindmap.MindmapError as error:
        return Response(error.body(), status=error.status)
    result = mindmap.simulate_ops(run, question, ops, options, selected)
    result["dropped"] += malformed
    return Response(result)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_ai_apply(request, run_id, question_id):
    """Apply the selected ops of a proposal as one batch: ``{proposal,
    selected: [index]}`` → 200 ``{applied, skipped, undo: [{type, data}]}``
    (``skipped`` = selected ops that no longer fit the map). One broadcast."""

    def action(run, question, data):
        selected = _strict_indices(data)
        ops, options, _malformed = mindmap.unsign_proposal(run, question, data.get("proposal"))
        if any(not 0 <= index < len(ops) for index in selected):
            raise _BadField("selected must be a list of proposal indices.")
        return mindmap.apply_ops(run, question, ops, options, selected)

    return _mindmap_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mindmap_ai_undo(request, run_id, question_id):
    """Undo an applied batch: ``{undo: [{type, data}]}`` (from ai-apply) →
    200 ``{status: "ok"}``; 409 ``{detail}`` (nothing changed) when the map
    changed in a way that makes exact restoration impossible."""

    def action(run, question, data):
        mindmap.undo_ops(run, question, data.get("undo"))
        return {"status": "ok"}

    return _mindmap_moderate(request, run_id, question_id, action)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def optimize_wordcloud(request, run_id, question_id):
    """Optional AI cleanup of a word-cloud result: merge spelling variants
    and synonyms, group into thematic clusters. Non-destructive — the raw
    votes are untouched; counts are recomputed server-side."""
    if not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=503)
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    if not _require_owner(request.user, run.question_set.room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set
    )
    if question.kind != Question.Kind.WORD_CLOUD:
        return Response({"detail": "Nur für Wortwolken verfügbar."}, status=400)
    words = words_with_counts(run, question, limit=200)
    if not words:
        return Response({"clusters": [], "merged": []})
    try:
        data = ai.chat_json(
            ai_wordcloud.optimize_system(
                question.wordcloud_grouping, **ai_wordcloud.merge_flags(question)
            ),
            ai_wordcloud.build_optimize_prompt(words),
        )
    except ai.AIError as exc:
        return Response({"detail": f"KI-Fehler: {exc}"}, status=502)
    return Response(ai_wordcloud.apply_optimization(words, data))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def freetext_summary(request, run_id, question_id):
    """One-shot AI key statements (+ grouping) of a free-text question for
    the Quiz-Block walkthrough of a finished run. Same ``{merged, clusters}``
    shape as the live presenter result; uses the question's settings
    (``wordcloud_merge_concepts``, ``wordcloud_grouping``) and the run's
    moderation overlay. Non-destructive and not cached server-side."""
    if not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=503)
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    if not _require_owner(request.user, run.question_set.room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set
    )
    if question.kind != Question.Kind.OPEN_TEXT:
        return Response({"detail": "Nur für Freitext-Fragen verfügbar."}, status=400)
    if not question.wordcloud_ai_enabled:
        return Response(
            {"detail": "KI-Zusammenfassung ist für diese Frage nicht aktiviert."},
            status=400,
        )
    words = words_with_counts(run, question, limit=ai_freetext_summary.INPUT_MAX)
    if not words:
        return Response({"merged": [], "clusters": []})
    try:
        result = ai_freetext_summary.summarize(
            words,
            grouping=question.wordcloud_grouping,
            merge_similar=question.wordcloud_merge_concepts,
            context=ai_freetext_summary.question_context(question),
            chat_json=ai.chat_json,
        )
    except ai.AIError as exc:
        return Response({"detail": f"KI-Fehler: {exc}"}, status=502)
    return Response({"merged": result["merged"], "clusters": result["clusters"]})


WORDCLOUD_GROUPING_MAX = 1000
# Body keys of the ai-settings endpoint; the Question field is wordcloud_<key>.
MERGE_FLAG_KEYS = ("merge_variants", "merge_synonyms", "merge_concepts")
# Further boolean body keys (Question field wordcloud_<key>) that change the
# AI result: free text — send the model solution with the question context.
AI_FLAG_KEYS = (*MERGE_FLAG_KEYS, "grouping_use_solution")


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def wordcloud_ai_settings(request, run_id, question_id):
    """Presenter edits a word cloud's (or free-text question's — key
    statements; ``merge_concepts`` = also merge similar statements) permanent
    AI settings: switch the AI
    views on/off, change the grouping instruction and/or what the
    consolidated view merges. Body: {"ai_enabled"?: bool, "grouping"?: str,
    "merge_variants"?: bool, "merge_synonyms"?: bool, "merge_concepts"?:
    bool, "grouping_use_solution"?: bool, "regroup"?: bool}. Saved on the question; a changed instruction or
    merge flag (or ``regroup: true``) recomputes a shown/warm AI result."""
    run = get_object_or_404(
        Run.objects.select_related("question_set__room"), pk=run_id
    )
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    question = get_object_or_404(
        Question,
        pk=question_id,
        question_set=run.question_set,
        kind__in=Question.TEXT_KINDS,  # word cloud or free text (key statements)
    )
    # Validate every input before any side effect (save, live loop, refresh,
    # broadcast): a 400/409 leaves the question and the live state unchanged.
    data = request.data
    enabled = None
    if "ai_enabled" in data:
        enabled = data.get("ai_enabled")
        if not isinstance(enabled, bool):
            return Response({"detail": "ai_enabled must be a boolean."}, status=400)
    grouping = None
    if "grouping" in data:
        grouping = str(data.get("grouping") or "").strip()
        if (
            len(grouping) > WORDCLOUD_GROUPING_MAX
            and grouping != question.wordcloud_grouping
        ):
            return Response(
                {"detail": f"Anweisung zu lang (max. {WORDCLOUD_GROUPING_MAX} Zeichen)."},
                status=400,
            )
    merge_updates = {}
    for key in AI_FLAG_KEYS:
        if key in data:
            value = data.get(key)
            if not isinstance(value, bool):
                return Response({"detail": f"{key} must be a boolean."}, status=400)
            merge_updates[key] = value
    if enabled and not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=409)

    fields = []
    settings_changed = False
    if enabled is not None:
        if enabled != question.wordcloud_ai_enabled:
            question.wordcloud_ai_enabled = enabled
            fields.append("wordcloud_ai_enabled")
        if not enabled:
            # Stop the live recompute so new votes no longer trigger LLM calls.
            ai_wordcloud_live.set_active(run.pk, question.pk, room.pk, False)
    if grouping is not None and grouping != question.wordcloud_grouping:
        question.wordcloud_grouping = grouping
        fields.append("wordcloud_grouping")
        settings_changed = True
    for key, value in merge_updates.items():
        field = f"wordcloud_{key}"
        if value != getattr(question, field):
            setattr(question, field, value)
            fields.append(field)
            settings_changed = True
    if fields:
        question.save(update_fields=fields)
    # Taken after the save and before the recompute is triggered: the next AI
    # result with a higher ``seq`` reflects these settings (the presenter's
    # busy state ends on it, even if the content comes out identical).
    ai_seq = ai_wordcloud_live.current_seq()
    if settings_changed or data.get("regroup") is True:
        # A shown/warm AI result was built with the old instruction/flags.
        ai_wordcloud_live.refresh(run.pk, question.pk, room.pk)
    broadcast(room)
    response = {
        "ai_enabled": question.wordcloud_ai_enabled,
        "grouping": question.wordcloud_grouping,
        "ai_seq": ai_seq,
    }
    for key in AI_FLAG_KEYS:
        response[key] = getattr(question, f"wordcloud_{key}")
    return Response(response)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def wordcloud_ai(request, run_id):
    """Presenter toggles the live AI word-cloud view on/off for a question.

    Body: {"question": <id>, "active": bool}. While active, the LLM keeps the
    consolidated + grouped views fresh (throttled); turning it off frees the
    in-memory result. Only for word-cloud and free-text questions of this run
    (free text: AI key statements + grouping)."""
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    room = run.question_set.room
    if not _require_owner(request.user, room):
        raise Http404
    question = get_object_or_404(
        Question, pk=request.data.get("question"), question_set=run.question_set
    )
    active = bool(request.data.get("active"))
    if not active:
        # Deactivation is always allowed (also after AI was switched off).
        ai_wordcloud_live.set_active(run.pk, question.pk, room.pk, False)
        return Response({"status": "ok", "active": False})
    if question.kind not in Question.TEXT_KINDS or not question.wordcloud_ai_enabled:
        return Response(
            {"detail": "KI-Aufräumen ist für diese Frage nicht aktiviert."},
            status=400,
        )
    if not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=503)
    ai_wordcloud_live.set_active(run.pk, question.pk, room.pk, True)
    return Response({"status": "ok", "active": True})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def evaluate_freetext(request, run_id, question_id):
    """Optional AI evaluation of free-text answers: classify each distinct
    answer as korrekt / unklar / falsch. Non-destructive; counts are
    recomputed server-side. An optional ``reference`` (expected answer or
    criterion) sharpens the judgement."""
    if not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=503)
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    if not _require_owner(request.user, run.question_set.room):
        raise Http404
    question = get_object_or_404(
        Question, pk=question_id, question_set=run.question_set
    )
    if question.kind != Question.Kind.OPEN_TEXT:
        return Response({"detail": "Nur für Freitext-Fragen verfügbar."}, status=400)
    categories = question.evaluation_categories
    answers = words_with_counts(run, question, limit=200)
    if not answers:
        return Response(
            {"groups": [], "categories": ai_freetext.clean_categories(categories),
             "chart": question.evaluation_chart}
        )
    reference = str(request.data.get("reference") or "").strip()[
        : ai_freetext.REFERENCE_MAX
    ]
    try:
        data = ai.chat_json(
            ai_freetext.evaluate_system(categories),
            ai_freetext.build_evaluate_prompt(
                # Canonical text for the LLM (#33 MR2): the model works on
                # one language, not the {de, en} map.
                resolve_translated_text(translated_map(question, "text")),
                reference, answers, categories,
            ),
        )
    except ai.AIError as exc:
        return Response({"detail": f"KI-Fehler: {exc}"}, status=502)
    result = ai_freetext.apply_evaluation(answers, data, categories)
    result["chart"] = question.evaluation_chart
    return Response(result)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def run_summary(request, run_id):
    """Optional AI short report of one run: a compact German Markdown
    summary of the (anonymous, already-aggregated) results. Display-only."""
    if not ai.is_enabled():
        return Response({"detail": "KI ist nicht konfiguriert."}, status=503)
    run = get_object_or_404(Run.objects.select_related("question_set__room"), pk=run_id)
    if not _require_owner(request.user, run.question_set.room):
        raise Http404
    results = run_results(run)
    if not results["votes_total"]:
        return Response({"detail": "Noch keine Antworten für einen Bericht."}, status=400)
    try:
        data = ai.chat_json(
            ai_report.report_system(),
            ai_report.build_report_prompt(
                # Canonical text for the LLM (#33 MR2), not the request's
                # active UI language.
                resolve_translated_text(translated_map(run.question_set, "title")),
                results,
            ),
        )
    except ai.AIError as exc:
        return Response({"detail": f"KI-Fehler: {exc}"}, status=502)
    report = str(data.get("report", "")).strip()[: ai_report.REPORT_MAX]
    if not report:
        return Response({"detail": "Kein Bericht erhalten."}, status=502)
    # Render the LLM's Markdown to sanitized HTML so the client shows it via
    # RichText like all other rich content (editor-unify #49).
    return Response({"report": render_markdown(report)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def delete_results(request, set_id):
    """Delete all runs (and votes) of a set."""
    question_set = _owned_question_set(request.user, set_id)
    question_set.runs.all().delete()
    broadcast(question_set.room)
    return Response({"status": "ok"})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def archive_results(request, set_id):
    """Archive the current results and prepare a fresh run (#27).

    A one-click shortcut for the presentation start dialog's "Archivieren &
    neu starten": the running (or most recent) Durchführung is finished and
    kept as an archive, and an empty run is prepared so the next presentation
    starts clean — without the presenter having to open the start dialog.
    Idempotent: if an empty run is already waiting, it is returned as-is.
    """
    question_set = _owned_question_set(request.user, set_id)
    active = (
        question_set.runs.exclude(phase=Run.Phase.FINISHED)
        .order_by("-created_at")
        .first()
    )
    # Finish a Durchführung only if it actually collected answers; an empty
    # unfinished run is already the "fresh" run we would create.
    if active is not None and mindmap.run_has_answers(active):
        active.phase = Run.Phase.FINISHED
        active.ended_at = timezone.now()
        active.save(update_fields=["phase", "ended_at", "updated_at"])
        active = None
    if active is None:
        active = Run.objects.create(
            question_set=question_set,
            mode=Run.Mode.LIVE,
            phase=Run.Phase.LOBBY,
        )
    broadcast(question_set.room)
    return Response({"run": active.pk})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def results_csv(request, set_id):
    """CSV export of all stored results of a set (concept §7).

    Semicolon-separated with a UTF-8 BOM so German Excel opens it directly.
    """
    question_set = _owned_question_set(request.user, set_id)
    # Optional ?run=<id>: export only that Durchführung, else the whole set
    # including archived runs (#17).
    runs = question_set.runs.order_by("created_at")
    run_id = request.query_params.get("run")
    if run_id:
        runs = runs.filter(pk=run_id)
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";")
    header = ["durchfuehrung", "gestartet", "frage_nr", "frage", "antwort", "richtig",
              "stimmen", "vor_ort", "aufzeichnung", "prozent", "bewertung",
              # Matrix cards only (empty for every other kind).
              "beschreibung", "kategorie", "zone", "x", "y", "stapel"]
    writer.writerow(header)
    raw_writerow = writer.writerow

    class _PaddedWriter:
        # Every row gets the full column count ("bewertung" only filled for
        # mind maps with a rating phase).
        @staticmethod
        def writerow(row):
            return raw_writerow(list(row) + [""] * (len(header) - len(row)))

    writer = _PaddedWriter()
    for run in runs:
        started = run.first_opened_at or run.created_at
        for question in run.question_set.questions.prefetch_related("options"):
            # CSV needs a plain string (#33 MR2): resolve the {de, en} map to
            # the canonical/active language rather than exporting a dict.
            question_text = resolve_translated_text(translated_map(question, "text"))
            base = [run.pk, started.strftime("%Y-%m-%d %H:%M"),
                    question.position + 1, _plain(question_text)]
            if question.kind == Question.Kind.MINDMAP:
                # One row per visible node: its path from the root's branch
                # ("Wind > Rotor") and its count in "stimmen"; with a rating
                # phase its score in "bewertung".
                tree = mindmap.build_tree(run, question, presenter=False)
                # Scores still secret (rating in progress, not revealed):
                # the column stays empty.
                hidden = mindmap_rating.scores_hidden(run, question)
                scores = (
                    mindmap_rating.aggregate(run, question)[0]
                    if question.mindmap_rating_mode and not hidden
                    else {}
                )
                for path, count, node_id in mindmap.csv_rows(tree):
                    cell = (
                        "" if hidden
                        else mindmap_rating.csv_cell(question, scores, node_id)
                    )
                    writer.writerow(
                        base + [csv_safe(path), "", count, "", "", "", csv_safe(cell)]
                    )
            elif question.kind == Question.Kind.MATRIX:
                # One row per visible card: title in "antwort", one vote each,
                # the card's details in the trailing matrix columns.
                hidden = matrix_rating.scores_hidden(run, question)
                scores = (
                    matrix_rating.aggregate(run, question)[0]
                    if question.matrix_rating_mode and not hidden
                    else {}
                )
                for card in matrix.csv_rows(run, question):
                    cell = (
                        "" if hidden or card["stack"]
                        else matrix_rating.csv_cell(question, scores, card["id"])
                    )
                    writer.writerow(
                        base
                        + [csv_safe(card["title"]), "", 1, "", "", "", csv_safe(cell)]
                        + [csv_safe(card[key]) for key in ("description", "category", "zone")]
                        + [card["x"], card["y"], csv_safe(card["stack"])]
                    )
            elif question.kind in Question.TEXT_KINDS:
                for word in words_with_counts(run, question, limit=100000):
                    writer.writerow(
                        base
                        + [csv_safe(word["text"]), "", word["count"],
                           word.get("onsite", ""), word.get("recording", ""), ""]
                    )
            elif question.kind == Question.Kind.PRIORITIES:
                # Fixed CSV schema: for priorities the stimmen/vor_ort/
                # aufzeichnung columns carry the average / min / max points.
                for option in priority_stats(run, question):
                    writer.writerow(
                        base
                        + [resolve_translated_text(option["text"]), "",
                           option["avg"], option["min"], option["max"], ""]
                    )
            elif question.kind == Question.Kind.ORDERING:
                # Fixed CSV schema: for ordering the "stimmen" column carries the
                # per-item correct-placement rate (%) and "prozent" the solution
                # position; a summary row carries the fully-correct rate.
                stats = ordering_stats(run, question)
                for item in stats["items"]:
                    writer.writerow(
                        base
                        + [resolve_translated_text(item["text"]), "",
                           item["correct_rate"], "", "", item["correct_position"]]
                    )
                writer.writerow(
                    base + ["Zusammenfassung: komplett richtig", "",
                            stats["full_correct_rate"], "", "", ""]
                )
            else:
                options = options_with_counts(run, question)
                summary = (
                    likert_summary(options)
                    if question.kind == Question.Kind.LIKERT
                    else None
                )
                # Per-step %s over the scale (excluding abstentions) for Likert.
                step_pct = {s["id"]: s["pct"] for s in summary["steps"]} if summary else {}
                for option in options:
                    writer.writerow(
                        base
                        + [resolve_translated_text(option["text"]),
                           "x" if option["is_correct"] else "",
                           option["count"], option.get("onsite", ""),
                           option.get("recording", ""),
                           step_pct.get(option["id"], "")]
                    )
                if summary:
                    high_label = resolve_translated_text(summary["high_label"]) or "hoch"
                    low_label = resolve_translated_text(summary["low_label"]) or "niedrig"
                    for label, count, pct in (
                        (f"Zusammenfassung: {high_label}", summary["high"], summary["high_pct"]),
                        ("Zusammenfassung: Neutral", summary["neutral"], summary["neutral_pct"]),
                        (f"Zusammenfassung: {low_label}", summary["low"], summary["low_pct"]),
                        ("Zusammenfassung: Enthaltung", summary["abstentions"], ""),
                    ):
                        writer.writerow(base + [label, "", count, "", "", pct])
    response = HttpResponse(
        "\ufeff" + buffer.getvalue(), content_type="text/csv; charset=utf-8"
    )
    response["Content-Disposition"] = (
        f'attachment; filename="abstimmbar-ergebnisse-{question_set.pk}.csv"'
    )
    return response


# --- SSE stream (the only async view; ADR-0003) ------------------------------


async def stream(request, code):
    # ORM access goes through sync_to_async, and the connection is returned
    # to the pool immediately: a stream lives for minutes — it must not keep
    # a pooled DB connection checked out while idle (request_finished, which
    # normally closes it, only fires once the stream ends).
    def _context():
        try:
            room = Room.objects.filter(code=code).first()
            is_owner = room is not None and _require_owner(request.user, room)
            return room, is_owner
        finally:
            connections.close_all()

    room, is_owner = await sync_to_async(_context)()
    if room is None:
        raise Http404

    role = "participant"
    if request.GET.get("role") == "presenter":
        if not is_owner:
            return JsonResponse({"detail": "Forbidden"}, status=403)
        role = "presenter"

    subscriber = hub.subscribe(room.pk, role)
    # Joining/leaving changes the participant counter on the beamer.
    if role == "participant":
        broadcast(room, debounce=True)

    def _initial():
        try:
            return build_payloads(room)
        finally:
            connections.close_all()

    async def events():
        try:
            initial = await sync_to_async(_initial)()
            yield sse_frame(initial[role])
            while True:
                try:
                    # Queue items are pre-serialized SSE frames (see hub).
                    yield await asyncio.wait_for(
                        subscriber.queue.get(), timeout=KEEPALIVE_SECONDS
                    )
                except TimeoutError:
                    # A named event (not a comment) so clients can see the
                    # stream is alive and reconnect when it goes quiet —
                    # e.g. after a phone slept (#180). `onmessage` ignores it.
                    yield KEEPALIVE_FRAME
        finally:
            hub.unsubscribe(room.pk, subscriber)
            if role == "participant":
                broadcast(room, debounce=True)

    response = StreamingHttpResponse(events(), content_type="text/event-stream")
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response
