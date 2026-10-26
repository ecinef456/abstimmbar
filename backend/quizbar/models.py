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
