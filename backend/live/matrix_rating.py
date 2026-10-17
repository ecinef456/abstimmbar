# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Rating phase of the matrix question kind.

Mirrors ``live.mindmap_rating`` (same modes, budget and reveal rules); read
its docstring for the full semantics. Differences for the matrix:

* Rateable (and counted) are only **visible top cards**: not hidden, not a
  stack member (a stack is rated as one card, through its top). Ratings of
  members and hidden cards are kept but neither counted nor charged against
  the budget; unstacking / unhiding makes them count again.
* While the stage is "rate" the board is locked: participants cannot add or
  withdraw cards and stacks cannot be changed (see ``live.matrix``); moving
  and hiding stay possible.

The stage lives in ``MatrixPhase`` (orthogonal to ``Run.phase``). Ratings
reference only the opaque participant token. All writes run under the run lock.
"""
from django.db import transaction
from django.utils import timezone

from rooms.mindmap import RATING_POINTS, RATING_UPDOWN

from .matrix import ZONES, MatrixError, _lock_run, is_rating
from .models import MatrixCard, MatrixPhase, MatrixRating, Run

STAGES = (MatrixPhase.Stage.COLLECT, MatrixPhase.Stage.RATE)


def stage_of(run, question):
    """"collect" or "rate" (always "collect" without a rating mode)."""
    return MatrixPhase.Stage.RATE if is_rating(run, question) else MatrixPhase.Stage.COLLECT


def set_stage(run, question, stage, *, open_vote=False):
    """Presenter: switch the question's stage in this run. Ratings are kept
    when going back to collecting. ``open_vote`` also makes the question
    active and opens the vote in the same transaction (one broadcast)."""
    if stage not in STAGES:
        raise MatrixError("stage must be \"collect\" or \"rate\".")
    if not run.is_active:
        raise MatrixError("Run is finished.", 409)
    if stage == MatrixPhase.Stage.RATE and not question.matrix_rating_mode:
        raise MatrixError("This question has no rating phase.", 409)
    with transaction.atomic():
        _lock_run(run)
        run.refresh_from_db()  # a concurrent control_run may have changed it
        if not run.is_active:
            raise MatrixError("Run is finished.", 409)
        phase, _ = MatrixPhase.objects.get_or_create(run=run, question=question)
        phase.stage = stage
        fields = ["stage"]
        if stage == MatrixPhase.Stage.RATE:
            phase.rating_started_at = timezone.now()
            fields.append("rating_started_at")
        phase.save(update_fields=fields)
        if open_vote:
            open_question(run, question)
    return stage


def open_question(run, question):
    """Make ``question`` active and open the vote — the same state change as
    ``control_run`` with phase "open"."""
    run.active_question = question
    run.phase = Run.Phase.OPEN
    run.opened_at = timezone.now()
    if run.first_opened_at is None:
        run.first_opened_at = run.opened_at
    run.answers_revealed = False
    run.save()


def _visible_ids(run, question):
    """Ids of the visible top cards (no members, nothing hidden)."""
    return set(
        MatrixCard.objects.filter(
            run=run, question=question, stack__isnull=True, hidden=False
        ).values_list("pk", flat=True)
    )


def _spent(question, values):
    if question.matrix_rating_mode == RATING_UPDOWN:
        return sum(1 for value in values if value)
    return sum(abs(value) for value in values)


def _remaining(question, spent):
    return max(0, question.matrix_rating_budget - spent)


def _own(run, question, token, visible):
    return {
        card_id: value
        for card_id, value in MatrixRating.objects.filter(
            card__run=run, card__question=question, token=token
        ).values_list("card_id", "value")
        if card_id in visible
    }


def rate(run, question, token, card_id, *, delta=None, value=None):
    """Apply one rating step (types validated by the view: ``delta`` ±1 for
    points, ``value`` -1/0/1 for plus/minus). Returns ``(value, remaining)``;
    raises MatrixError."""
    mode = question.matrix_rating_mode
    with transaction.atomic():
        _lock_run(run)
        if not is_rating(run, question):
            raise MatrixError("Rating has not started.", 409)
        visible = _visible_ids(run, question)
        if card_id not in visible:
            raise MatrixError("Card not found.", 404)
        own = _own(run, question, token, visible)
        old = own.get(card_id, 0)
        spent = _spent(question, own.values())
        if mode == RATING_POINTS:
            new = old + delta
            if new < 0:
                raise MatrixError("No points to take back.", 409)
            if delta > 0:
                if not question.matrix_rating_multi and old >= 1:
                    raise MatrixError("Only one point per card.", 409)
                if spent >= question.matrix_rating_budget:
                    raise MatrixError("No points left.", 409)
        else:
            new = value
            if not old and new and spent >= question.matrix_rating_budget:
                raise MatrixError("No ratings left.", 409)
        if new == 0:
            MatrixRating.objects.filter(card_id=card_id, token=token).delete()
            own.pop(card_id, None)
        else:
            MatrixRating.objects.update_or_create(
                card_id=card_id, token=token, defaults={"value": new}
            )
            own[card_id] = new
    return new, _remaining(question, _spent(question, own.values()))


def my_ratings(run, question, token):
    """The CALLER's ratings of the visible top cards plus budget info:
    ``{ratings: {card_id: value}, remaining, budget, mode}``. Never anyone
    else's data."""
    own = _own(run, question, token, _visible_ids(run, question))
    return {
        "ratings": {str(card_id): value for card_id, value in own.items()},
        "remaining": _remaining(question, _spent(question, own.values())),
        "budget": question.matrix_rating_budget,
        "mode": question.matrix_rating_mode,
    }


