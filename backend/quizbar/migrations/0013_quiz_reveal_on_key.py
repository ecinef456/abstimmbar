# SPDX-License-Identifier: Apache-2.0
"""The quizzes of course rooms ("Week N – Quiz 1/2") show the correct answer
only when the presenter reveals it (key L), not with the results. New course
rooms get this from ``course.WEEK_SETS``; this updates the existing ones."""
import re

from django.db import migrations

QUIZ = re.compile(r"^Week \d+ – Quiz \d+$")


def forwards(apps, schema_editor):
    QuestionSet = apps.get_model("rooms", "QuestionSet")
    sets = QuestionSet.objects.filter(
        type="live_poll", reveal_answers="immediately", qb_placement__isnull=False
    ).only("pk", "title", "title_de", "title_en")
    quiz_ids = [
        question_set.pk
        for question_set in sets
        if any(QUIZ.match(t or "") for t in (question_set.title_de, question_set.title_en, question_set.title))
    ]
    QuestionSet.objects.filter(pk__in=quiz_ids).update(reveal_answers="after_close")


class Migration(migrations.Migration):
    dependencies = [
        ("quizbar", "0012_library_vault_owner"),
    ]

    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
