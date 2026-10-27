# SPDX-License-Identifier: Apache-2.0
"""Peer instruction (vote, discuss, vote again) and answer confidence.

Peer instruction: on a single- or multiple-choice question of a live run the
presenter presses D. The first vote is kept in a PeerRound (counts, each
participant's choice and confidence), the question's votes are cleared and
it opens again: phones show a fresh form ("Vote 2"), and the beamer's
results show vote 1 above vote 2 for every answer.

Confidence: when switched on for the set, phones ask "How sure are you?
0–10" (optional) under the answer just given; stored per vote.
"""
from django.db import transaction
from django.utils import timezone

from live.models import Run, Vote

from . import game, stats
from .models import PeerRound, RunJustification, SetConfidence, VoteConfidence

CHOICE = stats.CHOICE


class PeerError(Exception):
    pass


def confidence_enabled(question_set):
    return SetConfidence.objects.filter(question_set=question_set, enabled=True).exists()


def set_confidence_enabled(question_set, enabled):
    SetConfidence.objects.update_or_create(
        question_set=question_set, defaults={"enabled": bool(enabled)}
    )


def round_of(run, question):
    return PeerRound.objects.filter(run=run, question=question).first()


@transaction.atomic
def start(run):
    """Keep the first vote of the active question and open it again."""
    run = Run.objects.select_for_update().get(pk=run.pk)
    question = run.active_question
    if run.mode != Run.Mode.LIVE or not run.is_active:
        raise PeerError("Only in a running live poll.")
    if question is None or question.kind not in CHOICE:
        raise PeerError("Only for single- and multiple-choice questions.")
    if run.phase not in (Run.Phase.OPEN, Run.Phase.CLOSED, Run.Phase.RESULTS):
        raise PeerError("Let the class vote first.")
    if game.enabled(run.question_set):
        raise PeerError("Not in game mode.")
    if PeerRound.objects.filter(run=run, question=question).exists():
        raise PeerError("This question was already voted on twice.")

    votes = stats.votes_of(run=run, question=question)
    confidence = dict(
        VoteConfidence.objects.filter(vote_id__in=[v[0] for v in votes]).values_list("vote_id", "value")
    )
    counts = {str(option_id): 0 for option_id in question.options.values_list("id", flat=True)}
    answers, sure = {}, {}
    for vote_id, _run, _question, token_id, chosen in votes:
        if not chosen:
            continue
        for option_id in chosen:
            counts[str(option_id)] = counts.get(str(option_id), 0) + 1
        answers[str(token_id)] = sorted(chosen)
        if vote_id in confidence:
            sure[str(token_id)] = confidence[vote_id]
    PeerRound.objects.create(
        run=run, question=question, counts=counts, votes=len(answers), answers=answers, confidence=sure
    )
    Vote.objects.filter(run=run, question=question).delete()

    run.phase = Run.Phase.OPEN
    run.opened_at = timezone.now()
    run.answers_revealed = False
    run.presenter_away = False
    run.save(update_fields=["phase", "opened_at", "answers_revealed", "presenter_away", "updated_at"])
    RunJustification.objects.filter(run=run).update(question=None)
    return run


def save_confidence(run, question, token, value):
    """A participant's confidence for their answer to ``question``."""
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 10:
        raise PeerError("Confidence is a whole number from 0 to 10.")
    if not confidence_enabled(run.question_set):
        raise PeerError("Confidence is not asked in this set.")
    vote = Vote.objects.filter(run=run, question=question, token=token).order_by("-id").first()
    if vote is None:
        raise PeerError("Answer the question first.")
    VoteConfidence.objects.update_or_create(vote=vote, defaults={"value": value})


def confidence_summary(run, question):
    """{"answers": n, "average": x, "right": x|None, "wrong": x|None} of the
    current vote (None when nobody gave one)."""
    votes = stats.votes_of(run=run, question=question)
    values = dict(
        VoteConfidence.objects.filter(vote_id__in=[v[0] for v in votes]).values_list("vote_id", "value")
    )
    if not values:
        return None
    options = stats.options_of([question.pk]).get(question.pk, [])
    right, wrong = [], []
    for vote_id, _run, _question, _token, chosen in votes:
        if vote_id not in values:
            continue
        verdict = stats.is_correct(options, chosen)
        if verdict is True:
            right.append(values[vote_id])
        elif verdict is False:
            wrong.append(values[vote_id])

    def mean(items):
        return round(sum(items) / len(items), 1) if items else None

    return {
        "answers": len(values),
        "average": mean(list(values.values())),
        "right": mean(right),
        "wrong": mean(wrong),
    }


def results_item(run, question, item):
    """run_results hook: vote 1 of peer instruction and the confidence
    summary for a choice question of the stored results."""
    if question.kind not in CHOICE:
        return
    peer = round_of(run, question)
    if peer:
        item["qb_peer"] = {
            "votes": peer.votes,
            "counts": [peer.counts.get(str(option["id"]), 0) for option in item.get("options", [])],
        }
    summary = confidence_summary(run, question)
    if summary:
        item["qb_confidence"] = summary


def attach(run, participant, presenter):
    """build_payloads hook: round and confidence flags for phones, vote 1
    and the confidence summary for the beamer."""
    question = run.active_question
    if run.mode != Run.Mode.LIVE or question is None or question.kind not in CHOICE:
        return
    peer = round_of(run, question)
    asked = confidence_enabled(run.question_set)
    shown = participant.get("question")
    if shown and shown.get("id") == question.pk and "options" in shown:
        shown["qb_round"] = 2 if peer else 1
        shown["qb_confidence"] = asked
    presenter["qb_peer"] = {
        "round": 2 if peer else 1,
        "available": peer is None and not game.enabled(run.question_set),
    }
    if peer and "results" in presenter and not question.before_question_id:
        presenter["before"] = {
            "votes": peer.votes,
            "results": [
                {"id": row["id"], "count": peer.counts.get(str(row["id"]), 0)}
                for row in presenter["results"]
            ],
        }
    if asked:
        presenter["qb_confidence"] = confidence_summary(run, question)
