# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Rating phase of the mind-map question kind.

After collecting, the presenter switches a mind-map question to its rating
stage; participants then rate the entries instead of adding terms:

* ``points`` (dot voting): ``value`` = points on one entry (>= 1); several
  points per entry unless ``mindmap_rating_multi`` is off (then at most 1).
  Budget = the sum of a participant's points.
* ``updown``: at most one plus OR minus per entry (``value`` +1/-1). Budget =
  the number of rated entries.

Representation: the stage lives in its own row per run + question
(``MindmapPhase``), orthogonal to ``Run.phase`` — participants can only rate
while the run phase is "open" AND the stage is "rate"; closing/opening the
vote works exactly as for collecting. No row (or no rating mode) = "collect".

Hidden-until-reveal: aggregated scores are part of a payload only while the
stage is "rate" with ``mindmap_rating_live`` on, or in the results phase
(reveal; for participants additionally only when the set shows results to
participants). Otherwise the presenter only learns the number of raters.

Hidden entries (and entries below a hidden one) keep their ratings, but those
count neither towards scores/raters/ranking nor towards the participant's
budget (hiding gives the points back; unhiding may leave a participant above
the budget — ``remaining`` is then 0).

Ratings reference only the opaque participant token (anonymity by design);
tokens never leave the server. All writes run under the run lock.
"""
from django.db import transaction
from django.utils import timezone

from rooms.mindmap import RATING_POINTS, RATING_UPDOWN

from .mindmap import (
    MindmapError,
    _effectively_hidden,
    _load_tree,
    _lock_run,
    is_rating,
)
from .models import MindmapPhase, MindmapRating, Run

STAGES = (MindmapPhase.Stage.COLLECT, MindmapPhase.Stage.RATE)


def stage_of(run, question):
    """"collect" or "rate" (always "collect" without a rating mode)."""
    return MindmapPhase.Stage.RATE if is_rating(run, question) else MindmapPhase.Stage.COLLECT


def set_stage(run, question, stage, *, open_vote=False):
    """Presenter: switch the question's stage in this run. Ratings are kept
    when going back to collecting (and count again on the next rating).
    ``open_vote`` also makes the question active and opens the vote (like the
    control endpoint's phase "open", timer reset included) in the same
    transaction, so a single broadcast carries both changes."""
    if stage not in STAGES:
        raise MindmapError("stage must be \"collect\" or \"rate\".")
    if not run.is_active:
        raise MindmapError("Run is finished.", 409)
    if stage == MindmapPhase.Stage.RATE and not question.mindmap_rating_mode:
        raise MindmapError("This question has no rating phase.", 409)
    with transaction.atomic():
        _lock_run(run)
        run.refresh_from_db()  # a concurrent control_run may have changed it
        if not run.is_active:
            raise MindmapError("Run is finished.", 409)
        phase, _ = MindmapPhase.objects.get_or_create(run=run, question=question)
        phase.stage = stage
        fields = ["stage"]
        if stage == MindmapPhase.Stage.RATE:
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
    tree = _load_tree(run, question)
    return {node_id for node_id in tree if not _effectively_hidden(tree, node_id)}


def _spent(question, values):
    if question.mindmap_rating_mode == RATING_UPDOWN:
        return sum(1 for value in values if value)
    return sum(abs(value) for value in values)


def _remaining(question, spent):
    return max(0, question.mindmap_rating_budget - spent)


def _own(run, question, token, visible):
    return {
        node_id: value
        for node_id, value in MindmapRating.objects.filter(
            node__run=run, node__question=question, token=token
        ).values_list("node_id", "value")
        if node_id in visible
    }


def rate(run, question, token, node_id, *, delta=None, value=None):
    """Apply one rating step (types validated by the view: ``delta`` ±1 for
    points, ``value`` -1/0/1 for plus/minus). Returns ``(value, remaining)``;
    raises MindmapError."""
    mode = question.mindmap_rating_mode
    with transaction.atomic():
        _lock_run(run)
        if not is_rating(run, question):
            raise MindmapError("Rating has not started.", 409)
        visible = _visible_ids(run, question)
        if node_id not in visible:
            raise MindmapError("Unknown term.", 404)
        own = _own(run, question, token, visible)
        old = own.get(node_id, 0)
        spent = _spent(question, own.values())
        if mode == RATING_POINTS:
            new = old + delta
            if new < 0:
                raise MindmapError("No points to take back.", 409)
            if delta > 0:
                if not question.mindmap_rating_multi and old >= 1:
                    raise MindmapError("Only one point per entry.", 409)
                if spent >= question.mindmap_rating_budget:
                    raise MindmapError("No points left.", 409)
        else:
            new = value
            if not old and new and spent >= question.mindmap_rating_budget:
                raise MindmapError("No ratings left.", 409)
        if new == 0:
            MindmapRating.objects.filter(node_id=node_id, token=token).delete()
            own.pop(node_id, None)
        else:
            MindmapRating.objects.update_or_create(
                node_id=node_id, token=token, defaults={"value": new}
            )
            own[node_id] = new
    return new, _remaining(question, _spent(question, own.values()))


def my_ratings(run, question, token):
    """``{"ratings": {node_id: value}, "remaining": n}`` of the CALLER (visible
    entries only). Never anyone else's data."""
    own = _own(run, question, token, _visible_ids(run, question))
    return {
        "ratings": {str(node_id): value for node_id, value in own.items()},
        "remaining": _remaining(question, _spent(question, own.values())),
    }


def aggregate(run, question, visible=None):
    """``(scores, raters)`` over visible entries. ``scores`` maps the node id
    (string) of every rated entry to ``{"points"}`` (points) or ``{"up",
    "down", "balance"}`` (plus/minus); ``raters`` = distinct participants."""
    if visible is None:
        visible = _visible_ids(run, question)
    rows = [
        row
        for row in MindmapRating.objects.filter(
            node__run=run, node__question=question
        ).values_list("node_id", "token_id", "value")
        if row[0] in visible
    ]
    scores = {}
    for node_id, _token, value in rows:
        key = str(node_id)
        if question.mindmap_rating_mode == RATING_UPDOWN:
            entry = scores.setdefault(key, {"up": 0, "down": 0, "balance": 0})
            if value > 0:
                entry["up"] += 1
            elif value < 0:
                entry["down"] += 1
            entry["balance"] = entry["up"] - entry["down"]
        else:
            entry = scores.setdefault(key, {"points": 0})
            entry["points"] += max(value, 0)
    return scores, len({token for _node, token, _value in rows})


def _settings(question):
    return {
        "mode": question.mindmap_rating_mode,
        "budget": question.mindmap_rating_budget,
        "multi": question.mindmap_rating_multi,
        "live": question.mindmap_rating_live,
    }


def payload(run, question, *, presenter):
    """``mindmap.rating`` of the SSE snapshots, or None without a rating mode.

    Presenter: ``{mode, budget, multi, live, stage, raters, scores?}``;
    participant: ``{mode, budget, multi, live, stage, totals?}``. ``scores``/
    ``totals`` (same shape, see ``aggregate``) only while rating with the
    live display on, or in the results phase (participants: only if the set
    shows results to participants)."""
    if not question.mindmap_rating_mode:
        return None
    stage = stage_of(run, question)
    data = {**_settings(question), "stage": stage}
    live_now = question.mindmap_rating_live and stage == MindmapPhase.Stage.RATE
    reveal = run.phase == Run.Phase.RESULTS
    if presenter:
        scores, raters = aggregate(run, question)
        data["raters"] = raters
        if live_now or reveal:
            data["scores"] = scores
    elif live_now or (reveal and run.question_set.show_results_to_participants):
        data["totals"] = aggregate(run, question)[0]
    return data


def _flatten(tree):
    """{node id: (path, text, count)} of the visible tree."""
    result = {}

    def walk(nodes, prefix):
        for node in nodes:
            path = f"{prefix} > {node['text']}" if prefix else node["text"]
            result[node["id"]] = (path, node["text"], node["count"])
            walk(node["children"], path)

    walk(tree["nodes"], "")
    return result


def ranking(question, tree, scores):
    """Rated visible entries, best first: by points (points) or balance
    (plus/minus); ties by the entry's count of contributions, then path."""
    nodes = _flatten(tree)
    updown = question.mindmap_rating_mode == RATING_UPDOWN
    result = []
    for key, score in scores.items():
        node_id = int(key)
        if node_id not in nodes:
            continue
        path, text, count = nodes[node_id]
        result.append({"id": node_id, "text": text, "path": path, "count": count, **score})
    result.sort(
        key=lambda r: (-(r["balance"] if updown else r["points"]), -r["count"], r["path"])
    )
    return result


def scores_hidden(run, question):
    """True while the scores are still secret: the run is active, the
    question is being rated with the live display off, and the beamer has not
    revealed them (results phase). The management results/CSV must not leak
    them in the meantime."""
    return (
        run.is_active
        and not question.mindmap_rating_live
        and run.phase != Run.Phase.RESULTS
        and is_rating(run, question)
    )


def results(run, question, tree):
    """``mindmap.rating`` of the management results, or None without a
    rating mode: settings + ``raters``, ``scores``, ``ranking``. While the
    scores are still secret (``scores_hidden``) ``scores``/``ranking`` are
    left out and ``rating_in_progress: true`` is set instead. ``tree`` is the
    participant-form (visible) tree."""
    if not question.mindmap_rating_mode:
        return None
    scores, raters = aggregate(run, question)
    data = {**_settings(question), "raters": raters}
    if scores_hidden(run, question):
        data["rating_in_progress"] = True
    else:
        data["scores"] = scores
        data["ranking"] = ranking(question, tree, scores)
    return data


def csv_cell(question, scores, node_id):
    """The "bewertung" CSV cell: points, or "+up/−down (balance)"."""
    if not question.mindmap_rating_mode:
        return ""
    score = scores.get(str(node_id))
    if question.mindmap_rating_mode == RATING_UPDOWN:
        score = score or {"up": 0, "down": 0, "balance": 0}
        return f"+{score['up']}/−{score['down']} ({score['balance']})"
    return (score or {"points": 0})["points"]
