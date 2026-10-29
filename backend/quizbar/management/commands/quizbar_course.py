# SPDX-License-Identifier: Apache-2.0
"""Create a course room with week folders (see quizbar/course.py).

    python manage.py quizbar_course --owner <username> --title "0000 - TEMPLATE" --archived
    python manage.py quizbar_course --owner <username> --title "HS26 - TA - Physics"

Bring an existing course room up to date (adds the missing quizzes, never
removes anything):

    python manage.py quizbar_course --owner <username> --title "0000 - TEMPLATE" --update
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from quizbar import course


class Command(BaseCommand):
    help = (
        "Create a room with week folders (Activators PRE, Quiz 1-10, Activators POST and an "
        "auto-filled self-check each), or --update an existing one."
    )

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
        parser.add_argument(
            "--update",
            action="store_true",
            help="Update the owner's existing room with this title instead of creating one.",
        )

    def handle(self, *args, **options):
        user = get_user_model().objects.filter(username=options["owner"]).first()
        if user is None:
            raise CommandError(f"No user {options['owner']!r}.")
        if options["update"]:
            self.update(user, options["title"])
            return
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

    def update(self, user, title):
        from django.conf import settings

        from rooms.models import Room

        column = f"title_{settings.MODELTRANSLATION_DEFAULT_LANGUAGE}"
        rooms = list(Room.objects.filter(owners=user, **{column: title}))
        if len(rooms) != 1:
            raise CommandError(f"{len(rooms)} rooms of {user.username!r} are called {title!r}; need exactly one.")
        result = course.update_course(rooms[0])
        self.stdout.write(
            self.style.SUCCESS(
                f"Updated room {title!r}: {result['added']} quiz sets added, "
                f"settings of {result['settings']} unused sets updated. Nothing was removed."
            )
        )
