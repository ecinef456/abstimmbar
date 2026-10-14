# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Builds the SSE state snapshots (ADR-0003: full snapshot per event).

Participant payloads contain only what participants may see (question
content once open, never results — device results are v2). Presenter
payloads add counters, per-option results and the word cloud.
"""
from datetime import timedelta

import nh3
from django.db.models import Count

from common.i18n_fields import translated_map
from rooms.models import Question

from . import ai_wordcloud_live, mindmap, mindmap_rating
from .hub import hub
from .models import Run, WordCloudModeration
from .results import (
    freetext_evaluation,
    likert_summary,
    options_with_counts,
    ordered_options,
    ordering_stats,
    priority_stats,
    words_with_counts,
)


def active_run(room):
    return (
        Run.objects.filter(question_set__room=room)
        .exclude(phase=Run.Phase.FINISHED)
        .select_related(
            "question_set", "active_question", "active_question__before_question"
        )
        .order_by("-created_at", "-id")
        .first()
    )


def question_payload(question, shuffle_seed):
    # Stable per-run shuffle: every device sees the same random order, and the
    # results tally reuses this order via the same helper (#127). Ordering (#72)
    # always shuffles so the correct order (option.position, never in the
    # payload) cannot be read off the option sequence.
    options = ordered_options(question, shuffle_seed)
    return {
        "id": question.pk,
        "kind": question.kind,
        # Authored content (#33 MR2): the SSE hub broadcasts one payload to
        # every participant, so text is a {de, en} map resolved client-side.
        "text": translated_map(question, "text"),
        "multiple": question.kind == Question.Kind.MULTIPLE_CHOICE,
        # Recording viewers run a per-question client countdown (#53); harmless
        # for other consumers.
        "time_limit": question.time_limit,
        # Word cloud: participant may submit several terms (+ „Fertig", #14).
        "allow_multiple": question.allow_multiple,
        # Word cloud: show the cloud on the beamer while open, or only once
        # the vote is closed (#30).
        "wordcloud_live": question.wordcloud_live,
        # Word cloud: AI cleanup/grouping views enabled for this question — the
        # presenter only offers the view toggle when this is on.
        "wordcloud_ai_enabled": question.wordcloud_ai_enabled,
        # Per-participant word-cloud cap (#76); the participant page stops input
        # at this many terms (0 = unlimited). Harmless for other kinds.
        "wordcloud_max_answers": question.wordcloud_max_answers,
        "wordcloud_batch_submit": question.wordcloud_batch_submit,
        # Live free-text AI feedback (participant-facing): tells the client
        # whether to poll my-evaluation for this question. False for every
        # non-open_text question.
        "participant_feedback": question.participant_feedback,
        "options": [
            {
                "id": o.pk,
                "text": translated_map(o, "text"),
                "is_abstention": o.is_abstention,
                **({"image": o.image} if o.image else {}),
            }
            for o in options
        ],
    }


def build_payloads(room):
    """Return {"participant": …, "presenter": …} snapshots for a room."""
    run = active_run(room)
    base = {
        "room": {
            "code": room.code,
            "title": translated_map(room, "title"),
            "show_logo": room.show_logo_in_presentation,
            "show_qr": room.show_qr_in_presentation,
            "show_code": room.show_code_in_presentation,
            "corner": room.presentation_corner,
        }
    }
    if run is None:
        # No active run: distinguish "ended" from "never started" so
        # participant devices show „beendet" after the presenter finishes.
        has_finished_run = Run.objects.filter(question_set__room=room).exists()
        base["phase"] = "finished" if has_finished_run else "idle"
        return {"participant": base, "presenter": base}
    base["phase"] = run.phase
    # Participant devices scope their "already voted" marker to the run, so a
    # fresh Durchführung (re-run/archive restart) lets them vote again.
    base["run_id"] = run.pk

    question_set = run.question_set
    base["set_title"] = translated_map(question_set, "title")

    if run.mode == Run.Mode.SELF_PACED:
        return _self_paced_payloads(room, run, base)

    question = run.active_question

    # Countdown (v2): both roles get the absolute deadline.
    ends_at = None
    if (
        question
        and run.phase == Run.Phase.OPEN
        and question.time_limit
        and run.opened_at
    ):
        ends_at = (run.opened_at + timedelta(seconds=question.time_limit)).isoformat()

    # Per-question reveal mode overrides the set default (#28).
    effective_reveal = question.effective_reveal if question else question_set.reveal_answers
    reveal_correct = effective_reveal == "immediately" or run.answers_revealed

    is_mindmap = question is not None and question.kind == Question.Kind.MINDMAP
    if is_mindmap:
        # Predefined branches belong to every run's tree from the start.
        mindmap.ensure_seed(run, question)

    participant = dict(base)
    # Presenter left without ending (✕/Esc): devices show „paused". Only on
    # an unfinished run — ``active_run`` never returns a finished one.
    if run.presenter_away:
        participant["paused"] = True
    if ends_at:
        participant["ends_at"] = ends_at
    if question and run.phase == Run.Phase.OPEN:
        participant["question"] = question_payload(question, shuffle_seed=run.pk)
    if is_mindmap and run.phase in (
        Run.Phase.OPEN, Run.Phase.CLOSED, Run.Phase.RESULTS
    ):
        # The shared tree stays readable on devices after closing (read-only
        # outside "open"); hidden nodes are left out entirely.
        participant["question"] = question_payload(question, shuffle_seed=run.pk)
        participant["mindmap"] = mindmap.build_tree(run, question, presenter=False)
        rating = mindmap_rating.payload(run, question, presenter=False)
        if rating is not None:
            participant["mindmap"]["rating"] = rating
    # Results on participant devices (v2, per-set option): only while the
    # beamer shows results, correct flags only once revealed.
    if (
        question
        and not is_mindmap
        and run.phase == Run.Phase.RESULTS
        and question_set.show_results_to_participants
    ):
        participant["question"] = {
            "id": question.pk,
            "kind": question.kind,
            "text": translated_map(question, "text"),
        }
        if question.kind in Question.TEXT_KINDS:
            participant["words"] = words_with_counts(run, question)
        elif question.kind == Question.Kind.PRIORITIES:
            participant["priorities"] = priority_stats(run, question)
        elif question.kind == Question.Kind.ORDERING:
            participant["ordering"] = ordering_stats(run, question)
        else:
            participant_options = options_with_counts(run, question)
            participant["results"] = [
                {
                    "id": option["id"],
                    "text": option["text"],
                    "count": option["count"],
                    **({"is_correct": option["is_correct"]} if reveal_correct else {}),
                }
                for option in participant_options
            ]
            # #86: participants see the same diverging Likert bar as the beamer,
            # with their own vote marked.
            if question.kind == Question.Kind.LIKERT:
                participant["likert"] = likert_summary(participant_options)

    presenter = dict(base)
    presenter["run_id"] = run.pk
    # Recording mode (#53): present the per-question deep link on the beamer.
    if run.recording_token:
        presenter["recording_token"] = run.recording_token
    presenter["reveal_answers"] = effective_reveal
    presenter["revealed"] = run.answers_revealed
    presenter["participants"] = hub.participant_count(room.pk)
    if ends_at:
        presenter["ends_at"] = ends_at
    if question:
        presenter["question"] = question_payload(question, shuffle_seed=run.pk)
        # Presenter-only (not in the participant payload): the AI grouping
        # instruction shown/edited in the word-cloud AI panel.
        presenter["question"]["wordcloud_grouping"] = question.wordcloud_grouping
        presenter["question"]["wordcloud_grouping_use_solution"] = (
            question.wordcloud_grouping_use_solution
        )
        if question.kind == Question.Kind.OPEN_TEXT:
            # Presenter-only, never in the participant payload: the AI panel
            # offers it collapsed („Musterlösung anzeigen").
            presenter["question"]["model_solution"] = question.model_solution
        for flag in ("variants", "synonyms", "concepts"):
            field = f"wordcloud_merge_{flag}"
            presenter["question"][field] = getattr(question, field)
        presenter["votes"] = run.votes.filter(question=question).count()
        if is_mindmap:
            # Every node incl. hidden ones (flagged) for the restore drawer.
            presenter["mindmap"] = mindmap.build_tree(run, question, presenter=True)
            rating = mindmap_rating.payload(run, question, presenter=True)
            if rating is not None:
                presenter["mindmap"]["rating"] = rating
            # "votes" of a mind map = distinct contributing participants.
            presenter["votes"] = mindmap.contributor_count(run, question)
            # Presenter-only: the AI optimisation settings (beamer star panel).
            presenter["question"]["mindmap_ai"] = mindmap.ai_settings(question)
        elif question.kind in Question.TEXT_KINDS:
            presenter["words"] = words_with_counts(run, question)
            mod = WordCloudModeration.objects.filter(run=run, question=question).first()
            presenter["wordcloud_moderation"] = {
                "hidden": [{"key": k} for k in (mod.hidden if mod else [])],
                "merges": (mod.merges if mod else []),
            }
            if question.kind == Question.Kind.OPEN_TEXT and question.ai_evaluate:
                presenter["evaluation"] = freetext_evaluation(run, question)
            # Live AI views (word cloud: consolidated/grouped; free text: key
            # statements/grouped), once computed (active or kept warm).
            ai_view = ai_wordcloud_live.get_result(run.pk, question.pk)
            if ai_view is not None:
                presenter["wordcloud_ai"] = ai_view
        elif question.kind == Question.Kind.PRIORITIES:
            presenter["priorities"] = priority_stats(run, question)
        elif question.kind == Question.Kind.ORDERING:
            presenter["ordering"] = ordering_stats(run, question)
        else:
            presenter["results"] = options_with_counts(run, question)
            if question.kind == Question.Kind.LIKERT:
                presenter["likert"] = likert_summary(presenter["results"])
            # Vorher-Nachher-Paar (#54): for an after-question, attach the
            # before-question's aggregates from the SAME run so the beamer can
            # show the comparison (before over after). Options are mirrored, so
            # they pair by position.
            if question.before_question_id:
                before_q = question.before_question
                before_results = options_with_counts(run, before_q)
                before = {
                    "votes": run.votes.filter(question=before_q).count(),
                    "results": before_results,
                }
                if before_q.kind == Question.Kind.LIKERT:
                    before["likert"] = likert_summary(before_results)
                presenter["before"] = before
    return {"participant": participant, "presenter": presenter}


def _self_paced_payloads(room, run, base):
    """Self-paced quiz (concept §6.3): participants drive themselves, so
    their snapshot only signals "quiz open" — the questions come from the
    quiz endpoint, and vote broadcasts must not disturb quiz progress.
    Presenters get a per-question progress list for the dashboard."""
    base = dict(base, mode=run.mode)
    ends_at = run.quiz_ends_at.isoformat() if run.quiz_ends_at else None
    participant = dict(base)
    participant["ends_at"] = ends_at

    presenter = dict(base)
    presenter["run_id"] = run.pk
    presenter["ends_at"] = ends_at
    presenter["participants"] = hub.participant_count(room.pk)
    counts = dict(
        run.votes.values_list("question").annotate(n=Count("id"))
    )
    presenter["progress"] = [
        {
            "id": question.pk,
            # Plain text per language is enough for a progress row; the
            # client resolves the map like every other authored text (#33).
            "text": {
                lang: " ".join(nh3.clean(value, tags=set()).split())
                for lang, value in translated_map(question, "text").items()
            },
            "votes": counts.get(question.pk, 0),
        }
        for question in run.question_set.questions.all()
    ]
    presenter["votes_total"] = sum(counts.values())
    return {"participant": participant, "presenter": presenter}


def broadcast(room, debounce=False):
    def _build():
        # Runs in the hub's executor thread: give the pooled connection back
        # right away instead of parking it on a long-lived thread.
        from django.db import connections

        try:
            return build_payloads(room)
        finally:
            connections.close_all()

    hub.broadcast_threadsafe(room.pk, _build, debounce=debounce)
