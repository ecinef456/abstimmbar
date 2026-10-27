# SPDX-License-Identifier: Apache-2.0
"""Create a course room with week folders (see quizbar/course.py).

    python manage.py quizbar_course --owner vkusar --title "0000 - TEMPLATE" --archived
    python manage.py quizbar_course --owner vkusar --title "HS26 - TA - Physics"
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from quizbar import course


class Command(BaseCommand):
    help = "Create a room with week folders: 4 live polls and an auto-filled self-check each."

    def add_arguments(self, parser):
        parser.add_argument("--owner", required=True, help="Username of the room's owner.")
        parser.add_argument("--title", required=True, help="Room title.")
        parser.add_argument("--weeks", type=int, default=14, help="Number of weeks (default 14).")
        parser.add_argument(
            "--language",
            default="en",
            choices=["de", "en", "fr", "none"],
            help="Room language (default en; none = each viewer's own).",
        )
        parser.add_argument(
            "--archived", action="store_true", help="Archive the room for the owner (template)."
        )

    def handle(self, *args, **options):
        user = get_user_model().objects.filter(username=options["owner"]).first()
        if user is None:
            raise CommandError(f"No user {options['owner']!r}.")
        if not 1 <= options["weeks"] <= 52:
            raise CommandError("--weeks must be between 1 and 52.")
        room = course.create_course(
            user,
            options["title"],
            weeks=options["weeks"],
            archived=options["archived"],
            language="" if options["language"] == "none" else options["language"],
        )
        state = " (archived)" if options["archived"] else ""
        self.stdout.write(
            self.style.SUCCESS(
                f"Created room {room.title!r}{state}, code {room.code}, "
                f"{options['weeks']} week folders."
            )
        )
