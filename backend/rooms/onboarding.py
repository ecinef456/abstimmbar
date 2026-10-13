# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Seed a ready-made example room for a user's first login (#78).

A brand-new (or pre-existing, pre-#78) account has nothing to do until it
creates a room and a question set. ``seed_example_room`` gives every user one
example room, owned by them, containing one question of *every* kind — so
the editor structure and every participant/presenter view are explorable
immediately, without having to invent content first.

Called from ``accounts.views.whoami`` guarded by ``User.onboarded`` (a
one-time, race-safe flag) — see that module for the locking pattern. Content
is bilingual (de/en): every translatable field is set via its explicit
``*_de``/``*_en`` columns, never the bare (UI-language-following) accessor.
Since the guided tour v3.1 it also seeds two finished example runs
(``live.onboarding``) so the results views are explorable.
"""
from django.db import transaction

from .models import AnswerOption, Question, QuestionSet, Room


def _p(text_de: str, text_en: str) -> tuple:
    """Wrap plain text in a paragraph, matching the WYSIWYG editor's output
    (rooms.sanitize / ADR-0007), for the two Question.text_* columns."""
    return f"<p>{text_de}</p>", f"<p>{text_en}</p>"


@transaction.atomic
def seed_example_room(user) -> Room:
    """Create one example room (with one set, one question per kind) owned
    by ``user``. Idempotency is the caller's responsibility (User.onboarded)."""
    room = Room.objects.create(
        created_by=user,
        updated_by=user,
        owner=user,
        is_example=True,
        title_de="Beispielraum – zum Ausprobieren",
        title_en="Example room – try things out",
        description_de=(
            "Ein automatisch angelegter Beispielraum mit je einer Frage "
            "jedes Typs. Schauen Sie sich um, probieren Sie die Präsentation aus und "
            "löschen Sie den Raum, wenn Sie bereit sind."
        ),
        description_en=(
            "An automatically created example room with one question of "
            "each type. Look around, try the presentation, and delete this "
            "room whenever you're ready."
        ),
    )
    room.owners.add(user)

    question_set = QuestionSet.objects.create(
        room=room,
        title_de="Beispiel-Fragenset",
        title_en="Example question set",
        description_de="Ein Beispiel für jeden Fragetyp – zum Ausprobieren.",
        description_en="One example of every question type — try them out.",
    )

    position = 0

    # single_choice: a simple factual question, one correct option.
    text_de, text_en = _p(
        "Wie viele Kontinente hat die Erde?", "How many continents does Earth have?"
    )
    single_choice = Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.SINGLE_CHOICE,
        text_de=text_de,
        text_en=text_en,
        position=position,
    )
    for i, (option_de, option_en, correct) in enumerate(
        [("5", "5", False), ("7", "7", True), ("9", "9", False)]
    ):
        AnswerOption.objects.create(
            question=single_choice,
            text_de=option_de,
            text_en=option_en,
            is_correct=correct,
            position=i,
        )
    position += 1

    # multiple_choice: allow_multiple, at least two correct options.
    text_de, text_en = _p(
        "Welche der folgenden sind Programmiersprachen?",
        "Which of the following are programming languages?",
    )
    multiple_choice = Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.MULTIPLE_CHOICE,
        text_de=text_de,
        text_en=text_en,
        allow_multiple=True,
        position=position,
    )
    for i, (option_de, option_en, correct) in enumerate(
        [
            ("Python", "Python", True),
            ("Java", "Java", True),
            ("HTML", "HTML", False),
            ("Elefant", "Elephant", False),
        ]
    ):
        AnswerOption.objects.create(
            question=multiple_choice,
            text_de=option_de,
            text_en=option_en,
            is_correct=correct,
            position=i,
        )
    position += 1

    # likert: negative-first 5-point agreement scale + a trailing abstention.
    # Like the editor's "agreement" preset, only the two endpoints carry text;
    # the middle steps stay empty (rendered as plain scale points).
    text_de, text_en = _p(
        "Ich fühle mich in dieser Veranstaltung gut aufgehoben.",
        "I feel well supported in this course.",
    )
    likert = Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.LIKERT,
        text_de=text_de,
        text_en=text_en,
        position=position,
    )
    likert_scale = [
        ("Stimme nicht zu", "Disagree"),
        ("", ""),
        ("", ""),
        ("", ""),
        ("Stimme zu", "Agree"),
    ]
    for i, (option_de, option_en) in enumerate(likert_scale):
        AnswerOption.objects.create(
            question=likert,
            text_de=option_de,
            text_en=option_en,
            position=i,
        )
    AnswerOption.objects.create(
        question=likert,
        text_de="Enthaltung",
        text_en="Abstain",
        is_abstention=True,
        position=len(likert_scale),
    )
    position += 1

    # word_cloud: no options, just a bilingual prompt.
    text_de, text_en = _p(
        "Was fällt Ihnen spontan zum Thema Fernstudium ein?",
        "What comes to mind when you think of distance learning?",
    )
    Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.WORD_CLOUD,
        text_de=text_de,
        text_en=text_en,
        # Editor default (#88): up to 5 terms per participant.
        allow_multiple=True,
        wordcloud_max_answers=5,
        position=position,
    )
    position += 1

    # open_text: no options, a bilingual prompt + short model solution.
    text_de, text_en = _p(
        "Erklären Sie kurz, was eine anonyme Umfrage auszeichnet.",
        "Briefly explain what makes a survey anonymous.",
    )
    Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.OPEN_TEXT,
        text_de=text_de,
        text_en=text_en,
        # model_solution is NOT registered in rooms.translation (single-
        # valued authoring aid, like evaluation_hint) — one plain value in
        # the canonical content language, not a de/en pair.
        model_solution=(
            "Es werden keine Rückschlüsse auf die antwortende Person gezogen, "
            "z. B. keine Namen oder IP-Adressen gespeichert."
        ),
        position=position,
    )
    position += 1

    # priorities: items to rank; order of creation is irrelevant here.
    text_de, text_en = _p(
        "Bringen Sie die folgenden Kriterien in Ihre persönliche Prioritätenreihenfolge.",
        "Rank the following criteria in your personal order of priority.",
    )
    priorities = Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.PRIORITIES,
        text_de=text_de,
        text_en=text_en,
        position=position,
    )
    for i, (option_de, option_en) in enumerate(
        [
            ("Verständlichkeit", "Clarity"),
            ("Tempo", "Pace"),
            ("Praxisbezug", "Practical relevance"),
            ("Interaktivität", "Interactivity"),
        ]
    ):
        AnswerOption.objects.create(
            question=priorities,
            text_de=option_de,
            text_en=option_en,
            position=i,
        )
    position += 1

    # ordering: the stored position IS the correct order (server shuffles
    # for participants).
    text_de, text_en = _p(
        "Bringen Sie die Schritte der wissenschaftlichen Methode in die richtige Reihenfolge.",
        "Put the steps of the scientific method in the correct order.",
    )
    ordering = Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.ORDERING,
        text_de=text_de,
        text_en=text_en,
        position=position,
    )
    for i, (option_de, option_en) in enumerate(
        [
            ("Frage stellen", "Ask a question"),
            ("Hypothese aufstellen", "Form a hypothesis"),
            ("Experiment durchführen", "Run an experiment"),
            ("Ergebnisse auswerten", "Analyze the results"),
        ]
    ):
        AnswerOption.objects.create(
            question=ordering,
            text_de=option_de,
            text_en=option_en,
            position=i,
        )
    position += 1

    # mindmap: shared tree with two predefined branches (bilingual seed);
    # no rating phase, AI switch off. Example contributions: live.onboarding.
    text_de, text_en = _p(
        "Was gehört zu einer guten Lehrveranstaltung?",
        "What makes a good course?",
    )
    Question.objects.create(
        question_set=question_set,
        kind=Question.Kind.MINDMAP,
        text_de=text_de,
        text_en=text_en,
        mindmap_root_de="Gute Lehre",
        mindmap_root_en="Good teaching",
        mindmap_seed=[
            {
                "text": {"de": "Inhalt", "en": "Content"},
                "description": {"de": "", "en": ""},
                "children": [],
            },
            {
                "text": {"de": "Methoden", "en": "Methods"},
                "description": {"de": "", "en": ""},
                "children": [],
            },
        ],
        position=position,
    )

    # Example results (guided tour): two finished runs with invented answers.
    # Imported here — live depends on rooms, not the other way round.
    from live.onboarding import seed_example_results

    seed_example_results(question_set)

    return room
