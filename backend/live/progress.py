# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""``presenter["progress"]`` of the SSE snapshot: the beamer's bottom-left
progress pill (answered participants, items against the capacity).

Shape (additive, presenter only)::

    {"answered": int,          # distinct participants with >= 1 answer /
                               # term / card / rating
     "items": int | None,      # terms, cards, points or ratings given
     "per_person": int | None, # per-participant limit (None = none/unlimited)
     "unit": "answers" | "terms" | "cards" | "points" | "ratings"}

``items`` = quota used, because the pill shows how much of the capacity
(participants x per_person) is consumed:

* mind map: participants' contributions to visible terms (two people adding
  the same term count twice; contributions to seeded/presenter terms count);
* word cloud (multiple answers): raw Vote rows — terms hidden by the word-cloud
  moderation still used the participant's quota;
* matrix: visible participant cards (stacked members included);
* rating stage: points given (points) / non-zero ratings (plus/minus) on
  visible entries, against the rating budget.

The frontend computes the capacity (``max(participants, answered) *
per_person``) and clamps the share; ``items`` is never clamped here.
"""
from rooms.mindmap import RATING_UPDOWN
from rooms.models import Question

from . import matrix, matrix_rating, mindmap, mindmap_rating
from .models import MatrixPhase, MindmapPhase


def _block(answered, items=None, per_person=None, unit="answers"):
    return {"answered": answered, "items": items, "per_person": per_person, "unit": unit}


def _limit(value):
    return value or None  # 0 = unlimited


def _board(run, question, rating, prefix, rate_stage, count_items, unit):
    """Mind map / matrix: collecting counts the participants' terms/cards
    against ``*_max_per_person``; the rating stage counts points/ratings
    given against the rating budget. ``answered`` = contributors ∪ raters."""
    if rating.stage_of(run, question) == rate_stage:
        visible = rating._visible_ids(run, question)
        scores, _raters = rating.aggregate(run, question, visible)
        updown = getattr(question, f"{prefix}_rating_mode") == RATING_UPDOWN
        return _block(
            rating.answered_count(run, question, visible),
            rating.given_count(question, scores),
            getattr(question, f"{prefix}_rating_budget"),
            "ratings" if updown else "points",
        )
    return _block(
        rating.answered_count(run, question),
        count_items(run, question),
        _limit(getattr(question, f"{prefix}_max_per_person")),
        unit,
    )


def progress_payload(run, question):
    """The ``progress`` block of the presenter snapshot for ``question``."""
    kind = question.kind
    if kind == Question.Kind.MINDMAP:
        return _board(
            run, question, mindmap_rating, "mindmap", MindmapPhase.Stage.RATE,
            mindmap.participant_contribution_count, "terms",
        )
    if kind == Question.Kind.MATRIX:
        return _board(
            run, question, matrix_rating, "matrix", MatrixPhase.Stage.RATE,
            matrix.participant_card_count, "cards",
        )
    votes = run.votes.filter(question=question)
    answered = votes.values("token").distinct().count()
    if kind == Question.Kind.WORD_CLOUD and question.allow_multiple:
        # Raw Vote rows: moderation-hidden terms still used the quota.
        return _block(
            answered, votes.count(), _limit(question.wordcloud_max_answers), "terms"
        )
    return _block(answered)
