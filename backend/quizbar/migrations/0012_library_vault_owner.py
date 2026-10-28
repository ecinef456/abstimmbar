# SPDX-License-Identifier: Apache-2.0
"""The library's hidden set becomes editable by its teacher, and quizzes
imported by the first version of "Import Typst quizzes (.zip)" (an
archived room "Library imports") move into the library itself."""
from django.db import migrations


def forwards(apps, schema_editor):
    LibraryVault = apps.get_model("quizbar", "LibraryVault")
    Room = apps.get_model("rooms", "Room")
    QuestionSet = apps.get_model("rooms", "QuestionSet")
    for vault in LibraryVault.objects.all():
        Room.objects.get(pk=vault.room_id).owners.add(vault.owner_id)
        # shown in the editor's breadcrumb now that it can be opened
        titles = {"title": "Question library", "title_de": "Question library", "title_en": "Question library"}
        Room.objects.filter(pk=vault.room_id).update(**titles)
        QuestionSet.objects.filter(pk=vault.question_set_id).update(**titles)

    import_rooms = list(
        Room.objects.filter(title="Library imports", owner__isnull=False).values_list("pk", flat=True)
    )
    if not import_rooms:
        return
    # Rare and one-off: done with the app's own code.
    from quizbar import library
    from quizbar.models import LibraryEntry, QuestionLineage
    from rooms.models import Question
    from rooms.models import Room as RealRoom

    for room in RealRoom.objects.filter(pk__in=import_rooms).select_related("owner"):
        owner = room.owner
        vault = library.vault_for(owner)
        position = vault.questions.count()
        questions = Question.objects.filter(question_set__room=room).order_by(
            "question_set_id", "position", "id"
        )
        for question in list(questions):
            Question.objects.filter(pk=question.pk).update(
                question_set=vault, section=None, position=position
            )
            position += 1
            if not QuestionLineage.objects.filter(question_id=question.pk).exists():
                entry = LibraryEntry.objects.create(owner=owner, master_id=question.pk)
                QuestionLineage.objects.create(question_id=question.pk, entry=entry)
        room.delete()


class Migration(migrations.Migration):
    dependencies = [
        ("quizbar", "0011_peer_confidence"),
        ("rooms", "0058_generationjob_unsuitable_reason"),
    ]

    operations = [migrations.RunPython(forwards, migrations.RunPython.noop)]
