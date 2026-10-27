# SPDX-License-Identifier: Apache-2.0
"""Answer statistics of single- and multiple-choice questions.

A vote counts as *correct* when the chosen options are exactly the
question's correct options (one option for single choice, the full set for
multiple choice). Questions without a correct option (polls) have answer
counts but no score.

Used by the library (per entry, over every copy and every run) and by the
room statistics (per set and run).
"""
from collections import Counter, defaultdict

from live.models import Vote
from rooms.models import AnswerOption

CHOICE = ("single_choice", "multiple_choice")


def options_of(question_ids):
    """{question id: [(option id, position, is_correct), …]} in order."""
    out = defaultdict(list)
    rows = (
        AnswerOption.objects.filter(question_id__in=question_ids)
        .order_by("question_id", "position", "id")
        .values_list("id", "question_id", "position", "is_correct")
    )
    for option_id, question_id, position, correct in rows:
        out[question_id].append((option_id, position, correct))
    return out


def votes_of(**filters):
    """[(vote id, run id, question id, token id, frozenset(option ids))] of the
    votes matching ``filters`` (Django lookups on Vote)."""
    votes = list(Vote.objects.filter(**filters).values_list("id", "run_id", "question_id", "token_id"))
    picked = defaultdict(set)
    through = Vote.options.through.objects.filter(vote_id__in=[v[0] for v in votes])
    for vote_id, option_id in through.values_list("vote_id", "answeroption_id"):
        picked[vote_id].add(option_id)
    return [(v, run, q, token, frozenset(picked.get(v, ()))) for v, run, q, token in votes]


def correct_set(options):
    return frozenset(option_id for option_id, _, correct in options if correct)


def is_correct(options, chosen):
    """True / False, or None when the question has no correct answer."""
    right = correct_set(options)
    if not right:
        return None
    return chosen == right


# -- library ---------------------------------------------------------------------


def library(members):
    """``members``: {entry id: [question ids (all copies)]} →
    {entry id: {"runs", "answers", "correct" (share or None),
    "top_wrong" (option position or None), "top_wrong_share"}}."""
    question_ids = [q for ids in members.values() for q in ids]
    options = options_of(question_ids)
    by_question = defaultdict(list)
    for _vote, run, question, _token, chosen in votes_of(
        question_id__in=question_ids, question__kind__in=CHOICE
    ):
        by_question[question].append((run, chosen))

    out = {}
    for entry_id, ids in members.items():
        runs, answers, scored, right = set(), 0, 0, 0
        wrong_picks = Counter()
        for question in ids:
            question_options = options.get(question, [])
            position_of = {option_id: position for option_id, position, _ in question_options}
            wrong_ids = {option_id for option_id, _, correct in question_options if not correct}
            for run, chosen in by_question.get(question, ()):
                if not chosen:
                    continue
                runs.add(run)
                answers += 1
                verdict = is_correct(question_options, chosen)
                if verdict is not None:
                    scored += 1
                    right += verdict
                    for option_id in chosen & wrong_ids:
                        wrong_picks[position_of[option_id]] += 1
        top = wrong_picks.most_common(1)
        out[entry_id] = {
            "runs": len(runs),
            "answers": answers,
            "correct": round(right / scored, 3) if scored else None,
            "top_wrong": top[0][0] if top and scored else None,
            "top_wrong_share": round(top[0][1] / scored, 3) if top and scored else None,
        }
    return out
