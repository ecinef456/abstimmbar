# SPDX-License-Identifier: Apache-2.0
"""Answer statistics of single- and multiple-choice questions.

A vote counts as *correct* when the chosen options are exactly the
question's correct options (one option for single choice, the full set for
multiple choice). Questions without a correct option (polls) have answer
counts but no score.

Used by the library (per entry, over every copy and every run) and by the
room statistics (per set and run).
"""
import re
from collections import Counter, defaultdict

from django.db.models import Count

from live.models import Run, SelfCheckAttempt, Vote
from rooms.models import AnswerOption, Question

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
    "top_wrong" (option position or None), "top_wrong_share"}}.

    Every answer ever given to any copy counts once (all rooms, all runs;
    demo runs never). After peer instruction the *first* vote counts — what
    students knew before discussing, which is what makes a question easy or
    hard."""
    from .models import PeerRound

    question_ids = [q for ids in members.values() for q in ids]
    options = options_of(question_ids)
    peered = PeerRound.objects.filter(question_id__in=question_ids, run__qb_demo__isnull=True)
    first_votes = {(p.run_id, p.question_id): p.answers for p in peered}
    by_question = defaultdict(list)
    for _vote, run, question, _token, chosen in votes_of(
        question_id__in=question_ids, question__kind__in=CHOICE, run__qb_demo__isnull=True
    ):
        if (run, question) not in first_votes:
            by_question[question].append((run, chosen))
    for (run, question), answers in first_votes.items():
        by_question[question].extend((run, frozenset(chosen)) for chosen in answers.values())

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


# -- sets, folders, rooms --------------------------------------------------------

PRE_POST = re.compile(r"\b(pre|post)\b", re.IGNORECASE)


def _share(right, scored):
    return round(right / scored, 3) if scored else None


def runs_with_votes(question_set):
    """Runs of a set that collected answers, newest first."""
    return list(
        Run.objects.filter(question_set=question_set, qb_demo__isnull=True)  # no demo runs
        .annotate(n=Count("votes"))
        .filter(n__gt=0)
        .order_by("-created_at")
    )


def _question_rows(question_set):
    from . import i18n

    questions = list(
        Question.objects.filter(question_set=question_set, kind__in=CHOICE)
        .order_by("position", "id")
        .prefetch_related("options")
    )
    i18n.preload(questions)
    return questions


def _confidence(vote_ids):
    from .models import VoteConfidence

    return dict(VoteConfidence.objects.filter(vote_id__in=vote_ids).values_list("vote_id", "value"))


def _mean(values):
    return round(sum(values) / len(values), 1) if values else None


def question_stats(question, options, votes, sure, first_round=None):
    """One question: answers, options with counts, share correct, vote 1 of
    peer instruction (merged over ``first_round`` rows) and confidence."""
    from . import i18n

    counts = Counter()
    answers = right = scored = 0
    sure_right, sure_wrong, sure_all = [], [], []
    for vote_id, _run, _question, _token, chosen in votes:
        if not chosen:
            continue
        answers += 1
        counts.update(chosen)
        verdict = is_correct(options, chosen)
        if verdict is not None:
            scored += 1
            right += verdict
        if vote_id in sure:
            sure_all.append(sure[vote_id])
            (sure_right if verdict else sure_wrong if verdict is False else []).append(sure[vote_id])
    by_id = {o.pk: o for o in question.options.all()}
    item = {
        "id": question.pk,
        "position": question.position,
        "kind": question.kind,
        "text": i18n.question_map(question),
        "answers": answers,
        "correct": _share(right, scored),
        "options": [
            {
                "id": option_id,
                "text": i18n.option_map(by_id[option_id], question) if option_id in by_id else {},
                "is_correct": correct,
                "count": counts.get(option_id, 0),
            }
            for option_id, _position, correct in options
        ],
        "peer": None,
        "confidence": (
            {"answers": len(sure_all), "average": _mean(sure_all), "right": _mean(sure_right), "wrong": _mean(sure_wrong)}
            if sure_all
            else None
        ),
    }
    if first_round:
        first = Counter()
        voters = first_right = 0
        right_set = correct_set(options)
        for peer in first_round:
            voters += peer.votes
            for option_id, n in peer.counts.items():
                first[int(option_id)] += n
            if right_set:
                first_right += sum(1 for chosen in peer.answers.values() if frozenset(chosen) == right_set)
        item["peer"] = {
            "votes": voters,
            "counts": [first.get(option_id, 0) for option_id, _, _ in options],
            "correct": _share(first_right, voters) if right_set else None,
        }
    return item


def set_stats(question_set, run="latest"):
    """Statistics of one set. ``run``: "latest", "all" or a run id."""
    from .models import PeerRound

    base = {
        "id": question_set.pk,
        "type": question_set.type,
        "questions": [],
        "runs": [],
        "run": None,
        "participants": 0,
        "answers": 0,
        "correct": None,
    }
    questions = _question_rows(question_set)
    if question_set.type == "self_check":
        return _self_check_stats(question_set, questions, base)
    runs = runs_with_votes(question_set)
    base["runs"] = [
        {"id": r.pk, "date": (r.first_opened_at or r.created_at).isoformat(), "votes": r.n} for r in runs
    ]
    if run == "all":
        chosen_runs = runs
        base["run"] = "all"
    else:
        chosen_runs = [r for r in runs if str(r.pk) == str(run)] or runs[:1]
        base["run"] = chosen_runs[0].pk if chosen_runs else None
    run_ids = [r.pk for r in chosen_runs]  # none yet: the questions with 0 answers
    votes = votes_of(run_id__in=run_ids, question__in=questions)
    options = options_of([q.pk for q in questions])
    sure = _confidence([v[0] for v in votes])
    rounds = {}
    for peer in PeerRound.objects.filter(run_id__in=run_ids, question__in=questions):
        rounds.setdefault(peer.question_id, []).append(peer)
    by_question = {}
    for vote in votes:
        by_question.setdefault(vote[2], []).append(vote)
    right = scored = 0
    for question in questions:
        item = question_stats(
            question, options.get(question.pk, []), by_question.get(question.pk, []), sure, rounds.get(question.pk)
        )
        base["questions"].append(item)
        if item["correct"] is not None:
            # weight by answers: total right / total scored answers
            right += item["correct"] * item["answers"]
            scored += item["answers"]
    base["participants"] = len({v[3] for v in votes})
    base["answers"] = sum(item["answers"] for item in base["questions"])
    base["correct"] = round(right / scored, 3) if scored else None
    return base


def _self_check_stats(question_set, questions, base):
    from . import i18n

    attempts = SelfCheckAttempt.objects.filter(question_set=question_set)
    whole = attempts.filter(question__isnull=True)
    per_question = {}
    for question_id, correct, scored in attempts.filter(question__isnull=False).values_list(
        "question_id", "correct", "scored"
    ):
        row = per_question.setdefault(question_id, [0, 0, 0])
        row[0] += 1
        row[1] += correct
        row[2] += scored
    for question in questions:
        n, correct, scored = per_question.get(question.pk, (0, 0, 0))
        base["questions"].append(
            {
                "id": question.pk,
                "position": question.position,
                "kind": question.kind,
                "text": i18n.question_map(question),
                "answers": n,
                "correct": _share(correct, scored),
                "options": [],
                "peer": None,
                "confidence": None,
            }
        )
    totals = whole.values_list("correct", "scored")
    base["participants"] = len(totals)  # completed attempts
    base["answers"] = sum(q["answers"] for q in base["questions"])
    base["correct"] = _share(sum(c for c, _ in totals), sum(s for _, s in totals))
    return base


def pair_key(title):
    """'1 - Activators PRE' → ('activators', 'pre'); None without pre/post."""
    found = PRE_POST.findall(title or "")
    if len(found) != 1:
        return None
    rest = PRE_POST.sub(" ", title)
    rest = re.sub(r"^\s*\d+\s*[-–.:)]*\s*", "", rest)
    rest = re.sub(r"\W+", " ", rest).strip().casefold()
    return rest, found[0].lower()


def pre_post(sets_stats):
    """Pairs of PRE/POST sets in one group, their questions matched by
    library entry (else by position)."""
    from .models import QuestionLineage

    keyed = {}
    for item in sets_stats:
        key = pair_key(item["title"])
        if key:
            keyed.setdefault(key[0], {})[key[1]] = item
    pairs = []
    for name, found in keyed.items():
        if "pre" not in found or "post" not in found:
            continue
        pre, post = found["pre"], found["post"]
        ids = [q["id"] for q in pre["questions"] + post["questions"]]
        entry = dict(QuestionLineage.objects.filter(question_id__in=ids).values_list("question_id", "entry_id"))
        post_by_entry = {entry.get(q["id"]): q for q in post["questions"] if entry.get(q["id"])}
        rows = []
        for index, question in enumerate(pre["questions"]):
            match = post_by_entry.get(entry.get(question["id"]))
            if match is None and index < len(post["questions"]):
                match = post["questions"][index]
            if match is None:
                continue
            rows.append({"pre_id": question["id"], "post_id": match["id"], "text": question["text"],
                         "pre": question["correct"], "post": match["correct"]})
        pairs.append({"name": name, "pre": pre["id"], "post": post["id"], "pre_correct": pre["correct"],
                      "post_correct": post["correct"], "questions": rows})
    return pairs


def room_stats(room, folder="all"):
    """Overview of a room: groups (folders, then sets not in a folder), each
    with its sets' statistics (latest run) and PRE → POST pairs.
    ``folder``: "all", "none" or a folder id."""
    from common.i18n_fields import translated_map

    from .export import _natural, _set_sequence, _title

    groups = []
    folders = list(room.qb_folders.prefetch_related("placements"))
    placed = set()
    for item in folders:
        sets = _set_sequence(item)
        placed.update(s.pk for s in sets)
        if folder == "all" or str(folder) == str(item.pk):
            groups.append({"folder": item.pk, "title": item.title, "ordered": item.ordered, "sets": sets})
    if folder in ("all", "none"):
        rest = sorted(
            (s for s in room.question_sets.all() if s.pk not in placed),
            key=lambda s: _natural(_title(s)["de"]),
        )
        if rest:
            groups.append({"folder": None, "title": None, "ordered": False, "sets": rest})
    out = []
    for group in groups:
        stats_list = []
        for question_set in group["sets"]:
            item = set_stats(question_set)
            item["title"] = translated_map(question_set, "title").get("de") or question_set.title
            item["title_map"] = _title(question_set)
            stats_list.append(item)
        out.append(
            {
                "folder": group["folder"],
                "title": group["title"],
                "sets": stats_list,
                "pairs": pre_post(stats_list),
            }
        )
    return {"room": room.pk, "groups": out}
