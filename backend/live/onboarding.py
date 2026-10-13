# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Example results for the seeded example room (#78, guided tour).

``seed_example_results`` gives the example set two finished runs with
invented, anonymous answers to every question — so the results page, the run
picker (the earlier run = an archived Durchführung), CSV export and the set's
"archive results" action are explorable right away. Both runs lie in the
past: Easy mode then auto-archives on the next presentation and Expert gets
the start dialog, so the example runs are never continued by accident.
Deterministic (fixed seed) so tests and screenshots are stable.
"""
import random
from datetime import timedelta

from django.utils import timezone

from rooms.models import Question

from . import mindmap as mm
from .models import MindmapNode, OrderingResponse, ParticipantToken, PriorityScore, Run, Vote

# (days ago, participants) per run, older first.
EXAMPLE_RUNS = ((14, 9), (2, 12))

WORD_CLOUD_TERMS = [
    "Flexibilität", "flexibilität", "Selbstdisziplin", "Zeitmanagement",
    "Freiheit", "Videos", "Online", "online", "Motivation", "Einsamkeit",
]

OPEN_TEXT_ANSWERS = [
    "Man gibt keinen Namen an, die Antworten lassen sich niemandem zuordnen.",
    "Es werden keine persönlichen Daten wie Name oder IP-Adresse gespeichert.",
    "Niemand kann sehen, wer was geantwortet hat.",
    "Man kann ohne Konto teilnehmen.",
    "Keine Zuordnung zur Person möglich.",
]

# Mind-map example contributions: (canonical seed branch, term, indices of the
# contributing example tokens). "Beispiele" is contributed twice (merged).
MINDMAP_TERMS = [
    ("Inhalt", "Praxisbezug", (0,)),
    ("Inhalt", "Aktuelle Forschung", (1,)),
    ("Inhalt", "Klare Struktur", (2,)),
    ("Methoden", "Gruppenarbeit", (3,)),
    ("Methoden", "Beispiele", (4, 5)),
    ("Methoden", "Live-Umfragen", (6,)),
    ("Methoden", "Diskussion", (7,)),
]

# Relative weights for the 5 likert agreement steps (negative first).
LIKERT_WEIGHTS = [1, 2, 3, 5, 4]


def _answer(rng, run, question, token):
    """Store one invented answer of ``token`` to ``question`` in ``run``."""
    options = sorted(question.options.all(), key=lambda o: (o.position, o.pk))
    kind = question.kind
    if kind == Question.Kind.SINGLE_CHOICE:
        choice = rng.choices(options, weights=[6 if o.is_correct else 1 for o in options])[0]
        Vote.objects.create(run=run, question=question, token=token).options.set([choice])
    elif kind == Question.Kind.MULTIPLE_CHOICE:
        picked = [o for o in options if rng.random() < (0.8 if o.is_correct else 0.2)]
        if not picked:
            picked = [next((o for o in options if o.is_correct), options[0])]
        Vote.objects.create(run=run, question=question, token=token).options.set(picked)
    elif kind == Question.Kind.LIKERT:
        scale = [o for o in options if not o.is_abstention]
        weights = [LIKERT_WEIGHTS[i] if i < len(LIKERT_WEIGHTS) else 1 for i in range(len(scale))]
        abstain = [o for o in options if o.is_abstention]
        choice = rng.choices(scale + abstain, weights=weights + [1] * len(abstain))[0]
        Vote.objects.create(run=run, question=question, token=token).options.set([choice])
    elif kind == Question.Kind.WORD_CLOUD:
        Vote.objects.create(
            run=run, question=question, token=token, text=rng.choice(WORD_CLOUD_TERMS)
        )
    elif kind == Question.Kind.OPEN_TEXT:
        Vote.objects.create(
            run=run, question=question, token=token, text=rng.choice(OPEN_TEXT_ANSWERS)
        )
    elif kind == Question.Kind.PRIORITIES:
        # A row for EVERY option (incl. 0), total <= 100 — as the vote view stores it.
        raw = [rng.random() + (0.6 if i == 0 else 0) for i in range(len(options))]
        total = sum(raw)
        vote = Vote.objects.create(run=run, question=question, token=token)
        PriorityScore.objects.bulk_create(
            PriorityScore(vote=vote, option=o, points=int(100 * r / total))
            for o, r in zip(options, raw)
        )
    elif kind == Question.Kind.ORDERING:
        # Stored option order is the solution; most participants get it right.
        order = options if rng.random() < 0.6 else rng.sample(options, len(options))
        vote = Vote.objects.create(run=run, question=question, token=token)
        OrderingResponse.objects.bulk_create(
            OrderingResponse(vote=vote, option=o, position=i) for i, o in enumerate(order)
        )


def _seed_mindmap(run, question, tokens):
    """Materialise the question's branches for ``run`` and add the example
    terms of the tokens taking part (through the live helpers, so the tree is
    exactly what participants would have built)."""
    mm.ensure_seed(run, question)
    branches = {
        node.text: node
        for node in MindmapNode.objects.filter(run=run, question=question, seeded=True)
    }
    for branch, term, indices in MINDMAP_TERMS:
        for index in indices:
            if index < len(tokens):
                mm.add_term(run, question, tokens[index], branches[branch].pk, term)


def seed_example_results(question_set):
    """Create the two finished example runs (see module docstring)."""
    rng = random.Random(78)
    questions = list(question_set.questions.prefetch_related("options").order_by("position"))
    tokens = [
        ParticipantToken.objects.create(room=question_set.room)
        for _ in range(max(count for _, count in EXAMPLE_RUNS))
    ]
    now = timezone.now()
    for days_ago, participants in EXAMPLE_RUNS:
        started = now - timedelta(days=days_ago)
        ended = started + timedelta(minutes=20)
        run = Run.objects.create(
            question_set=question_set,
            phase=Run.Phase.FINISHED,
            first_opened_at=started,
            ended_at=ended,
        )
        for token in tokens[:participants]:
            for question in questions:
                if question.kind == Question.Kind.MINDMAP:
                    continue
                _answer(rng, run, question, token)
        for question in questions:
            if question.kind == Question.Kind.MINDMAP:
                _seed_mindmap(run, question, tokens[:participants])
        # auto_now_add/auto_now fields: back-date after the fact.
        Run.objects.filter(pk=run.pk).update(created_at=started, updated_at=ended)
        Vote.objects.filter(run=run).update(created_at=started)