def aggregate(run, question, visible=None):
    """``(scores, raters)`` over visible top cards. ``scores`` maps the card
    id (string) of every rated card to ``{"points"}`` (points) or ``{"up",
    "down", "balance"}`` (plus/minus); ``raters`` = distinct participants."""
    if visible is None:
        visible = _visible_ids(run, question)
    rows = [
        row
        for row in MatrixRating.objects.filter(
            card__run=run, card__question=question
        ).values_list("card_id", "token_id", "value")
        if row[0] in visible
    ]
    scores = {}
    for card_id, _token, value in rows:
        key = str(card_id)
        if question.matrix_rating_mode == RATING_UPDOWN:
            entry = scores.setdefault(key, {"up": 0, "down": 0, "balance": 0})
            if value > 0:
                entry["up"] += 1
            elif value < 0:
                entry["down"] += 1
            entry["balance"] = entry["up"] - entry["down"]
        else:
            entry = scores.setdefault(key, {"points": 0})
            entry["points"] += max(value, 0)
    return scores, len({token for _card, token, _value in rows})


def _settings(question):
    return {
        "mode": question.matrix_rating_mode,
        "budget": question.matrix_rating_budget,
        "multi": question.matrix_rating_multi,
        "live": question.matrix_rating_live,
    }


def payload(run, question, *, presenter):
    """``matrix.rating`` of the SSE snapshots, or None without a rating mode.

    Presenter: ``{mode, budget, multi, live, stage, raters, scores?}``;
    participant: ``{mode, budget, multi, live, stage, totals?}``. Scores only
    while rating with the live display on, or in the results phase
    (participants: only if the set shows results to participants)."""
    if not question.matrix_rating_mode:
        return None
    stage = stage_of(run, question)
    data = {**_settings(question), "stage": stage}
    live_now = question.matrix_rating_live and stage == MatrixPhase.Stage.RATE
    reveal = run.phase == Run.Phase.RESULTS
    if presenter:
        scores, raters = aggregate(run, question)
        data["raters"] = raters
        if live_now or reveal:
            data["scores"] = scores
    elif live_now or (reveal and run.question_set.show_results_to_participants):
        data["totals"] = aggregate(run, question)[0]
    return data


