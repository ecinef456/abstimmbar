# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Result aggregation, shared by the SSE snapshots (state.py), the
management results API and the CSV export."""
import random
from collections import Counter

from django.db.models import Avg, Count, Max, Min

from common.i18n_fields import translated_map
from rooms.models import Question

from . import matrix, mindmap_rating
from .mindmap import build_tree, contribution_total, contributor_count
from .models import Vote


def ordered_options(question, seed):
    """The question's options in the order a run presents them: position order,
    but per-run shuffled (seeded, so every device agrees) when the question
    shuffles its options or is an ordering question. Both the question payload
    and the result tally use this, so the A/B/C letters the beamer draws map to
    the same answers while voting and in the results (#127). Likert and plain
    choice questions keep position order (Likert's order is its scale)."""
    options = list(question.options.all())
    if question.shuffle_options or question.kind == Question.Kind.ORDERING:
        random.Random(seed).shuffle(options)
    return options


def options_with_counts(run, question):
    """Per-option vote counts for a choice question.

    ``text`` is a {de, en} map (#33 MR2): the SSE hub broadcasts one payload
    to every participant, so it can't be resolved to a single language here.
    """
    # Recording mode (#53): split the per-option tally by vote source in one
    # grouped query — combined `count` plus `onsite`/`recording` breakdown.
    combined, onsite, recording = {}, {}, {}
    rows = (
        Vote.options.through.objects.filter(vote__run=run, vote__question=question)
        .values_list("answeroption", "vote__source")
        .annotate(n=Count("id"))
    )
    for option_id, source, n in rows:
        combined[option_id] = combined.get(option_id, 0) + n
        bucket = recording if source == Vote.Source.RECORDING else onsite
        bucket[option_id] = bucket.get(option_id, 0) + n
    return [
        {
            "id": option.pk,
            "text": translated_map(option, "text"),
            **({"image": option.image} if option.image else {}),
            "is_correct": option.is_correct,
            "is_abstention": option.is_abstention,
            "count": combined.get(option.pk, 0),
            "onsite": onsite.get(option.pk, 0),
            "recording": recording.get(option.pk, 0),
        }
        # Same order the run presented the question in (#127), so the beamer's
        # A/B/C letters match between the voting and the results view.
        for option in ordered_options(question, run.pk)
    ]


def likert_summary(options):
    """Diverging aggregation of an ordered Likert scale. Position order is the
    scale from the negative/low pole (0) to the positive/high pole (N-1) — no
    reversal (#86). Buckets: first half = "low", second half = "high", the
    middle step of an odd scale = "neutral". Endpoint labels drive the axis
    captions downstream. Returns None for < 2 real steps.

    `options` is the ``options_with_counts`` output for a Likert question —
    ordered by position and including any ``is_abstention`` entries.
    Abstentions are excluded from the scale and reported separately.

    The scale splits at its centre: an odd number of steps has a single
    neutral step in the middle; an even number has no neutral step and the
    divider sits between the two middle steps. ``divider`` is the position of
    that centre line as a percentage (0–100) of the scale width, so the
    frontend can draw the same line the presentation and results views share.
    """
    scale = [o for o in options if not o["is_abstention"]]
    abstentions = sum(o["count"] for o in options if o["is_abstention"])
    if len(scale) < 2:
        return None
    scale_total = sum(o["count"] for o in scale)
    n = len(scale)
    mid = n // 2
    neutral_index = mid if n % 2 else None

    def pct(c):
        return round(100 * c / scale_total, 1) if scale_total else 0.0

    steps = []
    low = neutral = high = 0
    for i, option in enumerate(scale):
        if i == neutral_index:
            polarity = "neutral"
            neutral += option["count"]
        elif i < mid:
            polarity = "low"
            low += option["count"]
        else:
            polarity = "high"
            high += option["count"]
        steps.append(
            {
                "id": option["id"],
                # Forwarded as-is from `options` — a {de, en} map (#33 MR2)
                # once that comes from options_with_counts.
                "text": option["text"],
                "count": option["count"],
                "pct": pct(option["count"]),
                "polarity": polarity,
            }
        )
    # Centre-line position: end of the low block (+ half the neutral block).
    divider = pct(low) + (pct(neutral) / 2 if neutral_index is not None else 0)
    # #86 Likert-proper central tendency: the MEAN scale position, weighting
    # each vote by how extreme its step is (so 1×far-negative + 1×mildly-positive
    # sits left of centre, not 50:50). `mean_index` is 0..n-1; `mean_score` is
    # centred (0 = the middle of the scale, negative = net-low); `mean_pct` is
    # the mean aligned to the equal-width step columns the frontend draws.
    mean_index = (
        sum(i * option["count"] for i, option in enumerate(scale)) / scale_total
        if scale_total
        else (n - 1) / 2
    )
    mean_pct = round((mean_index + 0.5) / n * 100, 1)
    mean_score = round(mean_index - (n - 1) / 2, 2)
    return {
        "scale_total": scale_total,
        "abstentions": abstentions,
        "high": high,
        "high_pct": pct(high),
        "neutral": neutral,
        "neutral_pct": pct(neutral),
        "low": low,
        "low_pct": pct(low),
        "divider": round(divider, 1),
        "mean_pct": mean_pct,
        "mean_score": mean_score,
        "low_label": scale[0]["text"],
        "high_label": scale[-1]["text"],
        "steps": steps,
    }


def words_with_counts(run, question, limit=150):
    """Word-cloud aggregation: case variants merge (review decision); the most
    frequent raw spelling wins the display. A WordCloudModeration overlay (if
    present) hides keys and combines merge groups (#Wortwolke). Each returned
    term carries its underlying `keys` and a `merged` flag."""
    from .models import WordCloudModeration
    votes = run.votes.filter(question=question).exclude(text="")
    groups = {}
    for text, source in votes.values_list("text", "source"):
        group = groups.setdefault(
            text.casefold(), {"variants": [], "onsite": 0, "recording": 0}
        )
        group["variants"].append(text)
        if source == Vote.Source.RECORDING:
            group["recording"] += 1
        else:
            group["onsite"] += 1
    mod = WordCloudModeration.objects.filter(run=run, question=question).first()
    hidden = set(mod.hidden) if mod else set()
    merges = mod.merges if mod else []
    # Hidden = excluded everywhere: drop hidden keys up front so neither the
    # merge loop nor the singles loop below can see them. A partially-hidden
    # merge then naturally counts only its visible keys via `combine()`.
    for k in hidden:
        groups.pop(k, None)

    def combine(keys):
        variants, onsite, recording = [], 0, 0
        for k in keys:
            g = groups.get(k)
            if g:
                variants += g["variants"]
                onsite += g["onsite"]
                recording += g["recording"]
        return variants, onsite, recording

    words = []
    merged_keys = set()
    for m in merges:
        keys = list(m.get("keys", []))
        merged_keys.update(keys)
        variants, onsite, recording = combine(keys)
        if not variants:
            continue  # no votes for this group yet
        words.append({
            "text": m.get("label") or Counter(variants).most_common(1)[0][0],
            "count": len(variants), "onsite": onsite, "recording": recording,
            "keys": keys, "merged": True,
        })
    for key, group in groups.items():
        if key in merged_keys:
            continue  # hidden keys are already gone from `groups`
        words.append({
            "text": Counter(group["variants"]).most_common(1)[0][0],
            "count": len(group["variants"]),
            "onsite": group["onsite"], "recording": group["recording"],
            "keys": [key], "merged": False,
        })
    words.sort(key=lambda w: -w["count"])
    return words[:limit]


def freetext_evaluation(run, question):
    """Live free-text evaluation summary (v2 KI): distinct answers grouped by
    the stored verdict along the question's chosen scale, plus how many answers
    are still being processed and whether to render a bar chart."""
    from .ai_freetext import clean_categories, middle_category

    categories = clean_categories(question.evaluation_categories)
    fallback = middle_category(categories)
    valid = {c.casefold(): c for c in categories}
    votes = run.votes.filter(question=question).exclude(text="")
    buckets = {verdict: {} for verdict in categories}
    pending = 0
    for text, verdict in votes.values_list("text", "ai_verdict"):
        if not verdict:
            pending += 1
            continue
        verdict = valid.get(verdict.casefold(), fallback)
        entry = buckets[verdict].setdefault(text.casefold(), {"text": text, "count": 0})
        entry["count"] += 1
    groups = [
        {
            "verdict": verdict,
            "count": sum(item["count"] for item in buckets[verdict].values()),
            "items": sorted(buckets[verdict].values(), key=lambda i: -i["count"]),
        }
        for verdict in categories
    ]
    return {
        "groups": groups,
        "categories": categories,
        "chart": question.evaluation_chart,
        "pending": pending,
        "total": votes.count(),
    }


def priority_stats(run, question):
    """Per-option average / min / max points for a ``priorities`` question
    (#58), sorted by average descending. ``text`` is a {de, en} map."""
    from .models import PriorityScore

    rows = (
        PriorityScore.objects.filter(vote__run=run, vote__question=question)
        .values("option")
        .annotate(avg=Avg("points"), min=Min("points"), max=Max("points"), n=Count("id"))
    )
    stats = {row["option"]: row for row in rows}
    result = []
    for option in question.options.all():
        row = stats.get(option.pk)
        result.append(
            {
                "id": option.pk,
                "text": translated_map(option, "text"),
                **({"image": option.image} if option.image else {}),
                "avg": round(row["avg"], 1) if row else 0,
                "min": row["min"] if row else 0,
                "max": row["max"] if row else 0,
                "n": row["n"] if row else 0,
            }
        )
    result.sort(key=lambda entry: entry["avg"], reverse=True)
    return result


# Minimum per-link relative-adjacency rate (%) for a pair of consecutive
# solution items to join a "correctly-ordered run" (brace) in the results.
ORDERING_CHAIN_THRESHOLD = 50.0


def ordering_stats(run, question):
    """Per-item correct-placement rate for an ``ordering`` question (#72).

    An item is "correctly placed" when the participant's assigned position for
    that option equals the option's own ``position`` (the authored solution).
    ``text`` is a {de, en} map. Items are returned in solution order; the extra
    ``full_correct_rate`` is the share of submissions matching the solution
    exactly. Rates are percentages rounded to 1 decimal.
    """
    from .models import OrderingResponse

    n = (
        run.votes.filter(question=question).count()
    )
    options = list(question.options.all())  # ordered by position (Meta.ordering)
    # correct count per option: assigned position == option.position
    correct_by_option = {}
    for option in options:
        correct_by_option[option.pk] = OrderingResponse.objects.filter(
            vote__run=run, vote__question=question,
            option=option, position=option.position,
        ).count()
    items = []
    for option in options:
        c = correct_by_option[option.pk]
        items.append(
            {
                "id": option.pk,
                "text": translated_map(option, "text"),
                **({"image": option.image} if option.image else {}),
                "correct_position": option.position + 1,
                "correct_rate": round(100.0 * c / n, 1) if n else 0,
                "n": n,
            }
        )
    # fully-correct submissions: every option placed at its own position.
    full_correct = 0
    if n:
        votes = run.votes.filter(question=question).prefetch_related("ordering_responses")
        solution = {o.pk: o.position for o in options}
        for vote in votes:
            if all(r.position == solution.get(r.option_id) for r in vote.ordering_responses.all()) \
               and vote.ordering_responses.count() == len(options):
                full_correct += 1
    # Relative-adjacency links + chains: load each submission's assigned
    # position per option once, then score consecutive solution pairs.
    subs = []  # [{option_id: assigned_position}, ...]
    if n:
        for vote in run.votes.filter(question=question).prefetch_related(
            "ordering_responses"
        ):
            subs.append({r.option_id: r.position for r in vote.ordering_responses.all()})

    def _adjacent(pos, a, b):
        return a.pk in pos and b.pk in pos and pos[b.pk] == pos[a.pk] + 1

    links = []
    for k in range(len(options) - 1):
        a, b = options[k], options[k + 1]
        hits = sum(1 for pos in subs if _adjacent(pos, a, b))
        links.append(
            {"from": a.pk, "to": b.pk, "rate": round(100.0 * hits / n, 1) if n else 0}
        )

    chains = []
    k = 0
    while k < len(links):
        if links[k]["rate"] >= ORDERING_CHAIN_THRESHOLD:
            start = k
            while k < len(links) and links[k]["rate"] >= ORDERING_CHAIN_THRESHOLD:
                k += 1
            end = k  # item index one past the last qualifying link
            whole = sum(
                1
                for pos in subs
                if all(_adjacent(pos, options[j], options[j + 1]) for j in range(start, end))
            )
            chains.append(
                {"start": start, "end": end, "rate": round(100.0 * whole / n, 1) if n else 0}
            )
        else:
            k += 1

    return {
        "items": items,
        "full_correct_rate": round(100.0 * full_correct / n, 1) if n else 0,
        "n": n,
        "links": links,
        "chains": chains,
    }


def run_results(run):
    """Full per-question aggregation of one run (management results view)."""
    questions = run.question_set.questions.prefetch_related("options")
    items = []
    for question in questions:
        item = {
            "id": question.pk,
            "position": question.position,
            "kind": question.kind,
            # {de, en} map (#33 MR2), matching item["options"][].text below so
            # the /results/ API contract is uniform maps throughout.
            "text": translated_map(question, "text"),
            "votes": run.votes.filter(question=question).count(),
            # Recording mode (#53): how many of this question's votes came from
            # recording viewers (async), so the view can show the split.
            "votes_recording": run.votes.filter(
                question=question, source=Vote.Source.RECORDING
            ).count(),
            # Vorher-Nachher-Paar (#54): the before-question this one mirrors,
            # so the results view can pair them for comparison (null otherwise).
            "before_question": question.before_question_id,
        }
        if question.kind == Question.Kind.MINDMAP:
            item["mindmap"] = build_tree(run, question, presenter=False)
            rating = mindmap_rating.results(run, question, item["mindmap"])
            if rating is not None:
                item["mindmap"]["rating"] = rating
            item["votes"] = contributor_count(run, question)
        elif question.kind == Question.Kind.MATRIX:
            item["matrix"] = matrix.board_payload(run, question, presenter=False)
            item["matrix_settings"] = matrix.settings_payload(question)
            item["votes"] = matrix.contributor_count(run, question)
        elif question.kind in Question.TEXT_KINDS:
            item["words"] = words_with_counts(run, question)
            if question.kind == Question.Kind.OPEN_TEXT and question.ai_evaluate:
                item["evaluation"] = freetext_evaluation(run, question)
        elif question.kind == Question.Kind.PRIORITIES:
            item["priorities"] = priority_stats(run, question)
        elif question.kind == Question.Kind.ORDERING:
            item["ordering"] = ordering_stats(run, question)
        else:
            item["options"] = options_with_counts(run, question)
            if question.kind == Question.Kind.LIKERT:
                item["likert"] = likert_summary(item["options"])
        items.append(item)
    return {
        "run": run.pk,
        "phase": run.phase,
        "created_at": run.created_at.isoformat(),
        "first_opened_at": (
            run.first_opened_at.isoformat() if run.first_opened_at else None
        ),
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
        # All stored answers of the run: votes plus mind-map contributions
        # (one per term a participant added), so a mind-map-only run is not
        # shown as empty.
        "votes_total": run.votes.count() + contribution_total(run),
        # Recording mode (#53): total async votes in this run; the view shows
        # the on-site/recording split only when there are any.
        "recording_votes": run.votes.filter(source=Vote.Source.RECORDING).count(),
        "questions": items,
    }
