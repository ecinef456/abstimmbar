# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Live side (ADR-0002): Run, Vote, ParticipantToken.

Anonymity by design (concept §9): votes reference only an opaque
participant token — no user account, no IP, no fingerprint. The token's
sole purpose is preventing double votes within a run.
"""
import secrets
from typing import ClassVar

from django.db import models

from common.models import TimeStampedModel


def generate_token_key():
    return secrets.token_hex(16)


class ParticipantToken(models.Model):
    """Opaque per-room participant identity, issued on join.

    Stored client-side (localStorage); reused across runs so the
    "same code every session" bookmark flow works without re-joining.
    """

    room = models.ForeignKey("rooms.Room", on_delete=models.CASCADE, related_name="tokens")
    key = models.CharField(max_length=32, unique=True, default=generate_token_key)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"token …{self.key[-6:]} ({self.room.code})"


class Run(TimeStampedModel):
    """One live session of a question set (concept §3.1, „Durchführung").

    Teacher-paced phase machine, per Cliqr flow (1)–(4):
    lobby → preview (question on beamer only) → open (answerable) →
    closed → results → … → finished.
    """

    class Phase(models.TextChoices):
        LOBBY = "lobby", "Lobby"
        PREVIEW = "preview", "Question shown, not yet open"
        OPEN = "open", "Accepting votes"
        CLOSED = "closed", "Voting closed"
        RESULTS = "results", "Results on the beamer"
        FINISHED = "finished", "Finished"

    class Mode(models.TextChoices):
        LIVE = "live", "Teacher-paced (live)"
        # Self-paced quiz (concept §6.3): all questions open at once,
        # participants answer at their own pace with instant feedback.
        # Phases collapse to open → finished; active_question stays null.
        SELF_PACED = "self_paced", "Self-paced quiz"

    question_set = models.ForeignKey(
        "rooms.QuestionSet", on_delete=models.CASCADE, related_name="runs"
    )
    phase = models.CharField(max_length=10, choices=Phase.choices, default=Phase.LOBBY)
    mode = models.CharField(max_length=10, choices=Mode.choices, default=Mode.LIVE)
    active_question = models.ForeignKey(
        "rooms.Question", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    # When the active question was opened — basis for the countdown timer
    # (v2) and its server-side enforcement in the vote endpoint.
    opened_at = models.DateTimeField(null=True, blank=True)
    # When this run's *first* question was opened — names the result archive
    # ("Durchführung vom …", #17). Set once, never overwritten.
    first_opened_at = models.DateTimeField(null=True, blank=True)
    # #75: when a self-paced run has an overall time limit, the moment it ends.
    # Stamped once at first open; null = no overall limit.
    quiz_ends_at = models.DateTimeField(null=True, blank=True)
    # Presenter pressed "reveal correct answers" (v2): server state, so
    # participant devices can highlight in sync with the beamer.
    answers_revealed = models.BooleanField(default=False)
    # The presenter left the presentation (✕/Esc) without ending the run:
    # participant devices show „pausiert" (more questions may follow). Cleared
    # by any other presenter control and by (re)starting/resuming the run.
    presenter_away = models.BooleanField(default=False)
    ended_at = models.DateTimeField(null=True, blank=True)
    # Recording mode (#53): when set, this run is "recorded" — viewers of the
    # recording can vote later via a per-question deep link keyed by this token
    # (dedicated recording path, independent of the room's active run). Empty
    # token = not recorded. Non-guessable, like QuestionSet.share_token.
    recording_token = models.CharField(
        max_length=32, unique=True, null=True, blank=True, default=None
    )

    def enable_recording(self):
        """Mint a recording token (idempotent) so the run accepts async votes
        from recording viewers via /r/<token>/."""
        if not self.recording_token:
            self.recording_token = secrets.token_urlsafe(16)[:32]
            self.save(update_fields=["recording_token"])
        return self.recording_token

    def disable_recording(self):
        """Clear the recording token (idempotent) — a run started without
        recording must not stay in recording mode after being resumed."""
        if self.recording_token:
            self.recording_token = None
            self.save(update_fields=["recording_token", "updated_at"])

    class Meta:
        ordering: ClassVar = ["-created_at"]
        constraints: ClassVar = [
            # At most one unfinished run per question set — the presenter
            # either continues it or resets (concept §6.1 dialog).
            models.UniqueConstraint(
                fields=["question_set"],
                condition=~models.Q(phase="finished"),
                name="one_active_run_per_set",
            )
        ]

    @property
    def is_active(self):
        return self.phase != self.Phase.FINISHED

    def __str__(self):
        return f"Run #{self.pk} of {self.question_set} ({self.phase})"


class Vote(models.Model):
    """One participant's answer to one question within a run.

    Choice kinds store selected options (M2M); word clouds store raw text
    plus a casefolded key so spelling variants merge in the aggregation
    (review decision, July 2026).
    """

    class Source(models.TextChoices):
        ONSITE = "onsite", "On-site (live)"
        RECORDING = "recording", "Recording viewer (async, #53)"

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="votes")
    question = models.ForeignKey(
        "rooms.Question", on_delete=models.CASCADE, related_name="votes"
    )
    token = models.ForeignKey(ParticipantToken, on_delete=models.CASCADE, related_name="votes")
    # Recording mode (#53): distinguishes on-site (live) from recording-viewer
    # (async) votes so results can be split; both attribute to the same run.
    source = models.CharField(
        max_length=10, choices=Source.choices, default=Source.ONSITE
    )
    options = models.ManyToManyField("rooms.AnswerOption", blank=True, related_name="votes")
    text = models.CharField(max_length=500, blank=True)
    text_key = models.CharField(max_length=60, blank=True, db_index=True)
    # v2 KI: live free-text evaluation, filled by a background worker after
    # the vote is stored. Blank verdict = still pending / not evaluated.
    ai_verdict = models.CharField(max_length=40, blank=True, default="")
    ai_note = models.CharField(max_length=200, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    # The double-vote guard (one submission per participant/question/run) is
    # enforced in the vote view, not by a DB constraint: word clouds with
    # ``allow_multiple`` deliberately store several votes per token (#14).

    def save(self, *args, **kwargs):
        if self.question.kind == "word_cloud":
            # Word clouds: single short term, whitespace collapsed.
            self.text = " ".join(self.text.split())[:60]
        else:
            self.text = self.text.strip()[:500]
        self.text_key = self.text.casefold()[:60]
        super().save(*args, **kwargs)


class WordCloudModeration(TimeStampedModel):
    """Reversible curation overlay for a word cloud, per run + question (#Wortwolke).
    `hidden` holds casefold text_keys to drop; `merges` groups keys under a
    display label. The raw votes are never touched."""
    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="wc_moderations")
    question = models.ForeignKey("rooms.Question", on_delete=models.CASCADE)
    hidden = models.JSONField(default=list, blank=True)
    merges = models.JSONField(default=list, blank=True)

    class Meta:
        unique_together: ClassVar = [("run", "question")]


class PriorityScore(models.Model):
    """One participant's points for one option of a ``priorities`` question
    (#58). A submission stores a row for every option of the question,
    including 0, so per-option min/max are correct across all participants."""

    vote = models.ForeignKey(
        "Vote", on_delete=models.CASCADE, related_name="priority_scores"
    )
    option = models.ForeignKey(
        "rooms.AnswerOption",
        on_delete=models.CASCADE,
        related_name="priority_scores",
    )
    points = models.PositiveSmallIntegerField()

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(
                fields=["vote", "option"], name="one_score_per_vote_option"
            )
        ]

    def __str__(self):
        return f"{self.points} pts (vote {self.vote_id}, option {self.option_id})"


class OrderingResponse(models.Model):
    """One participant's assigned rank (0-based) for one option of an
    ``ordering`` question (#72). A submission stores a row per option; the
    correct rank is the option's own ``position`` (the editor's drag order)."""

    vote = models.ForeignKey(
        "Vote", on_delete=models.CASCADE, related_name="ordering_responses"
    )
    option = models.ForeignKey(
        "rooms.AnswerOption",
        on_delete=models.CASCADE,
        related_name="ordering_responses",
    )
    position = models.PositiveSmallIntegerField()

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(
                fields=["vote", "option"], name="one_ordering_per_vote_option"
            )
        ]

    def __str__(self):
        return f"pos {self.position} (vote {self.vote_id}, option {self.option_id})"


class SelfCheckAttempt(models.Model):
    """Anonymous counter row for a Lernkontrolle (#75 Phase 3): one row per
    completed attempt (or per single-question answer, then ``question`` is
    set). Deliberately carries no token/user/IP."""

    question_set = models.ForeignKey(
        "rooms.QuestionSet",
        on_delete=models.CASCADE,
        related_name="self_check_attempts",
    )
    question = models.ForeignKey(
        "rooms.Question",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    correct = models.PositiveIntegerField(default=0)
    scored = models.PositiveIntegerField(default=0)

    def __str__(self):
        return f"attempt on set {self.question_set_id} ({self.correct}/{self.scored})"


class MindmapNode(models.Model):
    """One term of a run's shared mind map (stage 1).

    ``parent`` null = a main branch directly below the root (the root itself
    is the question, not a row). Identical terms under the same parent merge:
    ``text_key`` (``rooms.mindmap.text_key``) is unique per run/question/parent
    (NULL parents included). ``seeded`` nodes come from the question's
    predefined branches and are never deleted by participants (nor are
    ``teacher`` nodes, added by the presenter); ``hidden`` is
    the presenter's reversible moderation (the subtree is hidden with it).
    The count of a node is its number of contributions — anonymous rows.
    """

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="mindmap_nodes")
    question = models.ForeignKey(
        "rooms.Question", on_delete=models.CASCADE, related_name="mindmap_nodes"
    )
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="children"
    )
    text = models.CharField(max_length=60)
    text_key = models.CharField(max_length=60)
    # Predefined-branch description (seeded nodes only); participants'
    # descriptions live on their contributions.
    description = models.CharField(max_length=200, blank=True, default="")
    seeded = models.BooleanField(default=False)
    # Seeded nodes only: the predefined branch's bilingual content,
    # ``{"text": {de, en}, "description": {de, en}}`` (content-i18n). ``text``/
    # ``text_key``/``description`` above stay the canonical language, so
    # participants' terms merge with a seeded node on the canonical term.
    seed_i18n = models.JSONField(default=dict, blank=True)
    # Added by the presenter (stage 2 moderation, "+" on the beamer): like a
    # seeded node it is never deleted by participants' withdrawals and costs
    # nobody quota (it carries no contribution). Kept apart from ``seeded``
    # because ``ensure_seed`` keys its idempotency on seeded rows and only
    # teacher nodes may be deleted again (exact undo of an add).
    teacher = models.BooleanField(default=False)
    hidden = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(
                fields=["run", "question", "parent", "text_key"],
                nulls_distinct=False,
                name="one_mindmap_node_per_parent_key",
            )
        ]

    def __str__(self):
        return f"{self.text} (run {self.run_id})"


class MindmapContribution(models.Model):
    """One participant's contribution of a mind-map term (anonymous: only the
    opaque token, used for the per-person cap and own-withdrawal)."""

    node = models.ForeignKey(
        MindmapNode, on_delete=models.CASCADE, related_name="contributions"
    )
    token = models.ForeignKey(
        ParticipantToken, on_delete=models.CASCADE, related_name="mindmap_contributions"
    )
    description = models.CharField(max_length=200, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(
                fields=["node", "token"], name="one_mindmap_contribution_per_token"
            )
        ]


class MindmapPhase(models.Model):
    """The stage of a mind-map question within one run (rating phase).

    A separate row per run + question keeps the run's phase machine
    (``Run.phase``) untouched: the stage is orthogonal to it — "collect"
    (participants add terms) or "rate" (participants rate the entries; no new
    terms). No row = "collect". Only meaningful while the question has a
    rating mode (``Question.mindmap_rating_mode``); with the mode off the
    question behaves as "collect" whatever is stored here.
    """

    class Stage(models.TextChoices):
        COLLECT = "collect", "Collecting terms"
        RATE = "rate", "Rating the entries"

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="mindmap_phases")
    question = models.ForeignKey(
        "rooms.Question", on_delete=models.CASCADE, related_name="+"
    )
    stage = models.CharField(max_length=10, choices=Stage.choices, default=Stage.COLLECT)
    # Last time the rating stage was (re)started.
    rating_started_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(
                fields=["run", "question"], name="one_mindmap_phase_per_run_question"
            )
        ]


class MindmapRating(models.Model):
    """One participant's rating of one mind-map entry (anonymous: only the
    opaque token, for the budget and "my ratings"). ``points`` mode: ``value``
    = number of points (>= 1); ``updown`` mode: +1 or -1. A rating at 0 is no
    row. Deleted with its node; kept (but not counted) while it is hidden."""

    node = models.ForeignKey(MindmapNode, on_delete=models.CASCADE, related_name="ratings")
    token = models.ForeignKey(
        ParticipantToken, on_delete=models.CASCADE, related_name="mindmap_ratings"
    )
    value = models.SmallIntegerField()

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(fields=["node", "token"], name="one_mindmap_rating_per_token")
        ]


class MatrixCard(models.Model):
    """One card on a run's four-field matrix board (see ``live.matrix``).

    ``token`` is null for presenter-added cards (``teacher``). ``stack`` points
    to the top card of the stack this card belongs to (null = a single card or
    a top); members keep their own coordinates but render at their top's
    position. ``placed`` marks cards moved by the presenter (never
    auto-moved). ``hidden`` is the presenter's reversible moderation.
    ``summary`` marks a summary card of the AI grouping (always ``teacher``).
    """

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="matrix_cards")
    question = models.ForeignKey(
        "rooms.Question", on_delete=models.CASCADE, related_name="matrix_cards"
    )
    token = models.ForeignKey(
        ParticipantToken,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="matrix_cards",
    )
    title = models.CharField(max_length=60)
    description = models.CharField(max_length=200, blank=True, default="")
    category = models.CharField(max_length=16, blank=True, default="")
    zone = models.CharField(max_length=10)
    x = models.FloatField()
    y = models.FloatField()
    placed = models.BooleanField(default=False)
    stack = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="members"
    )
    hidden = models.BooleanField(default=False)
    teacher = models.BooleanField(default=False)
    # A presenter card created by the AI grouping on top of its stack; it is
    # deleted when its stack is dissolved by hand, unless rated (see
    # ``live.matrix._detach``). Put under another card (dragged, or a second
    # summary in an AI group) it loses the flag unless rated.
    summary = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering: ClassVar = ["created_at", "pk"]
        indexes: ClassVar = [models.Index(fields=["run", "question"], name="matrixcard_run_question")]

    def __str__(self):
        return f"{self.title} (run {self.run_id})"


class MatrixPhase(models.Model):
    """The stage of a matrix question within one run (rating phase) — the
    counterpart of ``MindmapPhase``: "collect" (participants add cards) or
    "rate" (participants rate the visible top cards). No row = "collect"."""

    class Stage(models.TextChoices):
        COLLECT = "collect", "Collecting cards"
        RATE = "rate", "Rating the cards"

    run = models.ForeignKey(Run, on_delete=models.CASCADE, related_name="matrix_phases")
    question = models.ForeignKey(
        "rooms.Question", on_delete=models.CASCADE, related_name="+"
    )
    stage = models.CharField(max_length=10, choices=Stage.choices, default=Stage.COLLECT)
    # Last time the rating stage was (re)started.
    rating_started_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(
                fields=["run", "question"], name="one_matrix_phase_per_run_question"
            )
        ]


class MatrixRating(models.Model):
    """One participant's rating of one matrix card (anonymous: only the opaque
    token). ``points`` mode: ``value`` = number of points (>= 1); ``updown``
    mode: +1 or -1. A rating at 0 is no row. Kept (but not counted) while the
    card is hidden or a stack member. The unique (card, token) constraint also
    indexes ``card``."""

    card = models.ForeignKey(MatrixCard, on_delete=models.CASCADE, related_name="ratings")
    token = models.ForeignKey(
        ParticipantToken, on_delete=models.CASCADE, related_name="matrix_ratings"
    )
    value = models.SmallIntegerField()

    class Meta:
        constraints: ClassVar = [
            models.UniqueConstraint(fields=["card", "token"], name="one_matrix_rating_per_token")
        ]
