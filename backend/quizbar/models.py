# SPDX-License-Identifier: Apache-2.0
from django.conf import settings
from django.db import models
from django.db.models.functions import Lower


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


class SelfCheckSource(models.Model):
    """A set whose questions a self-check copies automatically, in order."""

    self_check = models.ForeignKey(
        "rooms.QuestionSet", on_delete=models.CASCADE, related_name="qb_sources"
    )
    source = models.ForeignKey(
        "rooms.QuestionSet", on_delete=models.CASCADE, related_name="qb_feeds"
    )
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ("position", "id")
        constraints = (
            models.UniqueConstraint(fields=("self_check", "source"), name="qb_unique_source"),
        )


class SyncedQuestion(models.Model):
    """A self-check question copied from ``source`` (kept in place on sync,
    so per-question attempt statistics survive edits of the original)."""

    copy = models.OneToOneField(
        "rooms.Question", on_delete=models.CASCADE, related_name="qb_synced_from"
    )
    source = models.ForeignKey(
        "rooms.Question", on_delete=models.SET_NULL, null=True, related_name="+"
    )


class SyncedSection(models.Model):
    """A self-check section standing for one source set."""

    section = models.OneToOneField(
        "rooms.Section", on_delete=models.CASCADE, related_name="qb_synced_from"
    )
    source_set = models.ForeignKey(
        "rooms.QuestionSet", on_delete=models.SET_NULL, null=True, related_name="+"
    )


class SelfCheckState(models.Model):
    """Fingerprint of the sources at the last sync (skip unchanged ones)."""

    self_check = models.OneToOneField(
        "rooms.QuestionSet", on_delete=models.CASCADE, related_name="qb_sync_state"
    )
    fingerprint = models.CharField(max_length=64, blank=True, default="")


class LibraryTag(models.Model):
    """A tag of the question library (one teacher's own vocabulary)."""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="qb_library_tags"
    )
    name = models.CharField(max_length=60)

    class Meta:
        ordering = ("name", "id")
        constraints = (
            models.UniqueConstraint(Lower("name"), "owner", name="qb_unique_tag"),
        )

    def __str__(self):
        return self.name


class LibraryEntry(models.Model):
    """One question of the library, however many copies of it exist.

    ``master`` is the copy the library shows (the first one written, or the
    most recently edited survivor once it is deleted). All copies belong to
    the entry through ``QuestionLineage``, so copying never adds entries.
    """

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="qb_library"
    )
    master = models.ForeignKey(
        "rooms.Question", on_delete=models.SET_NULL, null=True, related_name="+"
    )
    tags = models.ManyToManyField(LibraryTag, blank=True, related_name="entries")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at", "-id")


class QuestionLineage(models.Model):
    """Which library entry a question is a copy of."""

    question = models.OneToOneField(
        "rooms.Question", on_delete=models.CASCADE, related_name="qb_lineage"
    )
    entry = models.ForeignKey(LibraryEntry, on_delete=models.CASCADE, related_name="members")


class LibraryVault(models.Model):
    """A hidden room/set per teacher that keeps library questions whose
    last copy was deleted (so deleting a set never empties the library)."""

    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="qb_library_vault"
    )
    room = models.OneToOneField(
        "rooms.Room", on_delete=models.CASCADE, related_name="qb_library_vault"
    )
    question_set = models.OneToOneField(
        "rooms.QuestionSet", on_delete=models.CASCADE, related_name="qb_library_vault"
    )


class SetGame(models.Model):
    """Game mode (Kahoot style) for a live poll: nicknames, points for fast
    correct answers, leaderboard and podium."""

    question_set = models.OneToOneField(
        "rooms.QuestionSet", on_delete=models.CASCADE, related_name="qb_game"
    )
    enabled = models.BooleanField(default=True)


class GameEntry(models.Model):
    """A participant playing one run under a nickname."""

    run = models.ForeignKey("live.Run", on_delete=models.CASCADE, related_name="qb_players")
    token = models.ForeignKey(
        "live.ParticipantToken", on_delete=models.CASCADE, related_name="qb_games"
    )
    nickname = models.CharField(max_length=20)
    # A physicist (quizbar/avatars.py); "" = none.
    avatar = models.CharField(max_length=30, blank=True, default="")
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("joined_at", "id")
        constraints = (
            models.UniqueConstraint(fields=("run", "token"), name="qb_one_entry_per_token"),
            models.UniqueConstraint(Lower("nickname"), "run", name="qb_unique_nickname"),
        )


class GameQuestion(models.Model):
    """When a question of a game run was first opened (basis of the speed
    points)."""

    run = models.ForeignKey("live.Run", on_delete=models.CASCADE, related_name="qb_game_questions")
    question = models.ForeignKey("rooms.Question", on_delete=models.CASCADE, related_name="+")
    opened_at = models.DateTimeField()

    class Meta:
        ordering = ("opened_at", "id")
        constraints = (
            models.UniqueConstraint(fields=("run", "question"), name="qb_game_question_once"),
        )
