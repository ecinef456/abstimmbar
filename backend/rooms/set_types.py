# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Declarative rules per QuestionSet.type (#75): which question kinds a set of
each type may contain. Run style per type: live poll = teacher-started live
run, self-paced = participants work through it on their own, self-check =
standing link with no teacher-started run. (A free-text question without a
model solution is allowed everywhere; the editor only warns for self-checks.) Adding a new set type is one entry here (+ the frontend mirror in
`frontend/src/setTypes.ts`). Kept as data, not scattered if-branches."""

from .models import Question, QuestionSet

_ALL_KINDS = tuple(kind for kind, _ in Question.Kind.choices)

SET_TYPES = {
    QuestionSet.SetType.LIVE_POLL: {
        "allowed_kinds": _ALL_KINDS,
    },
    QuestionSet.SetType.SELF_PACED: {
        # Mindmap and matrix are shared, presenter-driven activities: live
        # polls only.
        "allowed_kinds": tuple(
            k for k in _ALL_KINDS
            if k not in (Question.Kind.MINDMAP, Question.Kind.MATRIX)
        ),
    },
    QuestionSet.SetType.SELF_CHECK: {
        # Only kinds with an auto-checkable answer / shown solution.
        "allowed_kinds": ("single_choice", "multiple_choice", "ordering", "open_text"),
    },
}


def _rules(set_type):
    return SET_TYPES.get(set_type, SET_TYPES[QuestionSet.SetType.LIVE_POLL])


def allowed_kinds(set_type) -> tuple:
    return _rules(set_type)["allowed_kinds"]