_ZONE_ORDER = {zone: i for i, zone in enumerate(ZONES)}


def participant_payload(run, question):
    """``matrix_rating`` of the participant snapshot, or None without a rating
    mode. Collecting: ``{stage}``. Rating: ``{stage, mode, budget, multi,
    cards, scores?}`` — ``cards`` are the visible top cards WITHOUT positions
    (zone order, then y descending, x ascending); ``scores`` only once
    revealed (see :func:`payload`). Never anyone's individual ratings."""
    if not question.matrix_rating_mode:
        return None
    stage = stage_of(run, question)
    if stage != MatrixPhase.Stage.RATE:
        return {"stage": stage}
    tops = sorted(
        MatrixCard.objects.filter(
            run=run, question=question, stack__isnull=True, hidden=False
        ),
        key=lambda c: (_ZONE_ORDER.get(c.zone, len(ZONES)), -c.y, c.x, c.pk),
    )
    data = {
        "stage": stage,
        "mode": question.matrix_rating_mode,
        "budget": question.matrix_rating_budget,
        "multi": question.matrix_rating_multi,
        "cards": [
            {"id": c.pk, "title": c.title, "description": c.description,
             "category": c.category, "zone": c.zone, "summary": c.summary}
            for c in tops
        ],
    }
    shared = payload(run, question, presenter=False)
    if "totals" in shared:
        data["scores"] = shared["totals"]
    return data


def votes(run, question):
    """"votes" of a matrix question: distinct participants who contributed
    cards or rated (a run with only ratings must not show 0)."""
    from .matrix import contributor_count

    return max(contributor_count(run, question), aggregate(run, question)[1])


def ranking(question, cards, scores):
    """Rated visible top cards, best first: by points (points) or balance
    (plus/minus); ties by title, then id. ``cards`` = board card dicts (only
    tops are considered)."""
    updown = question.matrix_rating_mode == RATING_UPDOWN
    tops = {c["id"]: c for c in cards if not c.get("stack")}
    result = []
    for key, score in scores.items():
        card = tops.get(int(key))
        if card is None:
            continue
        result.append({
            "id": card["id"], "title": card["title"],
            "description": card["description"], "category": card["category"],
            "zone": card["zone"], "summary": card.get("summary", False), **score,
        })
    result.sort(
        key=lambda r: (-(r["balance"] if updown else r["points"]), r["title"], r["id"])
    )
    return result


def scores_hidden(run, question):
    """True while the scores are still secret: the run is active, the
    question is being rated with the live display off, and the beamer has not
    revealed them (results phase). Management results/CSV must not leak them."""
    return (
        run.is_active
        and not question.matrix_rating_live
        and run.phase != Run.Phase.RESULTS
        and is_rating(run, question)
    )


def results(run, question, board):
    """``matrix.rating`` of the management results, or None without a rating
    mode: settings + ``raters``, ``scores``, ``ranking``. While the scores are
    still secret ``scores``/``ranking`` are left out and
    ``rating_in_progress: true`` is set. ``board`` = ``board_payload`` result
    (visible form)."""
    if not question.matrix_rating_mode:
        return None
    scores, raters = aggregate(run, question)
    data = {**_settings(question), "raters": raters}
    if scores_hidden(run, question):
        data["rating_in_progress"] = True
    else:
        data["scores"] = scores
        data["ranking"] = ranking(question, board["cards"], scores)
    return data


def csv_cell(question, scores, card_id):
    """The "bewertung" CSV cell: points, or "+up/−down (balance)" (same format
    as the mind map)."""
    if not question.matrix_rating_mode:
        return ""
    score = scores.get(str(card_id))
    if question.matrix_rating_mode == RATING_UPDOWN:
        score = score or {"up": 0, "down": 0, "balance": 0}
        return f"+{score['up']}/−{score['down']} ({score['balance']})"
    return (score or {"points": 0})["points"]
