# SPDX-License-Identifier: Apache-2.0
from django.db import models


class OptionJustification(models.Model):
    """Why an answer option is right or wrong (shown with J / in feedback).

    Plain text with Typst/LaTeX math; one per option, kept in our own table
    so the upstream AnswerOption model stays untouched.
    """

    option = models.OneToOneField(
        "rooms.AnswerOption", on_delete=models.CASCADE, related_name="qb_justification"
    )
    text = models.TextField(blank=True, default="")

    def __str__(self):
        return f"justification for option {self.option_id}"


class RunJustification(models.Model):
    """Which question of a live run currently shows its justifications.

    A pointer instead of a flag: moving to another question hides them
    automatically, and un-revealing the answers (E) hides them too.
    """

    run = models.OneToOneField(
        "live.Run", on_delete=models.CASCADE, related_name="qb_justification"
    )
    question = models.ForeignKey(
        "rooms.Question", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )

    def __str__(self):
        return f"run {self.run_id}: justification of question {self.question_id}"


class RoomLanguage(models.Model):
    """The language of a room: its content and everything participants see
    (participant pages; the beamer while presenting). Unset = each viewer's
    own language, as upstream."""

    LANGUAGES = (("de", "Deutsch"), ("en", "English"), ("fr", "Français"))

    room = models.OneToOneField(
        "rooms.Room", on_delete=models.CASCADE, related_name="qb_language"
    )
    language = models.CharField(max_length=8, choices=LANGUAGES)

    def __str__(self):
        return f"room {self.room_id}: {self.language}"


class SetFolder(models.Model):
    """A folder of question sets inside a room (e.g. one per week).

    ``ordered``: the sets have a fixed sequence (shown numbered "1 – …"),
    which the presenter's "Next quiz" button follows; otherwise they are
    listed with the room's normal sort.
    """

    room = models.ForeignKey("rooms.Room", on_delete=models.CASCADE, related_name="qb_folders")
    title = models.CharField(max_length=200)
    ordered = models.BooleanField(default=True)
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("position", "id")

    def __str__(self):
        return self.title


class SetPlacement(models.Model):
    """Which folder a question set is in, and where (sets without one are
    "not in a folder"). Deleting the folder deletes the placements only."""

    question_set = models.OneToOneField(
        "rooms.QuestionSet", on_delete=models.CASCADE, related_name="qb_placement"
    )
    folder = models.ForeignKey(SetFolder, on_delete=models.CASCADE, related_name="placements")
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ("position", "id")

    def __str__(self):
        return f"set {self.question_set_id} in folder {self.folder_id}"
