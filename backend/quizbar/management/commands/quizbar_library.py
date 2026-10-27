# SPDX-License-Identifier: Apache-2.0
"""Put a teacher's existing questions into the question library (once,
after installing the library; new questions join it by themselves).

    python manage.py quizbar_library --owner vkusar
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from quizbar import library


class Command(BaseCommand):
    help = "Add a teacher's existing questions to the library (identical ones merged)."

    def add_arguments(self, parser):
        parser.add_argument("--owner", required=True, help="Username of the teacher.")

    def handle(self, *args, **options):
        user = get_user_model().objects.filter(username=options["owner"]).first()
        if user is None:
            raise CommandError(f"No user {options['owner']!r}.")
        created, joined = library.backfill(user)
        self.stdout.write(
            self.style.SUCCESS(
                f"{created} questions added to the library; {joined} identical copies "
                "linked to them (they appear once)."
            )
        )
