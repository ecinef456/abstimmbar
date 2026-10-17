# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

import json
import threading
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone, translation

from common.i18n_fields import resolve_translated_text, translated_map
from common.models import SiteConfig
from rooms.models import AnswerOption, Question, QuestionSet, Room

from . import ai_evaluation, ai_freetext_summary, ai_wordcloud, ai_wordcloud_live
from . import matrix as mxs
from .matrix import MatrixError, zone_at
from .mindmap import answered_runs_q
from .models import (
    MatrixCard,
    MatrixRating,
    MindmapContribution,
    MindmapNode,
    ParticipantToken,
    Run,
    SelfCheckAttempt,
    Vote,
)
from .results import freetext_evaluation
from .state import active_run, build_payloads

User = get_user_model()

# The dev container may carry a real .env; force AI on/off explicitly.
AI_ON = {
    "AI_PROVIDER": "litellm",
    "AI_BASE_URL": "https://llm.test/v1",
    "AI_API_KEY": "secret",
    "AI_MODEL": "test-model",
}
AI_OFF = {"AI_PROVIDER": "none", "AI_BASE_URL": "", "AI_API_KEY": "", "AI_MODEL": ""}


class LiveTestCase(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="frank")
        self.room = Room.objects.create(title="Bio 101")
        self.room.owners.add(self.owner)
        self.question_set = QuestionSet.objects.create(room=self.room, title="Termin 1")
        self.question = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE,
            text="<p>2+2?</p>",
        )
        self.correct = AnswerOption.objects.create(
            question=self.question, text="4", is_correct=True, position=0
        )
        self.wrong = AnswerOption.objects.create(
            question=self.question, text="5", position=1
        )

    def join(self):
        response = self.client.post(
            f"/api/live/rooms/{self.room.code}/join/", {}, content_type="application/json"
        )
        return response.json()["token"]

    def open_question(self, question=None):
        run = Run.objects.create(
            question_set=self.question_set,
            phase=Run.Phase.OPEN,
            active_question=question or self.question,
        )
        return run

    def vote(self, token, **payload):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/vote/",
            {"token": token, **payload},
            content_type="application/json",
        )


class JoinTests(LiveTestCase):
    def test_join_issues_and_reuses_token(self):
        token = self.join()
        self.assertEqual(ParticipantToken.objects.count(), 1)
        response = self.client.post(
            f"/api/live/rooms/{self.room.code}/join/",
            {"token": token},
            content_type="application/json",
        )
        self.assertEqual(response.json()["token"], token)
        self.assertEqual(ParticipantToken.objects.count(), 1)

    def test_unknown_room_404(self):
        response = self.client.post(
            "/api/live/rooms/00000000/join/", {}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 404)

    def test_word_code_join_is_case_insensitive(self):
        # Word codes are stored lowercase; a participant may type any case.
        response = self.client.post(
            f"/api/live/rooms/{self.room.code.upper()}/join/",
            {}, content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(ParticipantToken.objects.get().room, self.room)


class VoteTests(LiveTestCase):
    def test_vote_happy_path(self):
        token = self.join()
        self.open_question()
        response = self.vote(token, options=[self.correct.pk])
        self.assertEqual(response.status_code, 201)
        vote = Vote.objects.get()
        self.assertEqual(list(vote.options.all()), [self.correct])

    def test_double_vote_conflicts(self):
        token = self.join()
        self.open_question()
        self.vote(token, options=[self.correct.pk])
        response = self.vote(token, options=[self.wrong.pk])
        self.assertEqual(response.status_code, 409)
        self.assertEqual(Vote.objects.count(), 1)

    def test_vote_requires_open_phase(self):
        token = self.join()
        run = self.open_question()
        run.phase = Run.Phase.CLOSED
        run.save()
        self.assertEqual(self.vote(token, options=[self.correct.pk]).status_code, 409)

    def test_single_choice_rejects_multiple_options(self):
        token = self.join()
        self.open_question()
        response = self.vote(token, options=[self.correct.pk, self.wrong.pk])
        self.assertEqual(response.status_code, 400)

    def test_rejects_option_of_other_question(self):
        other_question = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE
        )
        foreign = AnswerOption.objects.create(question=other_question, text="x")
        token = self.join()
        self.open_question()
        self.assertEqual(self.vote(token, options=[foreign.pk]).status_code, 400)

    def test_word_cloud_multiple_answers(self):
        # allow_multiple word clouds accept several terms from one token (#14);
        # a plain word cloud still rejects the second submission.
        cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            allow_multiple=True,
        )
        self.open_question(cloud)
        token = self.join()
        self.assertEqual(self.vote(token, text="Klima").status_code, 201)
        self.assertEqual(self.vote(token, text="Wasser").status_code, 201)
        # One term per person: the same word again (any case) is rejected.
        self.assertEqual(self.vote(token, text="  klima ").status_code, 409)
        self.assertEqual(Vote.objects.filter(token__key=token).count(), 2)

        plain = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
        )
        Run.objects.update(phase=Run.Phase.FINISHED)
        self.open_question(plain)
        token2 = self.join()
        self.assertEqual(self.vote(token2, text="A").status_code, 201)
        self.assertEqual(self.vote(token2, text="B").status_code, 409)

    def test_wordcloud_max_answers_enforced(self):
        # Per-participant cap (#76): the cap-th term is accepted, one more is
        # rejected (409); enforced server-side regardless of the client.
        cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            allow_multiple=True, wordcloud_max_answers=2,
        )
        self.open_question(cloud)
        token = self.join()
        self.assertEqual(self.vote(token, text="Klima").status_code, 201)
        self.assertEqual(self.vote(token, text="Wasser").status_code, 201)
        self.assertEqual(self.vote(token, text="Wald").status_code, 409)
        self.assertEqual(Vote.objects.filter(token__key=token).count(), 2)

    def test_wordcloud_max_answers_zero_is_unlimited(self):
        cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            allow_multiple=True, wordcloud_max_answers=0,
        )
        self.open_question(cloud)
        token = self.join()
        for term in ("A", "B", "C", "D"):
            self.assertEqual(self.vote(token, text=term).status_code, 201)
        self.assertEqual(Vote.objects.filter(token__key=token).count(), 4)

    def test_word_cloud_retract(self):
        # A participant can withdraw their own term while the question is
        # open; afterwards the same term can be submitted again (#14).
        cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            allow_multiple=True,
        )
        self.open_question(cloud)
        token = self.join()
        self.vote(token, text="Klima")
        self.assertEqual(Vote.objects.filter(token__key=token).count(), 1)
        r = self.client.post(
            f"/api/live/rooms/{self.room.code}/retract/",
            {"token": token, "text": "klima"},  # case-insensitive match
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(Vote.objects.filter(token__key=token).count(), 0)
        # Retracted → can be entered again.
        self.assertEqual(self.vote(token, text="Klima").status_code, 201)

    def test_word_cloud_vote_and_normalization(self):
        cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD
        )
        self.open_question(cloud)
        for raw in ["Klima", "klima", "  KLIMA ", "Wasser"]:
            token = self.join()
            self.assertEqual(self.vote(token, text=raw).status_code, 201)
        payloads = build_payloads(self.room)
        words = {w["text"]: w["count"] for w in payloads["presenter"]["words"]}
        # Case variants merge; the most frequent spelling wins the display.
        self.assertEqual(sum(words.values()), 4)
        self.assertEqual(len(words), 2)
        self.assertIn(words.get("Klima", words.get("klima", words.get("KLIMA"))), [3])
        self.assertEqual(words["Wasser"], 1)


class ControlTests(LiveTestCase):
    def login(self):
        self.client.force_login(self.owner)

    def test_start_run_creates_and_reuses(self):
        self.login()
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        run_id = response.json()["run"]
        again = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {},
            content_type="application/json",
        ).json()
        self.assertEqual(again["run"], run_id)

    def test_start_run_reset_deletes_votes(self):
        token = self.join()
        self.open_question()
        self.vote(token, options=[self.correct.pk])
        self.login()
        self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"reset": True},
            content_type="application/json",
        )
        self.assertEqual(Vote.objects.count(), 0)
        self.assertEqual(Run.objects.count(), 1)

    def test_continue_keeps_votes(self):
        token = self.join()
        self.open_question()
        self.vote(token, options=[self.correct.pk])
        self.login()
        self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {},
            content_type="application/json",
        )
        self.assertEqual(Vote.objects.count(), 1)

    def _finished_run_with_vote(self):
        run = self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        run.phase = Run.Phase.FINISHED
        run.save(update_fields=["phase"])
        return run

    def test_archive_starts_new_run_keeping_old(self):
        # "Archivieren": the old Durchführung stays as an archive, a fresh
        # empty run begins alongside it (#17).
        self.login()
        run_a = self._finished_run_with_vote()
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "archive"},
            content_type="application/json",
        ).json()
        self.assertNotEqual(resp["run"], run_a.pk)
        self.assertEqual(Run.objects.count(), 2)
        self.assertEqual(run_a.votes.count(), 1)

    def test_archive_finishes_unfinished_run_with_votes(self):
        # Archiving must work even when the previous run was left UNFINISHED
        # (presenter closed the tab without ending it) — the common case (#70).
        # The run is finished (kept as an archive) and a fresh empty run begins.
        self.login()
        run_a = self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        run_a.refresh_from_db()
        self.assertNotEqual(run_a.phase, Run.Phase.FINISHED)  # still open
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "archive"},
            content_type="application/json",
        ).json()
        run_a.refresh_from_db()
        self.assertEqual(run_a.phase, Run.Phase.FINISHED)  # archived, not reused
        self.assertNotEqual(resp["run"], run_a.pk)  # a brand-new run
        self.assertEqual(Run.objects.count(), 2)
        self.assertEqual(run_a.votes.count(), 1)  # old answers preserved
        self.assertEqual(Run.objects.get(pk=resp["run"]).votes.count(), 0)

    def test_live_status_reports_active_run_has_votes(self):
        # The start dialog needs to know whether the run it would resume already
        # carries answers, so archiving can be offered (#70).
        self.login()
        self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        resp = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()
        self.assertTrue(resp["active_run"])
        self.assertTrue(resp["has_votes"])
        self.assertTrue(resp["active_run_has_votes"])

    def test_live_status_recently_started_true_for_open_run(self):
        self.login()
        run = self.open_question()
        Run.objects.filter(pk=run.pk).update(opened_at=timezone.now())
        resp = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()
        self.assertTrue(resp["recently_started"])

    def test_live_status_recently_started_false_when_only_finished(self):
        self.login()
        run = self._finished_run_with_vote()
        Run.objects.filter(pk=run.pk).update(opened_at=timezone.now())  # recent but finished
        resp = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()
        self.assertFalse(resp["recently_started"])

    def test_live_status_recently_started_false_when_stale(self):
        self.login()
        run = self.open_question()
        Run.objects.filter(pk=run.pk).update(
            opened_at=timezone.now() - timezone.timedelta(minutes=121)
        )
        resp = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()
        self.assertFalse(resp["recently_started"])

    def test_live_status_recently_started_false_when_never_opened(self):
        self.login()
        self.open_question()  # phase OPEN but opened_at stays null
        resp = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()
        self.assertFalse(resp["recently_started"])

    def test_easy_mode_continues_recent_session_across_day(self):
        # An ongoing session (non-finished run opened within the window) continues
        # even when it was created on a previous calendar day — no archive.
        self.owner.easy_mode = True
        self.owner.is_staff = False
        self.owner.save(update_fields=["easy_mode", "is_staff"])
        self.login()
        run = self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        Run.objects.filter(pk=run.pk).update(
            opened_at=timezone.now(),
            created_at=timezone.now() - timezone.timedelta(days=1),
        )
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "live"},
            content_type="application/json",
        ).json()
        self.assertEqual(resp["run"], run.pk)      # continued, not archived
        self.assertEqual(Run.objects.count(), 1)

    def test_continue_reactivates_latest_run(self):
        # "Weiterzählen": the most recent Durchführung is reactivated and its
        # votes are kept — no second run (#17).
        self.login()
        run_a = self._finished_run_with_vote()
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "continue"},
            content_type="application/json",
        ).json()
        self.assertEqual(resp["run"], run_a.pk)
        self.assertEqual(Run.objects.count(), 1)
        run_a.refresh_from_db()
        self.assertNotEqual(run_a.phase, Run.Phase.FINISHED)
        self.assertEqual(run_a.votes.count(), 1)

    def test_continue_recent_session_resumes_in_place(self):
        self.login()
        run = self.open_question()
        Run.objects.filter(pk=run.pk).update(opened_at=timezone.now())
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "continue"},
            content_type="application/json",
        ).json()
        run.refresh_from_db()
        self.assertEqual(resp["run"], run.pk)
        self.assertEqual(run.phase, Run.Phase.OPEN)                 # not reset to lobby
        self.assertEqual(run.active_question_id, self.question.pk)  # preserved

    def test_continue_stale_unfinished_run_resets_to_lobby(self):
        self.login()
        run = self.open_question()
        Run.objects.filter(pk=run.pk).update(
            opened_at=timezone.now() - timezone.timedelta(minutes=121)
        )
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "continue"},
            content_type="application/json",
        ).json()
        run.refresh_from_db()
        self.assertEqual(resp["run"], run.pk)
        self.assertEqual(run.phase, Run.Phase.LOBBY)   # reset (not recent)
        self.assertIsNone(run.active_question_id)      # reset

    def test_easy_mode_archives_when_last_run_another_day(self):
        # Effective easy mode + no explicit ``existing``: a finished run from
        # a previous calendar day is kept as an archive, a fresh run starts.
        self.owner.easy_mode = True
        self.owner.is_staff = False
        self.owner.save(update_fields=["easy_mode", "is_staff"])
        self.login()
        run_a = self._finished_run_with_vote()
        Run.objects.filter(pk=run_a.pk).update(
            created_at=timezone.now() - timezone.timedelta(days=1)
        )
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "live"},
            content_type="application/json",
        ).json()
        self.assertNotEqual(resp["run"], run_a.pk)
        self.assertEqual(Run.objects.count(), 2)
        run_a.refresh_from_db()
        self.assertEqual(run_a.phase, Run.Phase.FINISHED)
        self.assertEqual(run_a.votes.count(), 1)

    def test_easy_mode_continues_when_last_run_today(self):
        # Same easy-mode owner, but the latest non-empty run is from today:
        # auto-decision must be "continue", not "archive".
        self.owner.easy_mode = True
        self.owner.is_staff = False
        self.owner.save(update_fields=["easy_mode", "is_staff"])
        self.login()
        run_a = self._finished_run_with_vote()
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "live"},
            content_type="application/json",
        ).json()
        self.assertEqual(resp["run"], run_a.pk)
        self.assertEqual(Run.objects.count(), 1)
        run_a.refresh_from_db()
        self.assertNotEqual(run_a.phase, Run.Phase.FINISHED)
        self.assertEqual(run_a.votes.count(), 1)

    def test_easy_mode_explicit_existing_wins(self):
        # An explicit ``existing`` always overrides the easy-mode automatic,
        # even when the auto-decision would have been "archive".
        self.owner.easy_mode = True
        self.owner.is_staff = False
        self.owner.save(update_fields=["easy_mode", "is_staff"])
        self.login()
        run_a = self._finished_run_with_vote()
        Run.objects.filter(pk=run_a.pk).update(
            created_at=timezone.now() - timezone.timedelta(days=1)
        )
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "live", "existing": "continue"},
            content_type="application/json",
        ).json()
        self.assertEqual(resp["run"], run_a.pk)
        self.assertEqual(Run.objects.count(), 1)

    def test_admin_at_pro_default_no_auto_archive(self):
        # Admins default to Pro (``easy_mode`` is None -> effective_easy_mode
        # is False for staff): no easy-mode automatic, so the default (no
        # ``existing``) behaves as the plain "continue" fallback, not
        # auto-archive.
        self.owner.easy_mode = None
        self.owner.is_staff = True
        self.owner.save(update_fields=["easy_mode", "is_staff"])
        self.login()
        run_a = self._finished_run_with_vote()
        Run.objects.filter(pk=run_a.pk).update(
            created_at=timezone.now() - timezone.timedelta(days=1)
        )
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "live"},
            content_type="application/json",
        ).json()
        self.assertEqual(resp["run"], run_a.pk)
        self.assertEqual(Run.objects.count(), 1)

    def test_admin_in_simple_mode_auto_archives(self):
        # An admin who explicitly chose Simple (``easy_mode=True``) still
        # gets the easy-mode automatic, even though they are staff.
        self.owner.is_staff = True
        self.owner.easy_mode = True  # admin explicitly chose simple
        self.owner.save(update_fields=["is_staff", "easy_mode"])
        self.login()
        run_a = self._finished_run_with_vote()
        Run.objects.filter(pk=run_a.pk).update(
            created_at=timezone.now() - timezone.timedelta(days=1)
        )
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "live"},
            content_type="application/json",
        ).json()
        self.assertNotEqual(resp["run"], run_a.pk)
        self.assertEqual(Run.objects.count(), 2)
        run_a.refresh_from_db()
        self.assertEqual(run_a.phase, Run.Phase.FINISHED)
        self.assertEqual(run_a.votes.count(), 1)

    def test_archive_results_finishes_and_prepares_fresh(self):
        # #27 shortcut: the running Durchführung is finished (kept as archive)
        # and an empty run is prepared so the next presentation starts clean.
        self.login()
        run_a = self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/archive-results/",
            {},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        run_a.refresh_from_db()
        self.assertEqual(run_a.phase, Run.Phase.FINISHED)
        self.assertIsNotNone(run_a.ended_at)
        self.assertEqual(run_a.votes.count(), 1)  # data kept
        fresh = Run.objects.exclude(pk=run_a.pk).get()
        self.assertEqual(fresh.phase, Run.Phase.LOBBY)
        self.assertEqual(resp.json()["run"], fresh.pk)

    def test_archive_results_idempotent(self):
        # A second click reuses the already-prepared empty run.
        self.login()
        self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        url = f"/api/question-sets/{self.question_set.pk}/archive-results/"
        r1 = self.client.post(url, {}, content_type="application/json").json()
        r2 = self.client.post(url, {}, content_type="application/json").json()
        self.assertEqual(r1["run"], r2["run"])
        self.assertEqual(Run.objects.count(), 2)

    def test_results_omit_empty_prepared_run(self):
        # The prepared empty run must not show up as a Durchführung (#27).
        self.login()
        self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        self.client.post(
            f"/api/question-sets/{self.question_set.pk}/archive-results/",
            {},
            content_type="application/json",
        )
        data = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()
        self.assertEqual(len(data["results"]), 1)

    def test_first_opened_at_set_once(self):
        self.login()
        run = Run.objects.create(question_set=self.question_set)
        url = f"/api/runs/{run.pk}/control/"
        self.client.post(
            url, {"phase": "open", "question": self.question.pk},
            content_type="application/json",
        )
        run.refresh_from_db()
        first = run.first_opened_at
        self.assertIsNotNone(first)
        # Re-opening (another question) must not overwrite the archive name.
        self.client.post(
            url, {"phase": "open", "question": self.question.pk},
            content_type="application/json",
        )
        run.refresh_from_db()
        self.assertEqual(run.first_opened_at, first)

    def test_control_phase_machine(self):
        self.login()
        run = Run.objects.create(question_set=self.question_set)
        url = f"/api/runs/{run.pk}/control/"
        response = self.client.post(
            url,
            {"phase": "open", "question": self.question.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        run.refresh_from_db()
        self.assertEqual(run.phase, "open")
        self.assertEqual(run.active_question, self.question)
        # Open without a question is invalid.
        response = self.client.post(
            url, {"phase": "open", "question": None}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)
        # Finishing stamps ended_at.
        self.client.post(url, {"phase": "finished"}, content_type="application/json")
        run.refresh_from_db()
        self.assertIsNotNone(run.ended_at)

    def test_close_triggers_eager_ai_wordcloud(self):
        # #75: closing the vote kicks off the AI word-cloud computation so the
        # presenter can switch to the AI views instantly.
        from unittest.mock import patch
        self.login()
        wc = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            wordcloud_ai_enabled=True, position=5,
        )
        run = Run.objects.create(question_set=self.question_set)
        url = f"/api/runs/{run.pk}/control/"
        self.client.post(
            url, {"phase": "open", "question": wc.pk}, content_type="application/json"
        )
        with patch("live.views.ai_wordcloud_live.ensure_result") as ensure:
            self.client.post(url, {"phase": "closed"}, content_type="application/json")
        ensure.assert_called_once_with(run.pk, wc.pk, self.room.pk)

    def test_close_no_eager_ai_for_plain_wordcloud(self):
        from unittest.mock import patch
        self.login()
        wc = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            wordcloud_ai_enabled=False, position=6,
        )
        run = Run.objects.create(question_set=self.question_set)
        url = f"/api/runs/{run.pk}/control/"
        self.client.post(
            url, {"phase": "open", "question": wc.pk}, content_type="application/json"
        )
        with patch("live.views.ai_wordcloud_live.ensure_result") as ensure:
            self.client.post(url, {"phase": "closed"}, content_type="application/json")
        ensure.assert_not_called()

    def test_ai_wordcloud_result_kept_warm_on_deactivate(self):
        # #75: deactivating a view must NOT drop the cached AI result.
        from live import ai_wordcloud_live as m
        key = (912345, 998877)
        with m._lock:
            m._results[key] = {"merged": [{"text": "x", "count": 1}],
                               "clusters": [], "pending": False}
        try:
            m.set_active(key[0], key[1], self.room.pk, False)
            self.assertIsNotNone(m.get_result(key[0], key[1]))
        finally:
            with m._lock:
                m._results.pop(key, None)
                m._active.discard(key)

    def test_control_requires_owner(self):
        run = Run.objects.create(question_set=self.question_set)
        eve = User.objects.create_user(username="eve")
        self.client.force_login(eve)
        response = self.client.post(
            f"/api/runs/{run.pk}/control/",
            {"phase": "lobby"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_live_status_reports_votes(self):
        token = self.join()
        self.open_question()
        self.vote(token, options=[self.correct.pk])
        self.login()
        payload = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()
        self.assertTrue(payload["has_votes"])
        self.assertIsNotNone(payload["active_run"])

    def test_control_reveal_can_be_toggled_off(self):
        self.login()
        run = self.open_question()
        self.client.post(
            f"/api/runs/{run.pk}/control/",
            {"reveal": True},
            content_type="application/json",
        )
        run.refresh_from_db()
        self.assertTrue(run.answers_revealed)
        resp = self.client.post(
            f"/api/runs/{run.pk}/control/",
            {"reveal": False},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        run.refresh_from_db()
        self.assertFalse(run.answers_revealed)


class StatePayloadTests(LiveTestCase):
    def test_participant_sees_question_only_when_open(self):
        run = self.open_question()
        run.phase = Run.Phase.PREVIEW
        run.save()
        payloads = build_payloads(self.room)
        self.assertNotIn("question", payloads["participant"])
        self.assertIn("question", payloads["presenter"])
        run.phase = Run.Phase.OPEN
        run.save()
        payloads = build_payloads(self.room)
        self.assertIn("question", payloads["participant"])
        # Participants never receive correctness flags.
        option = payloads["participant"]["question"]["options"][0]
        self.assertNotIn("is_correct", option)

    def test_section_description_never_reaches_participants(self):
        # The section description is beamer-only (interstitial slide).
        from rooms.models import Section

        section = Section.objects.create(
            question_set=self.question_set, title_de="Teil A",
            description_de="<p>GEHEIM-BESCHREIBUNG</p>",
        )
        self.question.section = section
        self.question.save(update_fields=["section"])
        for phase in (Run.Phase.PREVIEW, Run.Phase.OPEN, Run.Phase.CLOSED):
            run = self.open_question()
            run.phase = phase
            run.save()
            payloads = build_payloads(self.room)
            self.assertNotIn("GEHEIM-BESCHREIBUNG", json.dumps(payloads["participant"]))
            run.delete()

    def test_participant_payload_carries_run_id(self):
        # Devices scope their "already voted" marker to the run so a re-run
        # lets them vote again (client-side; the run id makes it possible).
        run = self.open_question()
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["participant"]["run_id"], run.pk)

    def test_presenter_gets_results(self):
        token = self.join()
        self.open_question()
        self.vote(token, options=[self.correct.pk])
        payloads = build_payloads(self.room)
        results = {
            resolve_translated_text(r["text"]): r["count"]
            for r in payloads["presenter"]["results"]
        }
        self.assertEqual(results, {"4": 1, "5": 0})
        self.assertEqual(payloads["presenter"]["votes"], 1)

    def test_presenter_before_after_comparison(self):
        # #54: when the active question is an after-question, the presenter
        # payload carries the before-question's aggregates from the same run.
        after = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.SINGLE_CHOICE,
            text="<p>2+2?</p>",
            before_question=self.question,
            position=5,
        )
        AnswerOption.objects.create(question=after, text="4", is_correct=True, position=0)
        AnswerOption.objects.create(question=after, text="5", position=1)
        token = self.join()
        run = self.open_question()  # before-question active, collect a vote
        self.vote(token, options=[self.correct.pk])
        run.active_question = after
        run.phase = Run.Phase.RESULTS
        run.save()
        before = build_payloads(self.room)["presenter"]["before"]
        self.assertEqual(before["votes"], 1)
        counts = {
            resolve_translated_text(r["text"]): r["count"] for r in before["results"]
        }
        self.assertEqual(counts, {"4": 1, "5": 0})

    def test_question_and_option_text_are_language_maps(self):
        # #33 MR2: the SSE hub broadcasts one payload to every participant,
        # so authored text is a {de, en} map, resolved client-side.
        self.question.text_de = "<p>Wie viel?</p>"
        self.question.text_en = "<p>How much?</p>"
        self.question.save(update_fields=["text_de", "text_en"])
        self.correct.text_de = "vier"
        self.correct.text_en = "four"
        self.correct.save(update_fields=["text_de", "text_en"])
        self.open_question()
        payloads = build_payloads(self.room)
        question = payloads["presenter"]["question"]
        self.assertEqual(
            question["text"], {"de": "<p>Wie viel?</p>", "en": "<p>How much?</p>"}
        )
        option = question["options"][0]
        self.assertEqual(option["text"], {"de": "vier", "en": "four"})

    def test_room_title_and_set_title_are_language_maps(self):
        self.room.title_de = "Biologie"
        self.room.title_en = "Biology"
        self.room.save(update_fields=["title_de", "title_en"])
        self.question_set.title_de = "Termin Eins"
        self.question_set.title_en = "Session One"
        self.question_set.save(update_fields=["title_de", "title_en"])
        self.open_question()
        payloads = build_payloads(self.room)
        self.assertEqual(
            payloads["presenter"]["room"]["title"],
            {"de": "Biologie", "en": "Biology"},
        )
        self.assertEqual(
            payloads["presenter"]["set_title"],
            {"de": "Termin Eins", "en": "Session One"},
        )

    def test_shuffle_is_stable_per_run(self):
        self.question.shuffle_options = True
        self.question.save()
        self.open_question()
        first = build_payloads(self.room)["participant"]["question"]["options"]
        second = build_payloads(self.room)["participant"]["question"]["options"]
        self.assertEqual(first, second)

    def test_idle_room(self):
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["participant"]["phase"], "idle")

    def test_per_question_reveal_overrides_set(self):
        # #28: a question may override the set-wide reveal mode.
        self.question_set.reveal_answers = "never"
        self.question_set.save(update_fields=["reveal_answers"])
        self.question.reveal_answers = "immediately"
        self.question.save(update_fields=["reveal_answers"])
        self.open_question()
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["presenter"]["reveal_answers"], "immediately")

    def test_inherit_uses_set_reveal(self):
        self.question_set.reveal_answers = "immediately"
        self.question_set.save(update_fields=["reveal_answers"])
        # self.question keeps the default "inherit".
        self.open_question()
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["presenter"]["reveal_answers"], "immediately")

    def test_question_payload_carries_wordcloud_live(self):
        # #30: the presenter uses this flag to hide the cloud while open.
        wc = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.WORD_CLOUD,
            text="<p>Stichwort?</p>",
            wordcloud_live=False,
        )
        self.open_question(question=wc)
        payloads = build_payloads(self.room)
        self.assertFalse(payloads["presenter"]["question"]["wordcloud_live"])

    def test_question_payload_carries_wordcloud_max_answers(self):
        # #76: the participant page needs the per-person cap to stop input.
        wc = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.WORD_CLOUD,
            text="<p>Stichwort?</p>",
            allow_multiple=True,
            wordcloud_max_answers=3,
        )
        self.open_question(question=wc)
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["presenter"]["question"]["wordcloud_max_answers"], 3)
        self.assertEqual(payloads["participant"]["question"]["wordcloud_max_answers"], 3)

    def test_question_payload_carries_wordcloud_batch_submit(self):
        # #88: the participant page needs to know whether to show batch fields.
        wc = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.WORD_CLOUD,
            text="<p>Stichwort?</p>",
            allow_multiple=True,
            wordcloud_max_answers=5,
            wordcloud_batch_submit=True,
        )
        self.open_question(question=wc)
        payloads = build_payloads(self.room)
        self.assertTrue(payloads["participant"]["question"]["wordcloud_batch_submit"])

    def test_question_payload_carries_participant_feedback(self):
        # The participant client polls my-evaluation only when this is set;
        # False for every non-open_text question (self.question is single-choice).
        self.open_question()
        payloads = build_payloads(self.room)
        self.assertFalse(payloads["presenter"]["question"]["participant_feedback"])
        self.assertFalse(payloads["participant"]["question"]["participant_feedback"])
        self.question.participant_feedback = True
        self.question.save(update_fields=["participant_feedback"])
        payloads = build_payloads(self.room)
        self.assertTrue(payloads["presenter"]["question"]["participant_feedback"])
        self.assertTrue(payloads["participant"]["question"]["participant_feedback"])

    def test_question_payload_carries_is_abstention_for_likert(self):
        # #86: the Likert participant renderer excludes the abstention option
        # from the segment scale and renders it as a separate button — it
        # needs the flag on each option to tell them apart.
        likert = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.LIKERT, text="<p>Wie?</p>",
        )
        AnswerOption.objects.create(question=likert, text="Stimme nicht zu", position=0)
        AnswerOption.objects.create(question=likert, text="Stimme zu", position=1)
        AnswerOption.objects.create(
            question=likert, text="Enthaltung", is_abstention=True, position=2
        )
        self.open_question(question=likert)
        payloads = build_payloads(self.room)
        opts = payloads["participant"]["question"]["options"]
        self.assertTrue(any(o["is_abstention"] for o in opts))
        self.assertFalse(all(o["is_abstention"] for o in opts))


class ParticipantPageTests(LiveTestCase):
    def test_pages_render(self):
        self.assertEqual(self.client.get("/p/").status_code, 200)
        self.assertContains(self.client.get(f"/p/{self.room.code}/"), self.room.title)
        self.assertEqual(self.client.get("/p/00000000/").status_code, 404)

    def test_unknown_code_renders_friendly_page(self):
        resp = self.client.get("/p/nope-nope-nope/")
        self.assertEqual(resp.status_code, 404)
        self.assertTemplateUsed(resp, "live/not_found.html")
        self.assertContains(resp, "not found", status_code=404)

    def test_qr_png(self):
        response = self.client.get(f"/p/{self.room.code}/qr.png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")

    def test_closing_info_rendered_system_then_room(self):
        # #24: the finished screen carries system-wide + room stored HTML.
        # editor-unify #49: both fields now hold sanitized HTML (not
        # Markdown) — set them as such.
        from common.models import SiteConfig

        site = SiteConfig.load()
        site.closing_info = "System-Hinweis"
        site.save()
        self.room.closing_info = '<p><a href="https://e.com">Raum-Link</a></p>'
        self.room.save(update_fields=["closing_info"])
        html = self.client.get(f"/p/{self.room.code}/").content.decode()
        self.assertIn("System-Hinweis", html)
        self.assertIn('href="https://e.com"', html)

    def test_closing_info_renders_stored_html_directly(self):
        # editor-unify #49: closing_info now stores sanitized HTML (not
        # Markdown) — the page must show it as-is, not re-run it through the
        # Markdown parser (which would escape/mangle the already-HTML tags).
        self.room.closing_info_de = "<p>Danke <strong>alle</strong></p>"
        self.room.save(update_fields=["closing_info_de"])
        html = self.client.get(f"/p/{self.room.code}/").content.decode()
        self.assertIn("<strong>alle</strong>", html)


class ParticipantI18nTests(LiveTestCase):
    def test_participant_page_renders_english(self):
        # LocaleMiddleware + {% trans %} switch the framework-free
        # participant template to English via Accept-Language.
        resp = self.client.get(f"/p/{self.room.code}/", HTTP_ACCEPT_LANGUAGE="en")
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertIn('<html lang="en">', html)
        self.assertIn("My answers", html)
        self.assertNotIn("Meine Antworten", html)

    def test_no_template_syntax_leaks_into_page(self):
        # Regression: a multi-line {# #} note rendered as visible text because
        # Django's {# #} comment is single-line only (must be {% comment %}).
        # Leaked template syntax ({# / {% / {{) in the output is the signature.
        resp = self.client.get(f"/p/{self.room.code}/")
        html = resp.content.decode()
        self.assertNotIn("{#", html)
        self.assertNotIn("{%", html)
        self.assertNotIn("{{", html)
        self.assertIn('id="menu-wrap"', html)  # the menu still renders

    def test_participant_page_renders_german_via_accept_language(self):
        resp = self.client.get(f"/p/{self.room.code}/", HTTP_ACCEPT_LANGUAGE="de")
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertIn('<html lang="de">', html)
        self.assertIn("Meine Antworten", html)

    def test_participant_page_defaults_to_english(self):
        # No Accept-Language header at all — the true default (English).
        resp = self.client.get(f"/p/{self.room.code}/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn('<html lang="en">', resp.content.decode())

    def test_language_cookie_switches_page(self):
        self.client.cookies["django_language"] = "en"
        resp = self.client.get(f"/p/{self.room.code}/")
        self.assertIn('<html lang="en">', resp.content.decode())

    def test_participant_home_lang_query_switches_to_english(self):
        # ?lang= is the QR/short-link entry point (spec): it must win over
        # Accept-Language and persist via the language cookie.
        resp = self.client.get("/p/?lang=en", HTTP_ACCEPT_LANGUAGE="de")
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertIn('<html lang="en">', html)
        self.assertIn("Join a poll", html)
        self.assertEqual(resp.cookies[settings.LANGUAGE_COOKIE_NAME].value, "en")

    def test_participant_home_ignores_unsupported_lang(self):
        resp = self.client.get("/p/?lang=fr", HTTP_ACCEPT_LANGUAGE="de")
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertIn('<html lang="de">', html)
        self.assertNotIn(settings.LANGUAGE_COOKIE_NAME, resp.cookies)


class HasResultsTests(LiveTestCase):
    def test_set_listing_reports_results(self):
        self.client.force_login(self.owner)
        listing = self.client.get(
            f"/api/question-sets/?room={self.room.pk}"
        ).json()["results"]
        self.assertFalse(listing[0]["has_results"])
        token = self.join()
        self.open_question()
        self.vote(token, options=[self.correct.pk])
        listing = self.client.get(
            f"/api/question-sets/?room={self.room.pk}"
        ).json()["results"]
        self.assertTrue(listing[0]["has_results"])


class ResultsApiTests(LiveTestCase):
    def _run_with_votes(self):
        run = self.open_question()
        for option in (self.correct, self.correct, self.wrong):
            token = self.join()
            self.vote(token, options=[option.pk])
        run.phase = Run.Phase.FINISHED
        run.save()
        return run

    def test_results_aggregation(self):
        self._run_with_votes()
        self.client.force_login(self.owner)
        payload = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["votes_total"], 3)
        counts = {
            resolve_translated_text(o["text"]): o["count"]
            for o in payload[0]["questions"][0]["options"]
        }
        self.assertEqual(counts, {"4": 2, "5": 1})

    def test_results_expose_before_question_link(self):
        # #54: each result item carries its before-question id (null when
        # standalone) so the results view can pair before/after.
        self._run_with_votes()
        self.client.force_login(self.owner)
        payload = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        self.assertIn("before_question", payload[0]["questions"][0])
        self.assertIsNone(payload[0]["questions"][0]["before_question"])

    def test_results_require_owner(self):
        self._run_with_votes()
        eve = User.objects.create_user(username="eve")
        self.client.force_login(eve)
        response = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        )
        self.assertEqual(response.status_code, 404)

    def test_delete_single_run(self):
        run = self._run_with_votes()
        self.client.force_login(self.owner)
        response = self.client.delete(f"/api/runs/{run.pk}/")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(Run.objects.count(), 0)
        self.assertEqual(Vote.objects.count(), 0)

    def test_delete_all_results(self):
        self._run_with_votes()
        self._run_with_votes()
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/delete-results/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Run.objects.count(), 0)

    def test_csv_export(self):
        self._run_with_votes()
        self.client.force_login(self.owner)
        response = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        )
        self.assertEqual(response.status_code, 200)
        body = response.content.decode("utf-8-sig")
        self.assertIn("durchfuehrung;gestartet;frage_nr;frage;antwort;richtig;stimmen", body)
        self.assertIn(";1;2+2?;4;x;2", body)
        self.assertIn(";1;2+2?;5;;1", body)
        # #33 MR2: question/option text is a {de, en} map internally — the
        # CSV must resolve it to a canonical string, never leak the dict.
        self.assertNotIn("{", body)
        self.assertNotIn("'de'", body)

    def test_csv_requires_owner(self):
        self._run_with_votes()
        eve = User.objects.create_user(username="eve")
        self.client.force_login(eve)
        response = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        )
        self.assertEqual(response.status_code, 404)


class FinishedPhaseTests(LiveTestCase):
    def test_finished_room_reports_finished_not_idle(self):
        run = self.open_question()
        run.phase = Run.Phase.FINISHED
        run.save()
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["participant"]["phase"], "finished")

    def test_room_without_runs_stays_idle(self):
        self.assertEqual(build_payloads(self.room)["participant"]["phase"], "idle")

    def test_new_run_wins_over_old_finished_one(self):
        old = self.open_question()
        old.phase = Run.Phase.FINISHED
        old.save()
        Run.objects.create(question_set=self.question_set, phase=Run.Phase.LOBBY)
        self.assertEqual(build_payloads(self.room)["participant"]["phase"], "lobby")


class V21FormatTests(LiveTestCase):
    def _question(self, kind, **kwargs):
        return Question.objects.create(
            question_set=self.question_set, kind=kind, position=99, **kwargs
        )

    def test_open_text_vote_stores_raw_text(self):
        question = self._question(Question.Kind.OPEN_TEXT)
        self.open_question(question)
        token = self.join()
        long_text = "Meinung:  " + "x" * 600
        response = self.vote(token, text=long_text)
        self.assertEqual(response.status_code, 201)
        vote = Vote.objects.get()
        # Clamped to 500, inner whitespace preserved (unlike word clouds).
        self.assertEqual(len(vote.text), 500)
        self.assertTrue(vote.text.startswith("Meinung:  x"))

    def test_open_text_appears_as_words_for_presenter(self):
        question = self._question(Question.Kind.OPEN_TEXT)
        self.open_question(question)
        self.vote(self.join(), text="Sehr gut")
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["presenter"]["words"][0]["text"], "Sehr gut")

    def test_likert_allows_exactly_one_option(self):
        question = self._question(Question.Kind.LIKERT)
        scale = [
            AnswerOption.objects.create(question=question, text=t, position=i)
            for i, t in enumerate(["++", "+", "0", "-", "--"])
        ]
        self.open_question(question)
        token = self.join()
        response = self.vote(token, options=[scale[0].pk, scale[1].pk])
        self.assertEqual(response.status_code, 400)
        response = self.vote(token, options=[scale[1].pk])
        self.assertEqual(response.status_code, 201)


class TimerTests(LiveTestCase):
    def test_expired_timer_rejects_votes(self):
        from django.utils import timezone

        self.question.time_limit = 30
        self.question.save()
        run = self.open_question()
        run.opened_at = timezone.now() - timezone.timedelta(seconds=60)
        run.save()
        response = self.vote(self.join(), options=[self.correct.pk])
        self.assertEqual(response.status_code, 409)

    def test_running_timer_accepts_votes_and_reports_deadline(self):
        from django.utils import timezone

        self.question.time_limit = 300
        self.question.save()
        run = self.open_question()
        run.opened_at = timezone.now()
        run.save()
        self.assertEqual(
            self.vote(self.join(), options=[self.correct.pk]).status_code, 201
        )
        payloads = build_payloads(self.room)
        self.assertIn("ends_at", payloads["participant"])

    def test_control_open_stamps_opened_at(self):
        self.client.force_login(self.owner)
        run = Run.objects.create(question_set=self.question_set)
        self.client.post(
            f"/api/runs/{run.pk}/control/",
            {"phase": "open", "question": self.question.pk},
            content_type="application/json",
        )
        run.refresh_from_db()
        self.assertIsNotNone(run.opened_at)


class RevealTests(LiveTestCase):
    def test_reveal_flag_via_control(self):
        self.client.force_login(self.owner)
        run = self.open_question()
        run.phase = Run.Phase.RESULTS
        run.save()
        self.client.post(
            f"/api/runs/{run.pk}/control/", {"reveal": True},
            content_type="application/json",
        )
        run.refresh_from_db()
        self.assertTrue(run.answers_revealed)
        # Navigating to the next question resets the reveal.
        self.client.post(
            f"/api/runs/{run.pk}/control/",
            {"phase": "preview", "question": self.question.pk},
            content_type="application/json",
        )
        run.refresh_from_db()
        self.assertFalse(run.answers_revealed)


class ParticipantResultsTests(LiveTestCase):
    def _run_in_results(self):
        run = self.open_question()
        self.vote(self.join(), options=[self.correct.pk])
        run.phase = Run.Phase.RESULTS
        run.save()
        return run

    def test_disabled_hides_results(self):
        # Opt-out path: with participant results turned off the payload carries
        # no "results" block. (The default is now ON — set explicitly here so
        # the test exercises the off-path regardless of the model default.)
        self.question_set.show_results_to_participants = False
        self.question_set.save()
        self._run_in_results()
        payloads = build_payloads(self.room)
        self.assertNotIn("results", payloads["participant"])

    def test_enabled_shows_counts_without_correct_until_revealed(self):
        self.question_set.show_results_to_participants = True
        # This test exercises the "after closing, on reveal" mode explicitly,
        # so it no longer depends on the (now "immediately") set default.
        self.question_set.reveal_answers = "after_close"
        self.question_set.save()
        run = self._run_in_results()
        payloads = build_payloads(self.room)
        results = payloads["participant"]["results"]
        self.assertEqual(
            {resolve_translated_text(r["text"]): r["count"] for r in results},
            {"4": 1, "5": 0},
        )
        self.assertNotIn("is_correct", results[0])
        run.answers_revealed = True
        run.save()
        results = build_payloads(self.room)["participant"]["results"]
        self.assertTrue(any(r.get("is_correct") for r in results))


class SelfPacedTests(LiveTestCase):
    """Self-paced quiz (concept §6.3): all questions open, instant feedback."""

    def setUp(self):
        super().setUp()
        self.cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD, position=1
        )

    def start(self, **body):
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "self_paced", **body},
            content_type="application/json",
        )
        self.client.logout()
        return response

    def quiz(self, token=""):
        return self.client.get(
            f"/api/live/rooms/{self.room.code}/quiz/", {"token": token}
        )

    def test_start_opens_immediately(self):
        self.start()
        run = Run.objects.get()
        self.assertEqual(run.mode, Run.Mode.SELF_PACED)
        self.assertEqual(run.phase, Run.Phase.OPEN)
        self.assertIsNone(run.active_question)

    def test_mode_switch_repurposes_run(self):
        self.start()
        run = Run.objects.get()
        self.client.force_login(self.owner)
        self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {},
            content_type="application/json",
        )
        run.refresh_from_db()
        self.assertEqual(run.mode, Run.Mode.LIVE)
        self.assertEqual(run.phase, Run.Phase.LOBBY)
        self.assertEqual(Run.objects.count(), 1)

    def test_invalid_mode_rejected(self):
        response = self.start(mode="warp")
        self.assertEqual(response.status_code, 400)

    def test_vote_any_question_with_feedback(self):
        self.start()
        token = self.join()
        response = self.vote(
            token, question=self.question.pk, options=[self.wrong.pk]
        )
        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertFalse(payload["is_correct"])
        self.assertEqual(payload["correct"], [self.correct.pk])
        # Second question (text kind): accepted, no correctness feedback.
        response = self.vote(token, question=self.cloud.pk, text="Osmose")
        self.assertEqual(response.status_code, 201)
        self.assertNotIn("correct", response.json())

    def test_vote_requires_known_question(self):
        self.start()
        token = self.join()
        self.assertEqual(self.vote(token, options=[self.correct.pk]).status_code, 400)
        self.assertEqual(
            self.vote(token, question=99999, options=[self.correct.pk]).status_code,
            400,
        )

    def test_double_vote_conflicts(self):
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        response = self.vote(token, question=self.question.pk, options=[self.wrong.pk])
        self.assertEqual(response.status_code, 409)

    def test_no_feedback_when_reveal_never(self):
        self.question_set.reveal_answers = "never"
        self.question_set.save()
        self.start()
        token = self.join()
        response = self.vote(
            token, question=self.question.pk, options=[self.correct.pk]
        )
        self.assertEqual(response.status_code, 201)
        self.assertNotIn("correct", response.json())

    def test_quiz_endpoint_returns_questions_and_answered(self):
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        payload = self.quiz(token).json()
        self.assertEqual(resolve_translated_text(payload["set_title"]), "Termin 1")
        self.assertTrue(payload["feedback"])
        self.assertEqual([q["id"] for q in payload["questions"]],
                         [self.question.pk, self.cloud.pk])
        # Options never leak is_correct.
        self.assertNotIn("is_correct", payload["questions"][0]["options"][0])
        self.assertEqual(
            payload["answered"],
            {
                str(self.question.pk): {
                    "is_correct": True,
                    "chosen": {"options": [self.correct.pk]},
                    "correct": [self.correct.pk],
                }
            },
        )

    def test_quiz_conflict_without_open_quiz(self):
        self.assertEqual(self.quiz().status_code, 409)
        self.open_question()  # live run, not self-paced
        self.assertEqual(self.quiz().status_code, 409)

    def test_quiz_answered_without_feedback_omits_correct(self):
        # reveal_answers "never" (#75): the participant still gets their own
        # chosen options back (for review/resume), but never the answer key.
        self.question_set.reveal_answers = "never"
        self.question_set.save()
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        payload = self.quiz(token).json()
        entry = payload["answered"][str(self.question.pk)]
        self.assertEqual(entry["chosen"], {"options": [self.correct.pk]})
        self.assertIsNone(entry["correct"])
        self.assertIsNone(entry["is_correct"])

    def test_quiz_answered_word_cloud_carries_own_text(self):
        self.start()
        token = self.join()
        self.vote(token, question=self.cloud.pk, text="Osmose")
        payload = self.quiz(token).json()
        self.assertEqual(
            payload["answered"][str(self.cloud.pk)],
            {"is_correct": None, "chosen": {"text": "Osmose"}, "correct": None},
        )

    def test_quiz_answered_priorities_carries_own_points(self):
        pq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.PRIORITIES,
            text="<p>Verteile 100 Punkte</p>", position=2,
        )
        oa = AnswerOption.objects.create(question=pq, text="A", position=0)
        ob = AnswerOption.objects.create(question=pq, text="B", position=1)
        self.start()
        token = self.join()
        response = self.client.post(
            f"/api/live/rooms/{self.room.code}/vote/",
            {
                "token": token,
                "question": pq.pk,
                "points": {str(oa.pk): 70, str(ob.pk): 30},
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        payload = self.quiz(token).json()
        self.assertEqual(
            payload["answered"][str(pq.pk)]["chosen"],
            {"points": {str(oa.pk): 70, str(ob.pk): 30}},
        )

    def test_quiz_answered_ordering_carries_own_order(self):
        oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>Bring in order</p>", position=3,
        )
        o1 = AnswerOption.objects.create(question=oq, text="A", position=0)
        o2 = AnswerOption.objects.create(question=oq, text="B", position=1)
        self.start()
        token = self.join()
        response = self.client.post(
            f"/api/live/rooms/{self.room.code}/vote/",
            {"token": token, "question": oq.pk, "order": [o2.pk, o1.pk]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        payload = self.quiz(token).json()
        self.assertEqual(
            payload["answered"][str(oq.pk)]["chosen"],
            {"order": [o2.pk, o1.pk]},
        )

    def test_quiz_includes_allow_back(self):
        # Default is True (model default); explicit False must round-trip.
        self.start()
        self.assertTrue(self.quiz().json()["allow_back"])
        self.question_set.allow_back_navigation = False
        self.question_set.save()
        self.assertFalse(self.quiz().json()["allow_back"])

    def test_quiz_canonical_order_when_shuffle_off(self):
        self.start()
        token = self.join()
        payload = self.quiz(token).json()
        self.assertEqual(
            [q["id"] for q in payload["questions"]],
            [self.question.pk, self.cloud.pk],
        )

    def test_quiz_shuffle_questions_is_stable_and_per_token(self):
        import random as random_module

        self.question_set.shuffle_questions = True
        self.question_set.save()
        self.start()
        run = Run.objects.get()
        canonical_ids = [self.question.pk, self.cloud.pk]
        token_a = self.join()
        token_b = self.join()

        order_a_first = [q["id"] for q in self.quiz(token_a).json()["questions"]]
        order_a_second = [q["id"] for q in self.quiz(token_a).json()["questions"]]
        # Same token, same call twice -> identical order (stable seed).
        self.assertEqual(order_a_first, order_a_second)
        self.assertEqual(sorted(order_a_first), sorted(canonical_ids))

        # The order matches the documented per-(run, token) seed exactly.
        expected_a = list(canonical_ids)
        random_module.Random(f"{run.pk}:{token_a}").shuffle(expected_a)
        self.assertEqual(order_a_first, expected_a)

        order_b = [q["id"] for q in self.quiz(token_b).json()["questions"]]
        expected_b = list(canonical_ids)
        random_module.Random(f"{run.pk}:{token_b}").shuffle(expected_b)
        self.assertEqual(order_b, expected_b)

    def test_payloads_signal_mode_and_progress(self):
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        payloads = build_payloads(self.room)
        participant = payloads["participant"]
        self.assertEqual(participant["mode"], "self_paced")
        self.assertEqual(participant["phase"], "open")
        self.assertNotIn("question", participant)
        presenter = payloads["presenter"]
        progress = {
            resolve_translated_text(row["text"]): row["votes"]
            for row in presenter["progress"]
        }
        self.assertEqual(progress["2+2?"], 1)
        self.assertEqual(presenter["votes_total"], 1)

    def test_start_stamps_quiz_ends_at_from_limit(self):
        self.question_set.quiz_time_limit = 120
        self.question_set.save()
        before = timezone.now()
        self.start()
        run = Run.objects.get()
        self.assertIsNotNone(run.quiz_ends_at)
        self.assertGreater(run.quiz_ends_at, before)
        expected = run.first_opened_at + timezone.timedelta(seconds=120)
        self.assertLess(abs((run.quiz_ends_at - expected).total_seconds()), 2)

    def test_start_without_limit_leaves_quiz_ends_at_none(self):
        self.start()
        run = Run.objects.get()
        self.assertIsNone(run.quiz_ends_at)

    def test_resuming_recent_open_run_does_not_move_quiz_ends_at(self):
        # An ONGOING session (opened within RECENT_START_WINDOW,
        # _recently_started() true): start-run resumes in place and must not
        # touch the deadline stamped at first open (#75 final review).
        self.question_set.quiz_time_limit = 120
        self.question_set.save()
        self.start()
        run = Run.objects.get()
        first_deadline = run.quiz_ends_at
        self.assertIsNotNone(first_deadline)
        run.opened_at = timezone.now()
        run.save(update_fields=["opened_at"])
        self.start()
        run.refresh_from_db()
        self.assertEqual(run.quiz_ends_at, first_deadline)

    def test_rerunning_finished_self_paced_set_refreshes_quiz_ends_at(self):
        # #75 final review: reactivating a FINISHED self-paced run (a fresh
        # session, not a resume) must get a FRESH deadline — otherwise the
        # re-run inherits the previous run's already-passed clock and every
        # vote 409s immediately.
        self.question_set.quiz_time_limit = 120
        self.question_set.save()
        self.start()
        run = Run.objects.get()
        old_deadline = run.quiz_ends_at
        self.assertIsNotNone(old_deadline)
        run.phase = Run.Phase.FINISHED
        run.ended_at = timezone.now()
        run.save(update_fields=["phase", "ended_at"])

        before = timezone.now()
        self.start(existing="continue")
        run.refresh_from_db()
        self.assertIsNotNone(run.quiz_ends_at)
        self.assertNotEqual(run.quiz_ends_at, old_deadline)
        self.assertGreater(run.quiz_ends_at, before)
        expected = timezone.now() + timezone.timedelta(seconds=120)
        self.assertLess(abs((run.quiz_ends_at - expected).total_seconds()), 2)

    def test_rerunning_set_without_limit_clears_quiz_ends_at(self):
        # A fresh session for a set whose limit was removed must clear a
        # stale deadline rather than leaving the old run's value in place.
        self.question_set.quiz_time_limit = 120
        self.question_set.save()
        self.start()
        run = Run.objects.get()
        self.assertIsNotNone(run.quiz_ends_at)
        run.phase = Run.Phase.FINISHED
        run.ended_at = timezone.now()
        run.save(update_fields=["phase", "ended_at"])

        self.question_set.quiz_time_limit = None
        self.question_set.save(update_fields=["quiz_time_limit"])
        self.start(existing="continue")
        run.refresh_from_db()
        self.assertIsNone(run.quiz_ends_at)

    def test_quiz_endpoint_includes_ends_at(self):
        self.question_set.quiz_time_limit = 120
        self.question_set.save()
        self.start()
        payload = self.quiz().json()
        self.assertIsNotNone(payload["ends_at"])
        run = Run.objects.get()
        self.assertEqual(payload["ends_at"], run.quiz_ends_at.isoformat())

    def test_quiz_endpoint_ends_at_none_without_limit(self):
        self.start()
        payload = self.quiz().json()
        self.assertIsNone(payload["ends_at"])

    def test_vote_rejected_after_quiz_deadline(self):
        self.question_set.quiz_time_limit = 120
        self.question_set.save()
        self.start()
        token = self.join()
        # Before the deadline: succeeds.
        response = self.vote(
            token, question=self.question.pk, options=[self.correct.pk]
        )
        self.assertEqual(response.status_code, 201)
        # Force the deadline into the past, then try the other question.
        run = Run.objects.get()
        run.quiz_ends_at = timezone.now() - timezone.timedelta(seconds=10)
        run.save(update_fields=["quiz_ends_at"])
        before_count = Vote.objects.count()
        response = self.vote(token, question=self.cloud.pk, text="Osmose")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Time is up.")
        self.assertEqual(Vote.objects.count(), before_count)


class AnswerCorrectionTests(LiveTestCase):
    """Self-paced answer correction (#75 Phase 2): a participant may replace
    an existing vote for a question, but only while back-navigation is on,
    no feedback has been shown (``reveal_answers == "never"``) and the quiz
    deadline (if any) has not passed."""

    def start(self, **body):
        # Mirrors SelfPacedTests.start() (kept local to avoid re-running that
        # class's whole suite under this one via inheritance).
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "self_paced", **body},
            content_type="application/json",
        )
        self.client.logout()
        return response

    def test_replace_allowed_with_back_nav_and_no_feedback(self):
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        response = self.vote(token, question=self.question.pk, options=[self.wrong.pk])
        self.assertEqual(response.status_code, 201)
        votes = Vote.objects.filter(
            run=Run.objects.get(), question=self.question, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        self.assertEqual(list(votes.get().options.all()), [self.wrong])

    def test_replace_rejected_with_feedback_on(self):
        self.question_set.reveal_answers = "immediately"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        response = self.vote(token, question=self.question.pk, options=[self.wrong.pk])
        self.assertEqual(response.status_code, 409)
        votes = Vote.objects.filter(
            run=Run.objects.get(), question=self.question, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        self.assertEqual(list(votes.get().options.all()), [self.correct])

    def test_replace_rejected_without_back_nav(self):
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = False
        self.question_set.save()
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        response = self.vote(token, question=self.question.pk, options=[self.wrong.pk])
        self.assertEqual(response.status_code, 409)
        votes = Vote.objects.filter(
            run=Run.objects.get(), question=self.question, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        self.assertEqual(list(votes.get().options.all()), [self.correct])

    def test_replace_rejected_after_deadline(self):
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        self.start()
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        run = Run.objects.get()
        run.quiz_ends_at = timezone.now() - timezone.timedelta(seconds=10)
        run.save(update_fields=["quiz_ends_at"])
        response = self.vote(token, question=self.question.pk, options=[self.wrong.pk])
        self.assertEqual(response.status_code, 409)
        votes = Vote.objects.filter(
            run=run, question=self.question, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        self.assertEqual(list(votes.get().options.all()), [self.correct])

    def test_replace_priorities_leaves_one_vote_with_new_scores(self):
        from .models import PriorityScore

        pq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.PRIORITIES,
            text="<p>Verteile 100 Punkte</p>", position=2,
        )
        oa = AnswerOption.objects.create(question=pq, text="A", position=0)
        ob = AnswerOption.objects.create(question=pq, text="B", position=1)
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        self.start()
        token = self.join()

        def submit(a, b):
            return self.client.post(
                f"/api/live/rooms/{self.room.code}/vote/",
                {
                    "token": token,
                    "question": pq.pk,
                    "points": {str(oa.pk): a, str(ob.pk): b},
                },
                content_type="application/json",
            )

        self.assertEqual(submit(70, 30).status_code, 201)
        response = submit(20, 80)
        self.assertEqual(response.status_code, 201)

        votes = Vote.objects.filter(
            run=Run.objects.get(), question=pq, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        vote = votes.get()
        scores = {s.option_id: s.points for s in PriorityScore.objects.filter(vote=vote)}
        self.assertEqual(scores, {oa.pk: 20, ob.pk: 80})
        self.assertEqual(PriorityScore.objects.count(), 2)

    def test_replace_ordering_leaves_one_vote_with_new_order(self):
        from .models import OrderingResponse

        oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>Bring in order</p>", position=3,
        )
        o1 = AnswerOption.objects.create(question=oq, text="A", position=0)
        o2 = AnswerOption.objects.create(question=oq, text="B", position=1)
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        self.start()
        token = self.join()

        def submit(order):
            return self.client.post(
                f"/api/live/rooms/{self.room.code}/vote/",
                {"token": token, "question": oq.pk, "order": order},
                content_type="application/json",
            )

        self.assertEqual(submit([o1.pk, o2.pk]).status_code, 201)
        response = submit([o2.pk, o1.pk])
        self.assertEqual(response.status_code, 201)

        votes = Vote.objects.filter(
            run=Run.objects.get(), question=oq, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        vote = votes.get()
        order = list(
            OrderingResponse.objects.filter(vote=vote)
            .order_by("position")
            .values_list("option_id", flat=True)
        )
        self.assertEqual(order, [o2.pk, o1.pk])
        self.assertEqual(OrderingResponse.objects.count(), 2)

    def test_malformed_priorities_replace_leaves_original_answer_intact(self):
        # A rejected (400) replacement must never delete the still-valid old
        # answer — validation happens before any delete.
        from .models import PriorityScore

        pq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.PRIORITIES,
            text="<p>Verteile 100 Punkte</p>", position=2,
        )
        oa = AnswerOption.objects.create(question=pq, text="A", position=0)
        ob = AnswerOption.objects.create(question=pq, text="B", position=1)
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        self.start()
        token = self.join()

        def submit(points):
            return self.client.post(
                f"/api/live/rooms/{self.room.code}/vote/",
                {"token": token, "question": pq.pk, "points": points},
                content_type="application/json",
            )

        self.assertEqual(submit({str(oa.pk): 70, str(ob.pk): 30}).status_code, 201)
        # Invalid: total exceeds 100.
        response = submit({str(oa.pk): 90, str(ob.pk): 90})
        self.assertEqual(response.status_code, 400)

        votes = Vote.objects.filter(
            run=Run.objects.get(), question=pq, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        scores = {
            s.option_id: s.points
            for s in PriorityScore.objects.filter(vote=votes.get())
        }
        self.assertEqual(scores, {oa.pk: 70, ob.pk: 30})

    def test_malformed_ordering_replace_leaves_original_answer_intact(self):
        from .models import OrderingResponse

        oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>Bring in order</p>", position=3,
        )
        o1 = AnswerOption.objects.create(question=oq, text="A", position=0)
        o2 = AnswerOption.objects.create(question=oq, text="B", position=1)
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        self.start()
        token = self.join()

        def submit(order):
            return self.client.post(
                f"/api/live/rooms/{self.room.code}/vote/",
                {"token": token, "question": oq.pk, "order": order},
                content_type="application/json",
            )

        self.assertEqual(submit([o1.pk, o2.pk]).status_code, 201)
        # Invalid: not a permutation (missing o2, duplicate o1).
        response = submit([o1.pk, o1.pk])
        self.assertEqual(response.status_code, 400)

        votes = Vote.objects.filter(
            run=Run.objects.get(), question=oq, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        order = list(
            OrderingResponse.objects.filter(vote=votes.get())
            .order_by("position")
            .values_list("option_id", flat=True)
        )
        self.assertEqual(order, [o1.pk, o2.pk])

    def test_live_mode_double_vote_still_conflicts(self):
        # Regression: the replace path is self-paced only; a LIVE run must
        # keep rejecting a second vote outright.
        self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        response = self.vote(token, options=[self.wrong.pk])
        self.assertEqual(response.status_code, 409)
        votes = Vote.objects.filter(
            run=Run.objects.get(), question=self.question, token__key=token
        )
        self.assertEqual(votes.count(), 1)
        self.assertEqual(list(votes.get().options.all()), [self.correct])


class LikertSummaryTests(TestCase):
    """Diverging Likert aggregation (results.likert_summary)."""

    def _opts(self, specs):
        """specs: [(text, count, is_abstention=False), ...] →
        options_with_counts shape. Plain-string text is wrapped as a
        {de, en} map, matching what options_with_counts actually returns."""
        opts = []
        for i, spec in enumerate(specs):
            text, count, *rest = spec
            is_abstention = rest[0] if rest else False
            if not isinstance(text, dict):
                text = {"de": text, "en": ""}
            opts.append(
                {
                    "id": i,
                    "text": text,
                    "is_correct": False,
                    "is_abstention": is_abstention,
                    "count": count,
                }
            )
        return opts

    def test_odd_scale_has_neutral_and_centre_line(self):
        from .results import likert_summary

        # positions 0..4 = low..high; middle (index 2) is neutral.
        summary = likert_summary(self._opts([
            ("Stimme nicht zu", 1), ("", 2), ("", 4), ("", 2), ("Stimme zu", 1),
        ]))
        self.assertEqual(summary["steps"][0]["polarity"], "low")
        self.assertEqual(summary["steps"][2]["polarity"], "neutral")
        self.assertEqual(summary["steps"][4]["polarity"], "high")
        self.assertEqual(summary["low_label"], {"de": "Stimme nicht zu", "en": ""})
        self.assertEqual(summary["high_label"], {"de": "Stimme zu", "en": ""})
        self.assertGreater(summary["high"], 0)
        self.assertGreater(summary["low"], 0)

    def test_even_scale_splits_between_middle_steps(self):
        from .results import likert_summary

        summary = likert_summary(self._opts([("a", 1), ("", 1), ("", 1), ("b", 1)]))
        self.assertIsNone(
            next((s for s in summary["steps"] if s["polarity"] == "neutral"), None)
        )

    def test_too_few_steps_returns_none(self):
        from .results import likert_summary

        self.assertIsNone(likert_summary(self._opts([("a", 1)])))

    def test_mean_weights_by_intensity_not_count_split(self):
        from .results import likert_summary

        # One far-negative (pos 0) + one mildly-positive (pos 3) on a 5-step
        # scale, plus an abstention. The plain count split is 50:50 (divider
        # at 50 %), but the intensity-weighted mean leans left/negative.
        summary = likert_summary(self._opts([
            ("Stimme nicht zu", 1), ("", 0), ("", 0), ("", 1), ("Stimme zu", 0),
            ("Enthaltung", 1, True),
        ]))
        self.assertEqual(summary["scale_total"], 2)
        self.assertEqual(summary["abstentions"], 1)
        self.assertEqual(summary["divider"], 50.0)
        # mean_index = (0*1 + 3*1) / 2 = 1.5 → mean_pct = (1.5+0.5)/5*100 = 40.0
        self.assertEqual(summary["mean_pct"], 40.0)
        # centred: 1.5 - (5-1)/2 = -0.5
        self.assertEqual(summary["mean_score"], -0.5)

    def test_mean_is_centred_when_votes_are_symmetric(self):
        from .results import likert_summary

        # Symmetric distribution → mean sits exactly at the centre.
        summary = likert_summary(self._opts([
            ("a", 1), ("", 0), ("", 0), ("", 0), ("b", 1),
        ]))
        self.assertEqual(summary["mean_pct"], 50.0)
        self.assertEqual(summary["mean_score"], 0.0)


class LikertResultsIntegrationTests(LiveTestCase):
    """Likert summary flows into the results API and CSV export."""

    def setUp(self):
        super().setUp()
        self.likert = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.LIKERT,
            text="<p>Gut strukturiert?</p>", position=5,
        )
        # Negative-first (#86): position 0 = low pole, position N-1 = high
        # pole. steps[0]/steps[-1] carry the low/high endpoint labels.
        # text_de= explicitly (not the bare text= accessor, which follows the
        # active UI language — LANGUAGE_CODE="en" — not the canonical "de").
        self.steps = [
            AnswerOption.objects.create(question=self.likert, text_de=t, position=i)
            for i, t in enumerate(
                ["Stimme nicht zu", "eher nicht", "neutral", "eher", "Stimme zu"]
            )
        ]
        self.abstain = AnswerOption.objects.create(
            question=self.likert, text_de="Enthaltung", position=5, is_abstention=True
        )

    def _cast(self, run, option, n):
        for _ in range(n):
            token = ParticipantToken.objects.create(room=self.room)
            vote = Vote.objects.create(run=run, question=self.likert, token=token)
            vote.options.add(option)

    def test_results_api_includes_likert_summary(self):
        from .results import run_results

        run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.FINISHED
        )
        self._cast(run, self.steps[3], 3)  # eher (high)
        self._cast(run, self.steps[4], 1)  # Stimme zu (high)
        self._cast(run, self.abstain, 2)
        item = next(
            q for q in run_results(run)["questions"] if q["id"] == self.likert.pk
        )
        self.assertEqual(item["likert"]["high"], 4)
        self.assertEqual(item["likert"]["abstentions"], 2)
        self.assertEqual(item["likert"]["high_pct"], 100.0)
        # 3×pos3 + 1×pos4 = mean_index 3.25 → strongly high, right of centre.
        self.assertEqual(item["likert"]["mean_pct"], 75.0)
        self.assertEqual(item["likert"]["mean_score"], 1.25)
        self.assertEqual(
            item["likert"]["high_label"], {"de": "Stimme zu", "en": ""}
        )
        self.assertEqual(
            item["likert"]["low_label"], {"de": "Stimme nicht zu", "en": ""}
        )

    def test_csv_has_percent_column_and_summary_rows(self):
        run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.FINISHED
        )
        self._cast(run, self.steps[4], 3)  # Stimme zu (high)
        self._cast(run, self.abstain, 1)
        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8-sig")
        # Recording mode (#53) added on-site/recording columns before prozent.
        self.assertIn("stimmen;vor_ort;aufzeichnung;prozent", body)
        # Summary rows are labelled with the endpoint text, not a fixed
        # German "Zustimmung"/"Ablehnung" (#86).
        self.assertIn("Zusammenfassung: Stimme zu;;3;;;100.0", body)
        self.assertIn("Zusammenfassung: Enthaltung;;1;", body)


class AiWordCloudTests(LiveTestCase):
    """Optional AI cleanup of a word-cloud result (Paket 2)."""

    def setUp(self):
        super().setUp()
        self.cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD, position=5
        )
        self.run = self.open_question(self.cloud)
        for raw in ["Klima", "Klima", "Klima", "Klimawandel", "Wasser", "Wasser", "Boden"]:
            self.vote(self.join(), text=raw)
        self.url = (
            f"/api/runs/{self.run.pk}/questions/{self.cloud.pk}/ai-wordcloud/"
        )

    @override_settings(**AI_ON)
    def test_merges_variants_recomputes_counts_and_clusters(self):
        reply = {
            "groups": [
                {
                    "label": "Klimawandel",
                    "cluster": "Umwelt",
                    # "Regen" is a hallucination — must be ignored.
                    "members": ["Klima", "Klimawandel", "Regen"],
                },
                {"label": "Wasser", "cluster": "Ressourcen", "members": ["Wasser"]},
            ]
        }
        with patch("basicbar_integrations.ai.chat_json", return_value=reply):
            self.client.force_login(self.owner)
            response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        labels = [c["label"] for c in data["clusters"]]
        # Biggest cluster first; the catch-all "Weitere" sinks to the end.
        self.assertEqual(labels, ["Umwelt", "Ressourcen", "Weitere"])
        umwelt = data["clusters"][0]["words"][0]
        self.assertEqual(umwelt["text"], "Klimawandel")
        self.assertEqual(umwelt["count"], 4)  # 3× Klima + 1× Klimawandel
        self.assertCountEqual(umwelt["variants"], ["Klima", "Klimawandel"])
        # "Boden" was never grouped by the model → its own "Weitere" entry.
        weitere = data["clusters"][-1]
        self.assertEqual(weitere["label"], "Weitere")
        self.assertEqual(weitere["words"][0]["text"], "Boden")
        # merged list is count-sorted and never exceeds the input vocabulary.
        self.assertEqual(data["merged"][0]["text"], "Klimawandel")
        self.assertEqual(sum(w["count"] for w in data["merged"]), 7)

    @override_settings(**AI_ON)
    def test_passes_grouping_instruction(self):
        self.cloud.wordcloud_grouping = "nach Lebensbereich"
        self.cloud.save()
        with patch(
            "basicbar_integrations.ai.chat_json", return_value={"groups": []}
        ) as chat:
            self.client.force_login(self.owner)
            self.assertEqual(self.client.post(self.url).status_code, 200)
        self.assertIn("nach Lebensbereich", chat.call_args[0][0])

    @override_settings(**AI_ON)
    def test_passes_question_merge_flags(self):
        self.cloud.wordcloud_merge_variants = False
        self.cloud.wordcloud_merge_concepts = True
        self.cloud.save()
        with patch(
            "basicbar_integrations.ai.chat_json", return_value={"groups": []}
        ) as chat:
            self.client.force_login(self.owner)
            self.assertEqual(self.client.post(self.url).status_code, 200)
        system = chat.call_args[0][0]
        self.assertNotIn(ai_wordcloud.RULE_VARIANTS, system)
        self.assertIn(ai_wordcloud.KEEP_VARIANTS_APART, system)
        self.assertIn(ai_wordcloud.RULE_CONCEPTS, system)

    @override_settings(**AI_OFF)
    def test_disabled_returns_503(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.post(self.url).status_code, 503)

    @override_settings(**AI_ON)
    def test_requires_owner(self):
        with patch("basicbar_integrations.ai.chat_json", return_value={"groups": []}):
            self.client.force_login(User.objects.create_user(username="eve"))
            self.assertEqual(self.client.post(self.url).status_code, 404)

    @override_settings(**AI_ON)
    def test_non_wordcloud_rejected(self):
        url = f"/api/runs/{self.run.pk}/questions/{self.question.pk}/ai-wordcloud/"
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(self.owner)
            self.assertEqual(self.client.post(url).status_code, 400)
        chat.assert_not_called()

    @override_settings(**AI_ON)
    def test_empty_wordcloud_skips_model(self):
        empty_cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD, position=6
        )
        url = f"/api/runs/{self.run.pk}/questions/{empty_cloud.pk}/ai-wordcloud/"
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(self.owner)
            response = self.client.post(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"clusters": [], "merged": []})
        chat.assert_not_called()


class AiReportTests(LiveTestCase):
    """Optional AI short report of a run (Paket 3)."""

    def _run_with_votes(self):
        run = self.open_question()  # OPEN on the single-choice question
        self.vote(self.join(), options=[self.correct.pk])
        self.vote(self.join(), options=[self.wrong.pk])
        return run

    @override_settings(**AI_ON)
    def test_returns_html_report(self):
        # editor-unify #49: the LLM still answers in Markdown, but the view
        # renders it to sanitized HTML so the client shows it via RichText.
        run = self._run_with_votes()
        with patch(
            "basicbar_integrations.ai.chat_json", return_value={"report": "**Überblick**\n\n- Punkt"}
        ) as chat:
            self.client.force_login(self.owner)
            response = self.client.post(f"/api/runs/{run.pk}/ai-summary/")
        self.assertEqual(response.status_code, 200)
        report = response.json()["report"]
        self.assertIn("<strong>Überblick</strong>", report)
        self.assertIn("<ul>", report)
        self.assertIn("<li>Punkt</li>", report)
        # The prompt carries the aggregated numbers, not raw personal data.
        prompt = chat.call_args.args[1]
        self.assertIn("Antworten insgesamt: 2", prompt)

    @override_settings(**AI_OFF)
    def test_disabled_returns_503(self):
        run = self._run_with_votes()
        self.client.force_login(self.owner)
        self.assertEqual(
            self.client.post(f"/api/runs/{run.pk}/ai-summary/").status_code, 503
        )

    @override_settings(**AI_ON)
    def test_requires_owner(self):
        run = self._run_with_votes()
        with patch("basicbar_integrations.ai.chat_json", return_value={"report": "x"}):
            self.client.force_login(User.objects.create_user(username="eve"))
            self.assertEqual(
                self.client.post(f"/api/runs/{run.pk}/ai-summary/").status_code, 404
            )

    @override_settings(**AI_ON)
    def test_empty_run_skips_model(self):
        run = Run.objects.create(question_set=self.question_set)
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(self.owner)
            response = self.client.post(f"/api/runs/{run.pk}/ai-summary/")
        self.assertEqual(response.status_code, 400)
        chat.assert_not_called()

    @override_settings(**AI_ON)
    def test_blank_report_is_502(self):
        run = self._run_with_votes()
        with patch("basicbar_integrations.ai.chat_json", return_value={"report": "   "}):
            self.client.force_login(self.owner)
            self.assertEqual(
                self.client.post(f"/api/runs/{run.pk}/ai-summary/").status_code, 502
            )


class AiFreeTextTests(LiveTestCase):
    """Optional AI evaluation of free-text answers (Paket 4)."""

    def setUp(self):
        super().setUp()
        self.q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Hauptstadt von Frankreich?</p>", position=5,
        )
        self.run = self.open_question(self.q)
        for raw in ["Paris", "paris", "Berlin", "vielleicht Paris", "keine Ahnung"]:
            self.vote(self.join(), text=raw)
        self.url = f"/api/runs/{self.run.pk}/questions/{self.q.pk}/ai-freetext/"

    @override_settings(**AI_ON)
    def test_classifies_and_recomputes_counts(self):
        reply = {
            "items": [
                {"text": "Paris", "verdict": "korrekt", "note": "Hauptstadt"},
                {"text": "Berlin", "verdict": "falsch"},
                {"text": "vielleicht Paris", "verdict": "BOGUS"},  # invalid → unklar
                {"text": "Lyon", "verdict": "falsch"},  # hallucination → ignored
                # "keine Ahnung" omitted → falls back to unklar
            ]
        }
        with patch("basicbar_integrations.ai.chat_json", return_value=reply):
            self.client.force_login(self.owner)
            response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        groups = {g["verdict"]: g for g in response.json()["groups"]}
        self.assertEqual([g["verdict"] for g in response.json()["groups"]],
                         ["korrekt", "unklar", "falsch"])
        self.assertEqual(groups["korrekt"]["items"][0]["text"], "Paris")
        self.assertEqual(groups["korrekt"]["items"][0]["count"], 2)  # Paris + paris
        self.assertEqual(groups["korrekt"]["items"][0]["note"], "Hauptstadt")
        self.assertEqual(groups["falsch"]["count"], 1)  # only Berlin; Lyon dropped
        unklar_texts = {i["text"] for i in groups["unklar"]["items"]}
        self.assertEqual(unklar_texts, {"vielleicht Paris", "keine Ahnung"})
        total = sum(g["count"] for g in response.json()["groups"])
        self.assertEqual(total, 5)

    @override_settings(**AI_ON)
    def test_reference_reaches_prompt(self):
        with patch("basicbar_integrations.ai.chat_json", return_value={"items": []}) as chat:
            self.client.force_login(self.owner)
            self.client.post(self.url, {"reference": "Paris"},
                             content_type="application/json")
        self.assertIn("Erwartete Antwort", chat.call_args.args[1])
        self.assertIn("Paris", chat.call_args.args[1])

    @override_settings(**AI_OFF)
    def test_disabled_returns_503(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.post(self.url).status_code, 503)

    @override_settings(**AI_ON)
    def test_requires_owner(self):
        with patch("basicbar_integrations.ai.chat_json", return_value={"items": []}):
            self.client.force_login(User.objects.create_user(username="eve"))
            self.assertEqual(self.client.post(self.url).status_code, 404)

    @override_settings(**AI_ON)
    def test_non_open_text_rejected(self):
        url = f"/api/runs/{self.run.pk}/questions/{self.question.pk}/ai-freetext/"
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(self.owner)
            self.assertEqual(self.client.post(url).status_code, 400)
        chat.assert_not_called()


class AiLiveEvalTests(LiveTestCase):
    """Live free-text evaluation during a run (verschoben in die Frage)."""

    def setUp(self):
        super().setUp()
        self.oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Hauptstadt von Frankreich?</p>", position=5,
            ai_evaluate=True, evaluation_hint="Paris",
        )
        self.run = self.open_question(self.oq)

    def _cast(self, text):
        return self.vote(self.join(), text=text)

    @override_settings(**AI_ON)
    def test_evaluate_vote_labels_duplicates_with_one_call(self):
        self._cast("Paris")
        self._cast("paris")  # same text_key → shares the verdict
        first = Vote.objects.filter(question=self.oq).order_by("id").first()
        with patch(
            "basicbar_integrations.ai.chat_json", return_value={"verdict": "korrekt", "note": "ok"}
        ) as chat:
            ai_evaluation.evaluate_vote(first.pk, self.room.pk)
        chat.assert_called_once()
        verdicts = set(
            Vote.objects.filter(question=self.oq).values_list("ai_verdict", flat=True)
        )
        self.assertEqual(verdicts, {"korrekt"})

    @override_settings(**AI_ON)
    def test_evaluate_vote_uses_canonical_language_not_active_thread_language(self):
        # #33 MR2 content-i18n bug: evaluate_vote runs on a ThreadPoolExecutor
        # worker, which never ran LocaleMiddleware, so Django's active
        # language there is settings.LANGUAGE_CODE ("en"), not necessarily
        # the content's canonical language. The AI prompt must still use the
        # canonical (de) question text, never the active-language one.
        self.oq.text_de = "Deutsche Frage"
        self.oq.text_en = "English question"
        self.oq.save()
        self._cast("Paris")
        first = Vote.objects.filter(question=self.oq).order_by("id").first()
        with patch(
            "basicbar_integrations.ai.chat_json", return_value={"verdict": "korrekt", "note": ""}
        ) as chat, translation.override("en"):
            ai_evaluation.evaluate_vote(first.pk, self.room.pk)
        chat.assert_called_once()
        prompt = chat.call_args.args[1]
        self.assertIn("Deutsche Frage", prompt)
        self.assertNotIn("English question", prompt)

    @override_settings(**AI_ON)
    def test_classify_degrades_to_unklar_on_error(self):
        from basicbar_integrations import ai as ai_module

        with patch("basicbar_integrations.ai.chat_json", side_effect=ai_module.AIError("boom")):
            # Failure degrades to the middle category of the scale.
            self.assertEqual(
                ai_evaluation.classify(
                    "Frage", "", "Antwort", ["korrekt", "unklar", "falsch"]
                ),
                ("unklar", ""),
            )

    def test_freetext_evaluation_groups_and_pending(self):
        for text in ["Paris", "Paris", "Berlin", "Lyon"]:
            self._cast(text)
        votes = list(Vote.objects.filter(question=self.oq).order_by("id"))
        Vote.objects.filter(pk__in=[votes[0].pk, votes[1].pk]).update(ai_verdict="korrekt")
        Vote.objects.filter(pk=votes[2].pk).update(ai_verdict="falsch")
        # votes[3] stays pending
        summary = freetext_evaluation(self.run, self.oq)
        groups = {g["verdict"]: g for g in summary["groups"]}
        self.assertEqual(groups["korrekt"]["count"], 2)
        self.assertEqual(groups["korrekt"]["items"][0]["text"], "Paris")
        self.assertEqual(groups["falsch"]["count"], 1)
        self.assertEqual(summary["pending"], 1)
        self.assertEqual(summary["total"], 4)

    def test_vote_schedules_evaluation_for_opted_in_question(self):
        with patch("live.ai_evaluation.schedule") as sched:
            self._cast("irgendetwas")
        sched.assert_called_once()

    def test_plain_open_text_does_not_schedule(self):
        plain = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Feedback?</p>", position=6,
        )
        self.run.active_question = plain  # reuse the single active run
        self.run.save(update_fields=["active_question"])
        with patch("live.ai_evaluation.schedule") as sched:
            self.vote(self.join(), text="war gut")
        sched.assert_not_called()

    def test_presenter_payload_includes_evaluation(self):
        self._cast("Paris")
        Vote.objects.filter(question=self.oq).update(ai_verdict="korrekt")
        presenter = build_payloads(self.room)["presenter"]
        self.assertIn("evaluation", presenter)
        self.assertEqual(presenter["evaluation"]["groups"][0]["verdict"], "korrekt")
        self.assertEqual(presenter["evaluation"]["pending"], 0)


class MyEvaluationTests(LiveTestCase):
    """Token-scoped polling of the caller's own AI verdict (participant
    free-text feedback): GET /api/live/rooms/<code>/my-evaluation/."""

    def setUp(self):
        super().setUp()
        self.oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Hauptstadt von Frankreich?</p>", position=5,
            ai_evaluate=True, participant_feedback=True,
        )
        self.run = self.open_question(self.oq)
        self.token = self.join()
        self.vote(self.token, text="Paris")
        self.my_vote = Vote.objects.get(question=self.oq)

    def _get(self, token, question=None):
        params = {"token": token}
        if question is not None:
            params["question"] = question
        return self.client.get(
            f"/api/live/rooms/{self.room.code}/my-evaluation/", params
        )

    def test_pending_then_ready(self):
        self.assertEqual(self._get(self.token).json(), {"status": "pending"})
        self.my_vote.ai_verdict = "korrekt"
        self.my_vote.ai_note = "gut"
        self.my_vote.save()
        self.assertEqual(
            self._get(self.token).json(),
            {"status": "ready", "verdict": "korrekt", "note": "gut"},
        )

    def test_off_when_participant_feedback_disabled(self):
        self.oq.participant_feedback = False
        self.oq.save(update_fields=["participant_feedback"])
        self.assertEqual(self._get(self.token).json(), {"status": "off"})

    def test_off_when_ai_evaluate_disabled(self):
        self.oq.ai_evaluate = False
        self.oq.save(update_fields=["ai_evaluate"])
        self.assertEqual(self._get(self.token).json(), {"status": "off"})

    def test_off_for_non_open_text_question(self):
        self.run.active_question = self.question  # single_choice
        self.run.save(update_fields=["active_question"])
        self.assertEqual(self._get(self.token).json(), {"status": "off"})

    def test_off_without_active_run(self):
        self.run.delete()
        self.assertEqual(self._get(self.token).json(), {"status": "off"})

    def test_only_own_token_sees_the_verdict(self):
        # Anonymity: a token with no vote of its own never sees this one's
        # verdict, even once it is ready.
        self.my_vote.ai_verdict = "korrekt"
        self.my_vote.ai_note = "gut"
        self.my_vote.save()
        other = self.join()
        self.assertEqual(self._get(other).json(), {"status": "off"})

    def test_unknown_token_is_forbidden(self):
        response = self._get("does-not-exist")
        self.assertEqual(response.status_code, 403)

    def test_self_paced_uses_question_param(self):
        self.run.mode = Run.Mode.SELF_PACED
        self.run.save(update_fields=["mode"])
        self.assertEqual(
            self._get(self.token, question=self.oq.pk).json(), {"status": "pending"}
        )


class MyAnswerTests(LiveTestCase):
    """The caller's OWN existing answer to a question of the current run
    (re-opened questions): POST /api/live/rooms/<code>/my-answer/."""

    def _post(self, token, question):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/my-answer/",
            {"token": token, "question": question},
            content_type="application/json",
        )

    def test_unknown_token_is_forbidden(self):
        self.open_question()
        response = self._post("does-not-exist", self.question.pk)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": "Unknown participant token."})

    def test_question_outside_the_runs_set_is_not_found(self):
        self.open_question()
        other_set = QuestionSet.objects.create(room=self.room, title="Termin 2")
        foreign = Question.objects.create(
            question_set=other_set, kind=Question.Kind.SINGLE_CHOICE, text="x"
        )
        token = self.join()
        self.assertEqual(self._post(token, foreign.pk).status_code, 404)
        self.assertEqual(self._post(token, "abc").status_code, 404)

    def test_not_answered(self):
        self.open_question()
        token = self.join()
        self.assertEqual(
            self._post(token, self.question.pk).json(),
            {"answered": False, "answer": None, "can_change": False},
        )

    def test_no_active_run_is_not_answered(self):
        token = self.join()
        self.assertEqual(self._post(token, self.question.pk).json()["answered"], False)

    def test_single_choice(self):
        self.open_question()
        token = self.join()
        self.vote(token, options=[self.wrong.pk])
        data = self._post(token, self.question.pk).json()
        self.assertTrue(data["answered"])
        self.assertFalse(data["can_change"])
        self.assertEqual(data["answer"]["options"], [{"id": self.wrong.pk}])

    def test_only_own_answer(self):
        # Anonymity: another participant's vote is never exposed.
        self.open_question()
        token = self.join()
        self.vote(token, options=[self.wrong.pk])
        other = self.join()
        self.assertEqual(self._post(other, self.question.pk).json()["answered"], False)

    def test_word_cloud_with_two_terms(self):
        cloud = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            allow_multiple=True, position=3,
        )
        self.open_question(cloud)
        token = self.join()
        self.vote(token, text="Klima")
        self.vote(token, text="Wasser")
        data = self._post(token, cloud.pk).json()
        self.assertTrue(data["answered"])
        self.assertEqual(data["answer"]["text"], ["Klima", "Wasser"])

    def test_priorities_points(self):
        pq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.PRIORITIES,
            text="<p>Verteile</p>", position=3,
        )
        oa = AnswerOption.objects.create(question=pq, text="A", position=0)
        ob = AnswerOption.objects.create(question=pq, text="B", position=1)
        self.open_question(pq)
        token = self.join()
        self.vote(token, points={str(oa.pk): 70, str(ob.pk): 30})
        data = self._post(token, pq.pk).json()
        self.assertEqual(data["answer"]["points"], {str(oa.pk): 70, str(ob.pk): 30})

    def test_ordering_order(self):
        oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>Order</p>", position=3,
        )
        oa = AnswerOption.objects.create(question=oq, text="A", position=0)
        ob = AnswerOption.objects.create(question=oq, text="B", position=1)
        oc = AnswerOption.objects.create(question=oq, text="C", position=2)
        self.open_question(oq)
        token = self.join()
        self.vote(token, order=[oc.pk, oa.pk, ob.pk])
        data = self._post(token, oq.pk).json()
        self.assertEqual(data["answer"]["order"], [oc.pk, oa.pk, ob.pk])

    def test_vote_in_older_run_does_not_count(self):
        old = self.open_question()
        token = self.join()
        self.vote(token, options=[self.correct.pk])
        old.phase = Run.Phase.FINISHED
        old.save(update_fields=["phase"])
        self.open_question()
        self.assertEqual(self._post(token, self.question.pk).json()["answered"], False)

    def test_can_change_mirrors_self_paced_answer_correction(self):
        self.question_set.reveal_answers = "never"
        self.question_set.allow_back_navigation = True
        self.question_set.save()
        run = self.open_question()
        run.mode = Run.Mode.SELF_PACED
        run.save(update_fields=["mode"])
        token = self.join()
        self.vote(token, question=self.question.pk, options=[self.correct.pk])
        data = self._post(token, self.question.pk).json()
        self.assertTrue(data["answered"])
        self.assertTrue(data["can_change"])
        # Feedback on → the server would reject a replacement.
        self.question_set.reveal_answers = "immediately"
        self.question_set.save()
        self.assertFalse(self._post(token, self.question.pk).json()["can_change"])


class AiLiveWordCloudTests(LiveTestCase):
    """Live AI word-cloud views (consolidate + group) during a run (#Wortwolke)."""

    def setUp(self):
        super().setUp()
        self.wc = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            text="<p>Lieblingsband?</p>", position=7, allow_multiple=True,
            wordcloud_ai_enabled=True, wordcloud_grouping="nach Musikgenre",
        )
        self.run = self.open_question(self.wc)
        # Module state is global; make sure each test starts and ends clean.
        self.addCleanup(ai_wordcloud_live._active.clear)
        self.addCleanup(ai_wordcloud_live._results.clear)

    def _cast(self, text):
        return self.vote(self.join(), text=text)

    def test_grouping_criterion_in_system_prompt(self):
        self.assertIn("nach Musikgenre", ai_wordcloud.optimize_system("nach Musikgenre"))
        # Empty falls back to automatic themes (no criterion echoed).
        self.assertNotIn("nach Musikgenre", ai_wordcloud.optimize_system(""))

    def test_prompt_default_flags_variants_and_synonyms_strict(self):
        prompt = ai_wordcloud.optimize_system()
        self.assertIn(ai_wordcloud.RULE_CASE, prompt)
        self.assertIn(ai_wordcloud.RULE_VARIANTS, prompt)
        self.assertIn(ai_wordcloud.RULE_SYNONYMS, prompt)
        self.assertNotIn(ai_wordcloud.RULE_CONCEPTS, prompt)
        self.assertIn(ai_wordcloud.RESTRAINT_STRICT, prompt)
        self.assertNotIn(ai_wordcloud.RESTRAINT_CONCEPTS, prompt)
        self.assertNotIn(ai_wordcloud.KEEP_VARIANTS_APART, prompt)
        self.assertNotIn(ai_wordcloud.KEEP_SYNONYMS_APART, prompt)

    def test_prompt_variants_only(self):
        prompt = ai_wordcloud.optimize_system(
            merge_variants=True, merge_synonyms=False, merge_concepts=False
        )
        self.assertIn(ai_wordcloud.RULE_VARIANTS, prompt)
        self.assertIn("muede", prompt)
        self.assertNotIn(ai_wordcloud.RULE_SYNONYMS, prompt)
        self.assertIn(ai_wordcloud.KEEP_SYNONYMS_APART, prompt)
        self.assertNotIn(ai_wordcloud.RULE_CONCEPTS, prompt)
        self.assertIn(ai_wordcloud.RESTRAINT_STRICT, prompt)

    def test_prompt_synonyms_without_variants(self):
        prompt = ai_wordcloud.optimize_system(
            merge_variants=False, merge_synonyms=True, merge_concepts=False
        )
        self.assertIn(ai_wordcloud.RULE_SYNONYMS, prompt)
        self.assertIn("Einsamkeit", prompt)
        self.assertNotIn(ai_wordcloud.RULE_VARIANTS, prompt)
        self.assertIn(ai_wordcloud.KEEP_VARIANTS_APART, prompt)

    def test_prompt_concepts_on_relaxes_restraint(self):
        prompt = ai_wordcloud.optimize_system(merge_concepts=True)
        self.assertIn(ai_wordcloud.RULE_CONCEPTS, prompt)
        self.assertIn("Gebäude", prompt)
        self.assertIn(ai_wordcloud.RESTRAINT_CONCEPTS, prompt)
        self.assertNotIn(ai_wordcloud.RESTRAINT_STRICT, prompt)
        # Still no merging of merely related topics.
        self.assertIn("Leine", prompt)

    def test_prompt_all_off_only_case(self):
        prompt = ai_wordcloud.optimize_system(
            merge_variants=False, merge_synonyms=False, merge_concepts=False
        )
        self.assertIn(ai_wordcloud.RULE_CASE, prompt)
        for block in (
            ai_wordcloud.RULE_VARIANTS, ai_wordcloud.RULE_SYNONYMS,
            ai_wordcloud.RULE_CONCEPTS,
        ):
            self.assertNotIn(block, prompt)
        self.assertIn(ai_wordcloud.KEEP_VARIANTS_APART, prompt)
        self.assertIn(ai_wordcloud.KEEP_SYNONYMS_APART, prompt)
        self.assertIn(ai_wordcloud.RESTRAINT_STRICT, prompt)
        # Safety rules are always there.
        self.assertIn("ausschließlich die vorgegebenen", prompt)
        self.assertIn("höchstens einer Gruppe", prompt)
        self.assertIn("ausschließlich mit JSON", prompt)

    def test_merge_flags_helper_reads_question(self):
        self.wc.wordcloud_merge_variants = False
        self.wc.wordcloud_merge_concepts = True
        self.assertEqual(
            ai_wordcloud.merge_flags(self.wc),
            {"merge_variants": False, "merge_synonyms": True,
             "merge_concepts": True},
        )

    @override_settings(**AI_ON)
    def test_compute_passes_question_merge_flags(self):
        self._cast("Haus")
        self.wc.wordcloud_merge_synonyms = False
        self.wc.wordcloud_merge_concepts = True
        self.wc.save()
        with patch(
            "basicbar_integrations.ai.chat_json", return_value={"groups": []}
        ) as chat:
            ai_wordcloud_live._compute(self.run.pk, self.wc.pk, self.room.pk)
        system = chat.call_args[0][0]
        self.assertIn("nach Musikgenre", system)
        self.assertIn(ai_wordcloud.RULE_CONCEPTS, system)
        self.assertNotIn(ai_wordcloud.RULE_SYNONYMS, system)
        self.assertIn(ai_wordcloud.RULE_VARIANTS, system)

    @override_settings(**AI_ON)
    def test_activate_endpoint_toggles(self):
        self.client.force_login(self.owner)
        url = f"/api/runs/{self.run.pk}/wordcloud-ai/"
        with patch("live.ai_wordcloud_live.schedule"):
            resp = self.client.post(
                url, {"question": self.wc.pk, "active": True},
                content_type="application/json",
            )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(ai_wordcloud_live.is_active(self.run.pk, self.wc.pk))
        self.client.post(
            url, {"question": self.wc.pk, "active": False},
            content_type="application/json",
        )
        self.assertFalse(ai_wordcloud_live.is_active(self.run.pk, self.wc.pk))

    @override_settings(**AI_ON)
    def test_activate_rejects_when_not_enabled_for_question(self):
        self.wc.wordcloud_ai_enabled = False
        self.wc.save(update_fields=["wordcloud_ai_enabled"])
        self.client.force_login(self.owner)
        resp = self.client.post(
            f"/api/runs/{self.run.pk}/wordcloud-ai/",
            {"question": self.wc.pk, "active": True},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    @override_settings(**AI_ON)
    def test_activate_rejects_non_word_cloud(self):
        # AI switched on for the choice question, so only the kind check fails.
        self.question.wordcloud_ai_enabled = True
        self.question.save(update_fields=["wordcloud_ai_enabled"])
        self.client.force_login(self.owner)
        resp = self.client.post(
            f"/api/runs/{self.run.pk}/wordcloud-ai/",
            {"question": self.question.pk, "active": True},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_activate_requires_ai_and_owner(self):
        # AI disabled → 503.
        self.client.force_login(self.owner)
        with override_settings(**AI_OFF):
            resp = self.client.post(
                f"/api/runs/{self.run.pk}/wordcloud-ai/",
                {"question": self.wc.pk, "active": True},
                content_type="application/json",
            )
        self.assertEqual(resp.status_code, 503)
        # Foreign user → 404.
        eve = User.objects.create_user(username="eve2")
        self.client.force_login(eve)
        with override_settings(**AI_ON):
            resp = self.client.post(
                f"/api/runs/{self.run.pk}/wordcloud-ai/",
                {"question": self.wc.pk, "active": True},
                content_type="application/json",
            )
        self.assertEqual(resp.status_code, 404)

    @override_settings(**AI_ON)
    def test_compute_stores_views_and_payload_carries_them(self):
        self._cast("Beatles")
        self._cast("Beatls")  # misspelling → merged by the model
        key = (self.run.pk, self.wc.pk)
        ai_wordcloud_live._active.add(key)
        grouped = {
            "groups": [
                {"label": "Beatles", "cluster": "Rock",
                 "members": ["Beatles", "Beatls"]},
            ]
        }
        with patch("basicbar_integrations.ai.chat_json", return_value=grouped) as chat:
            ai_wordcloud_live._compute(self.run.pk, self.wc.pk, self.room.pk)
        chat.assert_called_once()
        result = ai_wordcloud_live.get_result(*key)
        self.assertFalse(result["pending"])
        # Counts recomputed server-side: both spellings collapse to count 2.
        self.assertEqual(result["merged"][0]["text"], "Beatles")
        self.assertEqual(result["merged"][0]["count"], 2)
        self.assertEqual(result["clusters"][0]["label"], "Rock")
        # Presenter payload surfaces the AI views while active.
        presenter = build_payloads(self.room)["presenter"]
        self.assertIn("wordcloud_ai", presenter)
        self.assertEqual(presenter["wordcloud_ai"]["clusters"][0]["label"], "Rock")

    def test_vote_schedules_wordcloud_ai(self):
        with patch("live.ai_wordcloud_live.schedule") as sched:
            self._cast("Queen")
        sched.assert_called_once()

    # --- Moderation in AI views: raw keys + recompute ---------------------

    def test_apply_optimization_carries_raw_keys(self):
        words = [
            # Manual merge: several raw keys under one label text.
            {"text": "Beatles", "count": 3, "keys": ["beatles", "beatls"]},
            {"text": "Queen", "count": 2, "keys": ["queen"]},
            {"text": "Abba", "count": 1, "keys": ["abba"]},
            {"text": "Bach", "count": 1, "keys": ["bach"]},
        ]
        data = {"groups": [
            {"label": "Rockbands", "cluster": "Rock",
             "members": ["Beatles", "Queen"]},
            {"label": "Abba", "cluster": "Pop", "members": ["Abba"]},
        ]}
        out = ai_wordcloud.apply_optimization(words, data)
        by_text = {w["text"]: w for w in out["merged"]}
        self.assertEqual(by_text["Rockbands"]["keys"], ["beatles", "beatls", "queen"])
        self.assertEqual(by_text["Abba"]["keys"], ["abba"])
        # Ignored by the model → own "Weitere" entry, still with its keys.
        self.assertEqual(by_text["Bach"]["keys"], ["bach"])
        for cluster in out["clusters"]:
            for w in cluster["words"]:
                self.assertEqual(w["keys"], by_text[w["text"]]["keys"])

    def test_apply_optimization_keys_fallback_without_keys(self):
        out = ai_wordcloud.apply_optimization(
            [{"text": "Mozart", "count": 1}], {"groups": []}
        )
        self.assertEqual(out["merged"][0]["keys"], ["mozart"])

    def test_apply_optimization_dedupes_keys_of_case_duplicates(self):
        words = [
            {"text": "Jazz", "count": 1, "keys": ["jazz"]},
            {"text": "jazz", "count": 1, "keys": ["jazz"]},
        ]
        out = ai_wordcloud.apply_optimization(words, {"groups": []})
        self.assertEqual(out["merged"][0]["keys"], ["jazz"])
        self.assertEqual(out["merged"][0]["count"], 2)

    def _moderate(self, body):
        self.client.force_login(self.owner)
        return self.client.post(
            f"/api/runs/{self.run.pk}/wordcloud/{self.wc.pk}/moderation",
            body, content_type="application/json",
        )

    def test_moderation_triggers_ai_refresh(self):
        self._cast("Queen")
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            self.assertEqual(self._moderate({"op": "hide", "keys": ["queen"]}).status_code, 200)
            self.assertEqual(
                self._moderate({"op": "merge", "keys": ["queen", "abba"], "label": "Q"}).status_code,
                200,
            )
        self.assertEqual(refresh.call_count, 2)
        refresh.assert_called_with(self.run.pk, self.wc.pk, self.room.pk)

    def _refresh_submits(self):
        with patch.object(ai_wordcloud_live._executor, "submit") as submit:
            ai_wordcloud_live.refresh(self.run.pk, self.wc.pk, self.room.pk)
        return submit

    @override_settings(**AI_ON)
    def test_refresh_recomputes_active_view(self):
        self.addCleanup(ai_wordcloud_live._running.clear)
        key = (self.run.pk, self.wc.pk)
        ai_wordcloud_live._active.add(key)
        ai_wordcloud_live._results[key] = {"merged": [], "clusters": [], "pending": False}
        self._refresh_submits().assert_called_once()

    @override_settings(**AI_ON)
    def test_refresh_recomputes_warm_cache_when_inactive(self):
        # Kept warm after toggle-off / vote close (#75): a moderation change
        # must not leave the cached AI view stale.
        self.addCleanup(ai_wordcloud_live._running.clear)
        key = (self.run.pk, self.wc.pk)
        ai_wordcloud_live._results[key] = {"merged": [], "clusters": [], "pending": False}
        self._refresh_submits().assert_called_once()
        self.assertFalse(ai_wordcloud_live.is_active(*key))

    @override_settings(**AI_ON)
    def test_refresh_noop_when_never_computed(self):
        self._refresh_submits().assert_not_called()

    @override_settings(**AI_OFF)
    def test_refresh_noop_when_ai_disabled(self):
        key = (self.run.pk, self.wc.pk)
        ai_wordcloud_live._active.add(key)
        ai_wordcloud_live._results[key] = {"merged": [], "clusters": [], "pending": False}
        self._refresh_submits().assert_not_called()

    @override_settings(**AI_ON)
    def test_refresh_while_running_folds_into_trailing_pass(self):
        key = (self.run.pk, self.wc.pk)
        self.addCleanup(ai_wordcloud_live._running.clear)
        self.addCleanup(ai_wordcloud_live._dirty.clear)
        ai_wordcloud_live._results[key] = {"merged": [], "clusters": [], "pending": False}
        ai_wordcloud_live._running.add(key)
        self._refresh_submits().assert_not_called()
        self.assertIn(key, ai_wordcloud_live._dirty)
        # The running loop honours the trailing pass even when inactive.
        calls = []
        with patch.object(ai_wordcloud_live, "_compute", side_effect=lambda *a: calls.append(a)), \
                patch.object(ai_wordcloud_live.time, "sleep"):
            ai_wordcloud_live._run_loop(self.run.pk, self.wc.pk, self.room.pk)
        self.assertEqual(len(calls), 2)
        self.assertNotIn(key, ai_wordcloud_live._running)

    def test_run_loop_exit_does_not_clobber_a_newer_loop(self):
        # Race: after the loop's normal exit released the lock, a new trigger
        # starts a second loop (re-adds `_running`, marks `_dirty`). The old
        # loop must not wipe that newer loop's state on its way out.
        key = (self.run.pk, self.wc.pk)
        self.addCleanup(ai_wordcloud_live._running.clear)
        self.addCleanup(ai_wordcloud_live._dirty.clear)
        real_lock = ai_wordcloud_live._lock

        class RacingLock:
            fired = False

            def __enter__(self):
                return real_lock.__enter__()

            def __exit__(self, *exc):
                real_lock.__exit__(*exc)
                if not RacingLock.fired and key not in ai_wordcloud_live._running:
                    RacingLock.fired = True  # newer loop starts right here
                    ai_wordcloud_live._running.add(key)
                    ai_wordcloud_live._dirty.add(key)
                return False

        ai_wordcloud_live._running.add(key)
        with patch.object(ai_wordcloud_live, "_lock", RacingLock()), \
                patch.object(ai_wordcloud_live, "_compute"):
            ai_wordcloud_live._run_loop(self.run.pk, self.wc.pk, self.room.pk)
        self.assertTrue(RacingLock.fired)
        self.assertIn(key, ai_wordcloud_live._running)
        self.assertIn(key, ai_wordcloud_live._dirty)

    def test_run_loop_cleans_up_after_compute_error(self):
        key = (self.run.pk, self.wc.pk)
        ai_wordcloud_live._running.add(key)
        ai_wordcloud_live._dirty.add(key)
        with patch.object(ai_wordcloud_live, "_compute", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                ai_wordcloud_live._run_loop(self.run.pk, self.wc.pk, self.room.pk)
        self.assertNotIn(key, ai_wordcloud_live._running)
        self.assertNotIn(key, ai_wordcloud_live._dirty)


class FreetextScaleTests(LiveTestCase):
    """Configurable free-text scale (correctness / sentiment / custom)."""

    def setUp(self):
        super().setUp()
        from . import ai_freetext
        self.ai_freetext = ai_freetext

    def test_clean_categories_and_middle(self):
        f = self.ai_freetext
        self.assertEqual(f.clean_categories(["A", "a", " B "]), ["A", "B"])
        # <2 or >5 → default correctness scale.
        self.assertEqual(f.clean_categories(["nur eins"]), ["korrekt", "unklar", "falsch"])
        self.assertEqual(f.middle_category(["positiv", "neutral", "negativ"]), "neutral")

    def test_apply_evaluation_sentiment_and_fallback(self):
        answers = [{"text": "Toll", "count": 2}, {"text": "Ok", "count": 1},
                   {"text": "Mist", "count": 1}, {"text": "Hm", "count": 1}]
        data = {"items": [
            {"text": "Toll", "verdict": "positiv"},
            {"text": "Mist", "verdict": "negativ"},
            {"text": "Ok", "verdict": "quatsch"},  # unknown → middle (neutral)
            # "Hm" skipped → middle (neutral)
        ]}
        cats = ["positiv", "neutral", "negativ"]
        out = self.ai_freetext.apply_evaluation(answers, data, cats)
        self.assertEqual(out["categories"], cats)
        groups = {g["verdict"]: g for g in out["groups"]}
        self.assertEqual([g["verdict"] for g in out["groups"]], cats)  # order kept
        self.assertEqual(groups["positiv"]["count"], 2)
        self.assertEqual(groups["negativ"]["count"], 1)
        self.assertEqual(groups["neutral"]["count"], 2)  # Ok + Hm

    def test_freetext_evaluation_uses_scale_and_chart(self):
        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Wie fandest du es?</p>", position=8, ai_evaluate=True,
            evaluation_categories=["positiv", "neutral", "negativ"],
            evaluation_chart=True,
        )
        run = self.open_question(q)
        token = self.join()
        self.vote(token, text="Super")
        Vote.objects.filter(question=q).update(ai_verdict="positiv")
        summary = freetext_evaluation(run, q)
        self.assertEqual(summary["categories"], ["positiv", "neutral", "negativ"])
        self.assertTrue(summary["chart"])
        groups = {g["verdict"]: g for g in summary["groups"]}
        self.assertEqual(groups["positiv"]["count"], 1)


class FreetextScaleSerializerTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.owner)

    def _create(self, categories):
        return self.client.post(
            "/api/questions/",
            {"question_set": self.question_set.pk, "kind": "open_text",
             "evaluation_categories": categories},
            content_type="application/json",
        )

    def test_custom_scale_saved(self):
        r = self._create(["Pro", "Contra"])
        self.assertEqual(r.status_code, 201)
        self.assertEqual(
            Question.objects.get(pk=r.json()["id"]).evaluation_categories,
            ["Pro", "Contra"],
        )

    def test_too_few_or_many_falls_back_to_default(self):
        r = self._create(["nur eins"])
        self.assertEqual(
            Question.objects.get(pk=r.json()["id"]).evaluation_categories,
            ["korrekt", "unklar", "falsch"],
        )


class RecordingModeTests(LiveTestCase):
    """Recording mode (#53) — async viewer voting on the original run."""

    def _start_recording(self, mode="live"):
        self.client.force_login(self.owner)
        data = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": mode, "recording": True},
            content_type="application/json",
        ).json()
        self.client.logout()
        return data

    def test_start_run_mints_recording_token_for_live(self):
        data = self._start_recording()
        self.assertTrue(data["recording_token"])
        self.assertTrue(Run.objects.get(pk=data["run"]).recording_token)

    def test_self_paced_ignores_recording(self):
        data = self._start_recording(mode="self_paced")
        self.assertIsNone(data["recording_token"])

    def test_recording_questions_lists_questions(self):
        rec = self._start_recording()["recording_token"]
        payload = self.client.get(f"/api/live/recording/{rec}/").json()
        self.assertEqual(len(payload["questions"]), 1)
        self.assertEqual(payload["room_code"], self.room.code)

    def test_recording_vote_records_recording_source_and_results(self):
        data = self._start_recording()
        run = Run.objects.get(pk=data["run"])
        rec = data["recording_token"]
        viewer = self.join()
        body = {"token": viewer, "question": self.question.pk, "options": [self.correct.pk]}
        resp = self.client.post(
            f"/api/live/recording/{rec}/vote/", body, content_type="application/json"
        )
        self.assertEqual(resp.status_code, 201)
        self.assertIn("results", resp.json())
        vote = Vote.objects.get(run=run, question=self.question)
        self.assertEqual(vote.source, Vote.Source.RECORDING)
        # One vote per viewer/question.
        again = self.client.post(
            f"/api/live/recording/{rec}/vote/", body, content_type="application/json"
        )
        self.assertEqual(again.status_code, 409)

    def test_recording_vote_unknown_token_404(self):
        resp = self.client.post(
            "/api/live/recording/does-not-exist/vote/",
            {"token": "x", "question": self.question.pk, "options": [self.correct.pk]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 404)

    def test_recording_vote_foreign_question_400(self):
        rec = self._start_recording()["recording_token"]
        other_set = QuestionSet.objects.create(room=self.room, title="Other")
        foreign = Question.objects.create(
            question_set=other_set, kind=Question.Kind.SINGLE_CHOICE, text="<p>x</p>"
        )
        viewer = self.join()
        resp = self.client.post(
            f"/api/live/recording/{rec}/vote/",
            {"token": viewer, "question": foreign.pk, "options": []},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_recording_answered_map_resumes_with_results(self):
        data = self._start_recording()
        rec = data["recording_token"]
        viewer = self.join()
        self.client.post(
            f"/api/live/recording/{rec}/vote/",
            {"token": viewer, "question": self.question.pk, "options": [self.correct.pk]},
            content_type="application/json",
        )
        payload = self.client.get(f"/api/live/recording/{rec}/?token={viewer}").json()
        self.assertIn(str(self.question.pk), payload["answered"])
        self.assertIn("results", payload["answered"][str(self.question.pk)])

    def test_control_run_enables_recording(self):
        # The beamer lobby toggle turns on recording on the live run.
        run = self.open_question()
        self.client.force_login(self.owner)
        resp = self.client.post(
            f"/api/runs/{run.pk}/control/",
            {"recording": True},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["recording_token"])
        run.refresh_from_db()
        self.assertTrue(run.recording_token)

    def test_recording_qr_returns_png(self):
        rec = self._start_recording()["recording_token"]
        resp = self.client.get(f"/r/{rec}/qr.png?q={self.question.pk}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Content-Type"], "image/png")

    def test_recording_page_renders(self):
        rec = self._start_recording()["recording_token"]
        resp = self.client.get(f"/r/{rec}/?q={self.question.pk}")
        self.assertEqual(resp.status_code, 200)

    def test_results_split_onsite_recording(self):
        # MR B: results carry the on-site/recording split + combined total.
        from live.results import run_results

        run = self.open_question()
        run.enable_recording()
        onsite_token = self.join()
        self.vote(onsite_token, options=[self.correct.pk])  # on-site
        viewer = ParticipantToken.objects.create(room=self.room)
        rec_vote = Vote.objects.create(
            run=run, question=self.question, token=viewer,
            source=Vote.Source.RECORDING,
        )
        rec_vote.options.set([self.wrong])
        data = run_results(run)
        self.assertEqual(data["recording_votes"], 1)
        q = data["questions"][0]
        self.assertEqual(q["votes_recording"], 1)
        by_text = {resolve_translated_text(o["text"]): o for o in q["options"]}
        self.assertEqual((by_text["4"]["onsite"], by_text["4"]["recording"]), (1, 0))
        self.assertEqual((by_text["5"]["onsite"], by_text["5"]["recording"]), (0, 1))
        self.assertEqual(by_text["5"]["count"], 1)

    def test_csv_has_source_columns(self):
        self.open_question()
        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8")
        self.assertIn("vor_ort", body.splitlines()[0])
        self.assertIn("aufzeichnung", body.splitlines()[0])


class DeterministicActiveRunTests(LiveTestCase):
    def test_active_run_prefers_newest_on_created_at_tie(self):
        # Two unfinished runs in the same room (different sets — allowed by
        # the per-set constraint). With identical created_at, selection must
        # fall back to -id, i.e. the newest run wins deterministically.
        set2 = QuestionSet.objects.create(room=self.room, title="Termin 2")
        run_a = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.OPEN
        )
        run_b = Run.objects.create(question_set=set2, phase=Run.Phase.OPEN)
        ts = timezone.now()
        Run.objects.filter(pk__in=[run_a.pk, run_b.pk]).update(created_at=ts)

        self.assertEqual(active_run(self.room).pk, max(run_a.pk, run_b.pk))


class OneActiveRunPerRoomTests(LiveTestCase):
    def login(self):
        self.client.force_login(self.owner)

    def _open_run_on(self, question_set):
        return Run.objects.create(
            question_set=question_set, phase=Run.Phase.OPEN
        )

    def _start(self):
        return self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {},
            content_type="application/json",
        ).json()

    def test_start_archives_other_set_run_with_votes(self):
        self.login()
        set2 = QuestionSet.objects.create(room=self.room, title="Termin 2")
        other = self._open_run_on(set2)
        tok = ParticipantToken.objects.create(room=self.room)
        Vote.objects.create(run=other, question=self.question, token=tok)

        resp = self._start()

        other.refresh_from_db()
        self.assertEqual(other.phase, Run.Phase.FINISHED)
        self.assertIsNotNone(other.ended_at)
        self.assertEqual(other.votes.count(), 1)  # archived, not lost
        self.assertEqual(active_run(self.room).pk, resp["run"])

    def test_start_deletes_empty_other_set_run(self):
        self.login()
        set2 = QuestionSet.objects.create(room=self.room, title="Termin 2")
        other = self._open_run_on(set2)

        resp = self._start()

        self.assertFalse(Run.objects.filter(pk=other.pk).exists())
        self.assertEqual(active_run(self.room).pk, resp["run"])

    def test_start_archives_other_set_run_with_recording_token(self):
        # Regression: a run with a minted recording token but no live votes
        # yet must be archived, not deleted — deleting it would destroy the
        # shared /r/<token>/ link and lose future async recording votes.
        self.login()
        set2 = QuestionSet.objects.create(room=self.room, title="Termin 2")
        other = self._open_run_on(set2)
        token = other.enable_recording()
        self.assertEqual(other.votes.count(), 0)

        resp = self._start()

        other.refresh_from_db()
        self.assertEqual(other.phase, Run.Phase.FINISHED)
        self.assertIsNotNone(other.ended_at)
        self.assertEqual(other.recording_token, token)
        self.assertEqual(active_run(self.room).pk, resp["run"])

    def test_target_set_own_run_untouched(self):
        # Regression: the target set's own unfinished run must be reused,
        # never swept by the cross-set cleanup.
        self.login()
        own = self._open_run_on(self.question_set)

        resp = self._start()

        self.assertEqual(resp["run"], own.pk)
        self.assertTrue(Run.objects.filter(pk=own.pk).exists())


class PriorityScoreModelTests(LiveTestCase):
    def test_kind_and_model_exist(self):
        from .models import PriorityScore

        q = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.PRIORITIES,
            text="<p>Verteile 100 Punkte</p>",
            position=1,
        )
        opt = AnswerOption.objects.create(question=q, text="A", position=0)
        run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.OPEN, active_question=q
        )
        tok = ParticipantToken.objects.create(room=self.room)
        vote = Vote.objects.create(run=run, question=q, token=tok)
        score = PriorityScore.objects.create(vote=vote, option=opt, points=40)

        self.assertEqual(vote.priority_scores.get().points, 40)
        self.assertEqual(score.option, opt)


class OrderingResponseModelTests(LiveTestCase):
    def test_kind_and_model_exist(self):
        from .models import OrderingResponse

        q = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.ORDERING,
            text="<p>Bring in order</p>",
            position=1,
        )
        opt = AnswerOption.objects.create(question=q, text="A", position=0)
        run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.OPEN, active_question=q
        )
        tok = ParticipantToken.objects.create(room=self.room)
        vote = Vote.objects.create(run=run, question=q, token=tok)
        resp = OrderingResponse.objects.create(vote=vote, option=opt, position=0)

        self.assertEqual(vote.ordering_responses.get().position, 0)
        self.assertEqual(resp.option, opt)

    def test_unique_per_vote_option(self):
        from django.db import IntegrityError

        from .models import OrderingResponse

        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>O</p>", position=1,
        )
        opt = AnswerOption.objects.create(question=q, text="A", position=0)
        run = Run.objects.create(question_set=self.question_set, phase=Run.Phase.OPEN, active_question=q)
        tok = ParticipantToken.objects.create(room=self.room)
        vote = Vote.objects.create(run=run, question=q, token=tok)
        OrderingResponse.objects.create(vote=vote, option=opt, position=0)
        with self.assertRaises(IntegrityError):
            OrderingResponse.objects.create(vote=vote, option=opt, position=1)


class PrioritiesVoteTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.pq = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.PRIORITIES,
            text="<p>Verteile</p>",
            position=1,
        )
        self.oa = AnswerOption.objects.create(question=self.pq, text="A", position=0)
        self.ob = AnswerOption.objects.create(question=self.pq, text="B", position=1)
        self.oc = AnswerOption.objects.create(question=self.pq, text="C", position=2)
        self.run = Run.objects.create(
            question_set=self.question_set,
            phase=Run.Phase.OPEN,
            active_question=self.pq,
        )

    def _vote(self, token, points, **extra):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/vote/",
            {"token": token, "points": points, **extra},
            content_type="application/json",
        )

    def test_valid_submission_stores_all_options_incl_zero(self):
        token = self.join()
        resp = self._vote(token, {str(self.oa.pk): 60, str(self.ob.pk): 40})
        self.assertEqual(resp.status_code, 201)
        vote = self.run.votes.get(token__key=token)
        scores = {s.option_id: s.points for s in vote.priority_scores.all()}
        self.assertEqual(scores, {self.oa.pk: 60, self.ob.pk: 40, self.oc.pk: 0})

    def test_partial_under_100_allowed(self):
        token = self.join()
        self.assertEqual(self._vote(token, {str(self.oa.pk): 30}).status_code, 201)

    def test_sum_over_100_rejected(self):
        token = self.join()
        resp = self._vote(token, {str(self.oa.pk): 60, str(self.ob.pk): 50})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self.run.votes.count(), 0)

    def test_negative_or_too_large_rejected(self):
        token = self.join()
        self.assertEqual(self._vote(token, {str(self.oa.pk): -1}).status_code, 400)
        self.assertEqual(self._vote(token, {str(self.oa.pk): 101}).status_code, 400)

    def test_unknown_option_rejected(self):
        token = self.join()
        other = AnswerOption.objects.create(question=self.question, text="X", position=9)
        self.assertEqual(self._vote(token, {str(other.pk): 10}).status_code, 400)

    def test_double_vote_rejected(self):
        token = self.join()
        self.assertEqual(self._vote(token, {str(self.oa.pk): 10}).status_code, 201)
        self.assertEqual(self._vote(token, {str(self.oa.pk): 20}).status_code, 409)

    def test_self_paced_submission(self):
        self.run.mode = Run.Mode.SELF_PACED
        self.run.save(update_fields=["mode"])
        token = self.join()
        resp = self._vote(token, {str(self.oa.pk): 50}, question=self.pq.pk)
        self.assertEqual(resp.status_code, 201)


class OrderingVoteTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>Order</p>", position=1,
        )
        self.oa = AnswerOption.objects.create(question=self.oq, text="A", position=0)
        self.ob = AnswerOption.objects.create(question=self.oq, text="B", position=1)
        self.oc = AnswerOption.objects.create(question=self.oq, text="C", position=2)
        self.run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.OPEN, active_question=self.oq,
        )

    def _vote(self, token, order, **extra):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/vote/",
            {"token": token, "order": order, **extra},
            content_type="application/json",
        )

    def test_valid_submission_stores_positions(self):
        token = self.join()
        resp = self._vote(token, [self.ob.pk, self.oa.pk, self.oc.pk])
        self.assertEqual(resp.status_code, 201)
        vote = self.run.votes.get(token__key=token)
        pos = {r.option_id: r.position for r in vote.ordering_responses.all()}
        self.assertEqual(pos, {self.ob.pk: 0, self.oa.pk: 1, self.oc.pk: 2})

    def test_incomplete_order_rejected(self):
        token = self.join()
        resp = self._vote(token, [self.oa.pk, self.ob.pk])  # missing C
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self.run.votes.count(), 0)

    def test_duplicate_in_order_rejected(self):
        token = self.join()
        resp = self._vote(token, [self.oa.pk, self.oa.pk, self.ob.pk])
        self.assertEqual(resp.status_code, 400)

    def test_unknown_option_rejected(self):
        token = self.join()
        other = AnswerOption.objects.create(question=self.question, text="X", position=9)
        resp = self._vote(token, [self.oa.pk, self.ob.pk, other.pk])
        self.assertEqual(resp.status_code, 400)

    def test_double_vote_rejected(self):
        token = self.join()
        self.assertEqual(self._vote(token, [self.oa.pk, self.ob.pk, self.oc.pk]).status_code, 201)
        self.assertEqual(self._vote(token, [self.oc.pk, self.ob.pk, self.oa.pk]).status_code, 409)

    def test_self_paced_submission(self):
        self.run.mode = Run.Mode.SELF_PACED
        self.run.save(update_fields=["mode"])
        token = self.join()
        resp = self._vote(token, [self.oa.pk, self.ob.pk, self.oc.pk], question=self.oq.pk)
        self.assertEqual(resp.status_code, 201)

    def test_recording_vote_stores_ordering(self):
        self.run.enable_recording()
        token = self.join()
        resp = self.client.post(
            f"/api/live/recording/{self.run.recording_token}/vote/",
            {"token": token, "question": self.oq.pk,
             "order": [self.oa.pk, self.ob.pk, self.oc.pk]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertIn("ordering", resp.json())


class OrderingStatsTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        from .models import OrderingResponse
        self.OrderingResponse = OrderingResponse
        self.oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>O</p>", position=1,
        )
        self.oa = AnswerOption.objects.create(question=self.oq, text="A", position=0)
        self.ob = AnswerOption.objects.create(question=self.oq, text="B", position=1)
        self.oc = AnswerOption.objects.create(question=self.oq, text="C", position=2)
        self.run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.CLOSED, active_question=self.oq,
        )

    def _submit(self, order):  # order = list of options in the participant's sequence
        tok = ParticipantToken.objects.create(room=self.room)
        vote = Vote.objects.create(run=self.run, question=self.oq, token=tok)
        self.OrderingResponse.objects.bulk_create(
            [self.OrderingResponse(vote=vote, option=opt, position=idx)
             for idx, opt in enumerate(order)]
        )

    def test_correct_rates_and_full_rate(self):
        from .results import ordering_stats
        self._submit([self.oa, self.ob, self.oc])          # fully correct
        self._submit([self.oa, self.oc, self.ob])          # A right, B/C wrong
        stats = ordering_stats(self.run, self.oq)
        items = {it["id"]: it for it in stats["items"]}
        self.assertEqual([it["correct_position"] for it in stats["items"]], [1, 2, 3])
        self.assertEqual(items[self.oa.pk]["correct_rate"], 100.0)   # 2/2
        self.assertEqual(items[self.ob.pk]["correct_rate"], 50.0)    # 1/2
        self.assertEqual(items[self.oc.pk]["correct_rate"], 50.0)    # 1/2
        self.assertEqual(stats["full_correct_rate"], 50.0)           # 1/2 fully correct
        self.assertEqual(stats["n"], 2)

    def test_empty_run(self):
        from .results import ordering_stats
        stats = ordering_stats(self.run, self.oq)
        self.assertEqual(stats["n"], 0)
        self.assertEqual(stats["full_correct_rate"], 0)
        self.assertEqual([it["correct_rate"] for it in stats["items"]], [0, 0, 0])

    def test_run_results_includes_ordering(self):
        from .results import run_results
        self._submit([self.oa, self.ob, self.oc])
        item = next(q for q in run_results(self.run)["questions"] if q["id"] == self.oq.pk)
        self.assertEqual(item["kind"], "ordering")
        self.assertIn("ordering", item)

    def test_presenter_and_participant_payloads(self):
        from .state import build_payloads
        # Participant results are gated per-set (v2 option); enable them so
        # the participant branch is exercised too, mirroring
        # PriorityRecordingAndResetTests.test_participant_results_when_enabled.
        self.question_set.show_results_to_participants = True
        self.question_set.save(update_fields=["show_results_to_participants"])
        self.run.phase = Run.Phase.RESULTS
        self.run.save(update_fields=["phase"])
        self._submit([self.oa, self.ob, self.oc])
        payloads = build_payloads(self.room)
        self.assertIn("ordering", payloads["presenter"])
        self.assertIn("ordering", payloads["participant"])

    def test_links_full_correct_single_chain(self):
        from .results import ordering_stats
        self._submit([self.oa, self.ob, self.oc])
        self._submit([self.oa, self.ob, self.oc])
        stats = ordering_stats(self.run, self.oq)
        self.assertEqual(
            [(l["from"], l["to"], l["rate"]) for l in stats["links"]],
            [(self.oa.pk, self.ob.pk, 100.0), (self.ob.pk, self.oc.pk, 100.0)],
        )
        self.assertEqual(stats["chains"], [{"start": 0, "end": 2, "rate": 100.0}])

    def test_links_partial_swap(self):
        from .results import ordering_stats
        self._submit([self.oa, self.ob, self.oc])   # A,B,C
        self._submit([self.ob, self.oa, self.oc])   # B,A,C (A/B swapped)
        stats = ordering_stats(self.run, self.oq)
        # A->B adjacency holds only in submission 1; B->C only in submission 1.
        self.assertEqual([l["rate"] for l in stats["links"]], [50.0, 50.0])
        # Both links >= 50 -> one chain over all items; whole-run correct = 1/2.
        self.assertEqual(stats["chains"], [{"start": 0, "end": 2, "rate": 50.0}])

    def test_chains_split_on_weak_link(self):
        from .results import ordering_stats
        od = AnswerOption.objects.create(question=self.oq, text="D", position=3)
        a, b, c, d = self.oa, self.ob, self.oc, od
        self._submit([a, b, c, d])   # all links hold
        self._submit([a, b, d, c])   # A->B holds; B->C, C->D fail
        self._submit([b, a, c, d])   # A->B fails; B->C fails; C->D holds
        stats = ordering_stats(self.run, self.oq)
        rates = [round(l["rate"], 1) for l in stats["links"]]
        self.assertEqual(rates, [66.7, 33.3, 66.7])  # link1 < 50 breaks the run
        self.assertEqual(
            [(ch["start"], ch["end"]) for ch in stats["chains"]],
            [(0, 1), (2, 3)],
        )

    def test_empty_run_links_chains(self):
        from .results import ordering_stats
        stats = ordering_stats(self.run, self.oq)
        self.assertEqual([l["rate"] for l in stats["links"]], [0, 0])
        self.assertEqual(stats["chains"], [])


class PriorityStatsTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        from .models import PriorityScore

        self.PriorityScore = PriorityScore
        self.pq = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.PRIORITIES,
            text="<p>P</p>",
            position=1,
        )
        self.oa = AnswerOption.objects.create(question=self.pq, text="A", position=0)
        self.ob = AnswerOption.objects.create(question=self.pq, text="B", position=1)
        self.run = Run.objects.create(
            question_set=self.question_set,
            phase=Run.Phase.CLOSED,
            active_question=self.pq,
        )

    def _submit(self, a, b):
        tok = ParticipantToken.objects.create(room=self.room)
        vote = Vote.objects.create(run=self.run, question=self.pq, token=tok)
        self.PriorityScore.objects.bulk_create(
            [
                self.PriorityScore(vote=vote, option=self.oa, points=a),
                self.PriorityScore(vote=vote, option=self.ob, points=b),
            ]
        )

    def test_avg_min_max_and_sorting(self):
        from .results import priority_stats

        self._submit(80, 20)
        self._submit(40, 0)
        stats = priority_stats(self.run, self.pq)
        by_id = {s["id"]: s for s in stats}
        self.assertEqual(by_id[self.oa.pk]["avg"], 60.0)
        self.assertEqual(by_id[self.oa.pk]["min"], 40)
        self.assertEqual(by_id[self.oa.pk]["max"], 80)
        self.assertEqual(by_id[self.oa.pk]["n"], 2)
        self.assertEqual(by_id[self.ob.pk]["avg"], 10.0)
        self.assertEqual(by_id[self.ob.pk]["min"], 0)
        self.assertEqual(stats[0]["id"], self.oa.pk)  # sorted by avg desc

    def test_run_results_includes_priorities(self):
        from .results import run_results

        self._submit(70, 30)
        item = next(
            i for i in run_results(self.run)["questions"] if i["id"] == self.pq.pk
        )
        self.assertIn("priorities", item)
        self.assertNotIn("options", item)


class PriorityPayloadTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        from .models import PriorityScore

        self.PriorityScore = PriorityScore
        self.pq = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.PRIORITIES,
            text="<p>P</p>",
            position=1,
        )
        self.oa = AnswerOption.objects.create(question=self.pq, text="A", position=0)
        self.ob = AnswerOption.objects.create(question=self.pq, text="B", position=1)

    def _run(self, phase):
        return Run.objects.create(
            question_set=self.question_set, phase=phase, active_question=self.pq
        )

    def _score(self, run, a, b):
        tok = ParticipantToken.objects.create(room=self.room)
        vote = Vote.objects.create(run=run, question=self.pq, token=tok)
        self.PriorityScore.objects.bulk_create(
            [
                self.PriorityScore(vote=vote, option=self.oa, points=a),
                self.PriorityScore(vote=vote, option=self.ob, points=b),
            ]
        )

    def test_open_payload_lists_options(self):
        self._run(Run.Phase.OPEN)
        q = build_payloads(self.room)["participant"]["question"]
        self.assertEqual(q["kind"], "priorities")
        self.assertEqual(len(q["options"]), 2)

    def test_presenter_results_has_priority_stats(self):
        run = self._run(Run.Phase.CLOSED)
        self._score(run, 70, 30)
        presenter = build_payloads(self.room)["presenter"]
        self.assertIn("priorities", presenter)
        self.assertNotIn("results", presenter)

    def test_participant_results_when_enabled(self):
        self.question_set.show_results_to_participants = True
        self.question_set.save(update_fields=["show_results_to_participants"])
        run = self._run(Run.Phase.RESULTS)
        self._score(run, 70, 30)
        participant = build_payloads(self.room)["participant"]
        self.assertIn("priorities", participant)


class PriorityCsvTests(LiveTestCase):
    def test_csv_has_priority_avg_min_max(self):
        from .models import PriorityScore

        pq = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.PRIORITIES,
            text="<p>P</p>",
            position=1,
        )
        oa = AnswerOption.objects.create(question=pq, text="Alpha", position=0)
        ob = AnswerOption.objects.create(question=pq, text="Beta", position=1)
        run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.CLOSED, active_question=pq
        )
        for a, b in ((80, 20), (40, 0)):
            tok = ParticipantToken.objects.create(room=self.room)
            vote = Vote.objects.create(run=run, question=pq, token=tok)
            PriorityScore.objects.bulk_create(
                [
                    PriorityScore(vote=vote, option=oa, points=a),
                    PriorityScore(vote=vote, option=ob, points=b),
                ]
            )
        self.client.force_login(self.owner)
        response = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        )
        self.assertEqual(response.status_code, 200)
        body = response.content.decode("utf-8-sig")
        # Alpha: avg 60.0, min 40, max 80  → stimmen;vor_ort;aufzeichnung
        self.assertIn("Alpha;;60.0;40;80;", body)
        self.assertNotIn("{", body)


class PriorityRecordingAndResetTests(LiveTestCase):
    def login(self):
        self.client.force_login(self.owner)

    def test_start_without_recording_clears_stale_token(self):
        # Bugfix: a resumed run must not keep a recording token when the new
        # start did not request recording.
        self.login()
        run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.LOBBY
        )
        run.enable_recording()
        self.assertTrue(run.recording_token)
        self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {}, content_type="application/json",
        )
        run.refresh_from_db()
        self.assertIsNone(run.recording_token)

    def test_recording_vote_stores_priorities(self):
        pq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.PRIORITIES,
            text="<p>P</p>", position=1,
        )
        oa = AnswerOption.objects.create(question=pq, text="A", position=0)
        ob = AnswerOption.objects.create(question=pq, text="B", position=1)
        run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.OPEN, active_question=pq
        )
        run.enable_recording()
        token = self.join()
        resp = self.client.post(
            f"/api/live/recording/{run.recording_token}/vote/",
            {"token": token, "question": pq.pk,
             "points": {str(oa.pk): 70, str(ob.pk): 30}},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertIn("priorities", resp.json())
        vote = run.votes.get(token__key=token, source=Vote.Source.RECORDING)
        self.assertEqual(
            {s.option_id: s.points for s in vote.priority_scores.all()},
            {oa.pk: 70, ob.pk: 30},
        )


class OrderingPayloadTests(LiveTestCase):
    def test_payload_shuffles_and_omits_position(self):
        from .state import question_payload

        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>O</p>", position=1, shuffle_options=False,
        )
        # 8 options → identity ordering has 1/8! chance; assert not-identity
        # across a few seeds to prove shuffling is active for ordering.
        opts = [AnswerOption.objects.create(question=q, text=f"O{i}", position=i)
                for i in range(8)]
        payload = question_payload(q, shuffle_seed=1)
        ids = [o["id"] for o in payload["options"]]
        self.assertEqual(sorted(ids), sorted(o.pk for o in opts))
        self.assertNotIn("position", payload["options"][0])
        self.assertNotEqual(ids, [o.pk for o in opts])  # shuffled vs authored order


class ShuffleLetterMappingTests(LiveTestCase):
    """#127: the beamer letters each option by its display index, in both the
    voting view (question_payload) and the results view (options_with_counts).
    Both must present the same per-run order, or "B" while voting becomes "C"
    in the results."""

    def _shuffled_choice(self):
        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE,
            text="<p>?</p>", position=1, shuffle_options=True,
        )
        # 8 options: the authored order surviving a shuffle is a 1/8! fluke.
        for i in range(8):
            AnswerOption.objects.create(
                question=q, text=f"O{i}", position=i, is_correct=(i == 1),
            )
        return q

    def test_results_order_matches_question_order(self):
        from .results import options_with_counts
        from .state import question_payload

        q = self._shuffled_choice()
        run = Run.objects.create(question_set=self.question_set)
        payload_ids = [o["id"] for o in question_payload(q, shuffle_seed=run.pk)["options"]]
        result_ids = [o["id"] for o in options_with_counts(run, q)]
        self.assertEqual(payload_ids, result_ids)
        # And the order is really shuffled (not just position order agreeing).
        self.assertNotEqual(payload_ids, list(
            q.options.order_by("position").values_list("pk", flat=True)
        ))

    def test_unshuffled_choice_keeps_position_order(self):
        from .results import options_with_counts
        from .state import question_payload

        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE,
            text="<p>?</p>", position=2, shuffle_options=False,
        )
        for i in range(4):
            AnswerOption.objects.create(question=q, text=f"O{i}", position=i)
        run = Run.objects.create(question_set=self.question_set)
        position_ids = list(q.options.order_by("position").values_list("pk", flat=True))
        self.assertEqual(
            [o["id"] for o in question_payload(q, shuffle_seed=run.pk)["options"]],
            position_ids,
        )
        self.assertEqual(
            [o["id"] for o in options_with_counts(run, q)], position_ids
        )


class OrderingCsvTests(LiveTestCase):
    def test_csv_has_ordering_rows(self):
        from .models import OrderingResponse

        oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text="<p>Order</p>", position=0,
        )
        oa = AnswerOption.objects.create(question=oq, text="Erst", position=0)
        ob = AnswerOption.objects.create(question=oq, text="Dann", position=1)
        run = Run.objects.create(question_set=self.question_set, phase=Run.Phase.CLOSED)
        tok = ParticipantToken.objects.create(room=self.room)
        vote = Vote.objects.create(run=run, question=oq, token=tok)
        OrderingResponse.objects.bulk_create([
            OrderingResponse(vote=vote, option=oa, position=0),
            OrderingResponse(vote=vote, option=ob, position=1),
        ])
        self.client.force_login(self.owner)
        resp = self.client.get(f"/api/question-sets/{self.question_set.pk}/results.csv")
        self.assertEqual(resp.status_code, 200)
        body = resp.content.decode("utf-8")
        self.assertIn("Erst", body)
        self.assertIn("Dann", body)
        # full-correct summary row present
        self.assertIn("komplett richtig", body.lower())


class QuestionPreviewTests(LiveTestCase):
    """Owner-only interactive question preview reusing the participant page (#74)."""

    def _make_question(self):
        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE,
            text_de="<p>Welche Farbe?</p>", position=1,
        )
        AnswerOption.objects.create(question=q, text_de="Blau", position=0)
        AnswerOption.objects.create(question=q, text_de="Rot", position=1)
        return q

    def test_preview_renders_for_owner(self):
        self.client.force_login(self.owner)
        q = self._make_question()
        resp = self.client.get(f"/question-preview/{q.pk}/")
        self.assertEqual(resp.status_code, 200)
        body = resp.content.decode()
        # The question + option texts ride along in the embedded preview state.
        self.assertIn("Welche Farbe?", body)
        self.assertIn("Blau", body)
        self.assertIn("Rot", body)
        self.assertIn("preview-state", body)  # seeded JSON present

    def test_preview_forbidden_for_non_owner(self):
        other = User.objects.create_user(username="mallory")
        self.client.force_login(other)
        q = self._make_question()
        self.assertEqual(self.client.get(f"/question-preview/{q.pk}/").status_code, 404)

    def test_preview_unknown_question_404(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get("/question-preview/99999/").status_code, 404)

    def test_preview_is_frameable_by_own_app(self):
        # #74: the editor embeds this in an iframe — allow 'self' + the SPA via
        # CSP frame-ancestors, and drop the blanket X-Frame-Options: DENY.
        self.client.force_login(self.owner)
        q = self._make_question()
        resp = self.client.get(f"/question-preview/{q.pk}/")
        self.assertIn("frame-ancestors", resp.headers.get("Content-Security-Policy", ""))
        self.assertNotIn("X-Frame-Options", resp.headers)

    def test_preview_mindmap_carries_seed_tree(self):
        # The editor preview has no run: the predefined branches are shown as
        # a local tree (negative ids, nothing stored).
        self.client.force_login(self.owner)
        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.MINDMAP,
            text_de="<p>Energie</p>", position=1, mindmap_depth=3,
            mindmap_seed=[{"text": "Wind", "description": "",
                           "children": [{"text": "Offshore", "description": ""}]}],
        )
        resp = self.client.get(f"/question-preview/{q.pk}/")
        self.assertEqual(resp.status_code, 200)
        state = json.loads(
            resp.content.decode().split('id="preview-state" type="application/json">')[1]
            .split("</script>")[0]
        )
        tree = state["mindmap"]
        self.assertEqual(tree["depth"], 3)
        self.assertEqual(tree["total"], 2)
        wind = tree["nodes"][0]
        self.assertEqual(wind["text"], "Wind")
        self.assertLess(wind["id"], 0)
        self.assertEqual(wind["children"][0]["text"], "Offshore")
        self.assertEqual(wind["text_i18n"], {"de": "Wind", "en": ""})
        self.assertFalse(MindmapNode.objects.exists())

    def test_preview_mindmap_seed_is_bilingual(self):
        self.client.force_login(self.owner)
        q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.MINDMAP,
            text_de="<p>Energie</p>", position=1, mindmap_descriptions=True,
            mindmap_seed=[{"text": {"de": "Sonne", "en": "Sun"},
                           "description": {"de": "Licht", "en": "Light"},
                           "children": []}],
        )
        resp = self.client.get(f"/question-preview/{q.pk}/")
        state = json.loads(
            resp.content.decode().split('id="preview-state" type="application/json">')[1]
            .split("</script>")[0]
        )
        node = state["mindmap"]["nodes"][0]
        self.assertEqual(node["text"], "Sonne")
        self.assertEqual(node["text_i18n"], {"de": "Sonne", "en": "Sun"})
        self.assertEqual(node["descriptions"], ["Licht"])
        self.assertEqual(node["description_i18n"], {"de": "Licht", "en": "Light"})


class ConcurrentStartRunTests(TransactionTestCase):
    """#66: two presenters opening the same set within milliseconds both
    read "no active run" and both try to create one, tripping the
    ``one_active_run_per_set`` constraint as an unhandled 500. Needs a
    *real* TransactionTestCase (not the default TestCase, which wraps each
    test in one transaction — no true concurrency, and ``select_for_update``
    is a no-op there) so both threads can actually race against Postgres.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="frank")
        self.room = Room.objects.create(title="Bio 101")
        self.room.owners.add(self.owner)
        self.question_set = QuestionSet.objects.create(room=self.room, title="Termin 1")
        self.question = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE,
            text="<p>2+2?</p>",
        )
        AnswerOption.objects.create(question=self.question, text="4", is_correct=True, position=0)
        AnswerOption.objects.create(question=self.question, text="5", position=1)

    def test_simultaneous_start_run_does_not_500(self):
        barrier = threading.Barrier(2)
        results = [None, None]

        def worker(index):
            client = Client()
            client.force_login(self.owner)
            try:
                barrier.wait(timeout=5)
                response = client.post(
                    f"/api/question-sets/{self.question_set.pk}/start-run/",
                    {"mode": "self_paced", "existing": "continue"},
                    content_type="application/json",
                )
                results[index] = response
            finally:
                connections.close_all()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        for response in results:
            self.assertIsNotNone(response, "worker thread did not complete")
            self.assertEqual(response.status_code, 200, response.content)

        run_ids = {response.json()["run"] for response in results}
        self.assertEqual(len(run_ids), 1, "both requests must converge on the same run")

        active = Run.objects.filter(question_set=self.question_set).exclude(
            phase=Run.Phase.FINISHED
        )
        self.assertEqual(active.count(), 1)
        self.assertEqual(active.first().pk, run_ids.pop())


class SelfCheckAttemptModelTests(LiveTestCase):
    """#75 Phase 3 (Lernkontrolle): anonymous attempt counter."""

    def test_defaults_to_zero_correct_and_scored(self):
        from .models import SelfCheckAttempt

        attempt = SelfCheckAttempt.objects.create(question_set=self.question_set)
        self.assertEqual(attempt.correct, 0)
        self.assertEqual(attempt.scored, 0)
        self.assertIsNone(attempt.question)
        self.assertIsNotNone(attempt.created_at)
        self.assertEqual(self.question_set.self_check_attempts.get(), attempt)

    def test_accepts_per_question_row(self):
        from .models import SelfCheckAttempt

        attempt = SelfCheckAttempt.objects.create(
            question_set=self.question_set, question=self.question, correct=1, scored=1
        )
        self.assertEqual(attempt.question, self.question)
        self.assertEqual(attempt.correct, 1)
        self.assertEqual(attempt.scored, 1)


class CheckApiTests(LiveTestCase):
    """#75 Phase 3 (Lernkontrolle): token-keyed participant API + page + QR."""

    def setUp(self):
        super().setUp()
        self.check_set = QuestionSet.objects.create(
            room=self.room, title="Lernkontrolle", type=QuestionSet.SetType.SELF_CHECK,
        )
        self.sc_choice = Question.objects.create(
            question_set=self.check_set, kind=Question.Kind.SINGLE_CHOICE,
            text="<p>2+2?</p>", position=0,
        )
        self.sc_correct = AnswerOption.objects.create(
            question=self.sc_choice, text="4", is_correct=True, position=0
        )
        self.sc_wrong = AnswerOption.objects.create(
            question=self.sc_choice, text="5", position=1
        )
        self.sc_open = Question.objects.create(
            question_set=self.check_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Explain</p>", position=1, model_solution="Because reasons.",
        )
        self.sc_ordering = Question.objects.create(
            question_set=self.check_set, kind=Question.Kind.ORDERING,
            text="<p>Order</p>", position=2,
        )
        self.sc_a = AnswerOption.objects.create(question=self.sc_ordering, text="A", position=0)
        self.sc_b = AnswerOption.objects.create(question=self.sc_ordering, text="B", position=1)
        self.sc_c = AnswerOption.objects.create(question=self.sc_ordering, text="C", position=2)
        self.check_set.enable_self_check()
        self.token = self.check_set.self_check_token

    # -- check_questions --------------------------------------------------

    def test_unknown_token_404(self):
        resp = self.client.get("/api/live/check/does-not-exist/")
        self.assertEqual(resp.status_code, 404)

    def test_unpublished_self_check_set_404(self):
        from django.http import Http404

        from .views import _self_check_set

        unpublished = QuestionSet.objects.create(
            room=self.room, title="Draft", type=QuestionSet.SetType.SELF_CHECK,
        )
        self.assertIsNone(unpublished.self_check_token)
        # Unpublished (no token) has no valid URL to reach it by; the guard
        # this exercises is the helper itself refusing a None/empty token.
        with self.assertRaises(Http404):
            _self_check_set(unpublished.self_check_token)
        with self.assertRaises(Http404):
            _self_check_set(None)

    def test_wrong_type_with_manual_token_404(self):
        # Type guard: a live_poll set that somehow carries a token value
        # (shouldn't happen via the UI) must not be servable as a check set.
        self.question_set.self_check_token = "manually-set-token"
        self.question_set.save(update_fields=["self_check_token"])
        resp = self.client.get(f"/api/live/check/{self.question_set.self_check_token}/")
        self.assertEqual(resp.status_code, 404)

    def test_payload_carries_solutions_per_kind(self):
        resp = self.client.get(f"/api/live/check/{self.token}/")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["set_title"], translated_map(self.check_set, "title"))
        self.assertFalse(data["single"])
        by_id = {q["id"]: q for q in data["questions"]}
        self.assertEqual(by_id[self.sc_choice.pk]["correct"], [self.sc_correct.pk])
        self.assertEqual(by_id[self.sc_choice.pk]["model_solution"], "")
        self.assertEqual(by_id[self.sc_choice.pk]["correct_order"], [])
        self.assertEqual(by_id[self.sc_open.pk]["model_solution"], "Because reasons.")
        self.assertEqual(by_id[self.sc_open.pk]["correct"], [])
        self.assertEqual(
            by_id[self.sc_ordering.pk]["correct_order"],
            [self.sc_a.pk, self.sc_b.pk, self.sc_c.pk],
        )
        self.assertEqual(by_id[self.sc_ordering.pk]["correct"], [])

    def test_single_question_via_query_param(self):
        resp = self.client.get(f"/api/live/check/{self.token}/?q={self.sc_choice.pk}")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["single"])
        self.assertEqual(len(data["questions"]), 1)
        self.assertEqual(data["questions"][0]["id"], self.sc_choice.pk)

    def test_unknown_question_query_param_404(self):
        resp = self.client.get(f"/api/live/check/{self.token}/?q={self.question.pk}")
        self.assertEqual(resp.status_code, 404)

    # -- check_attempt ------------------------------------------------------

    def _attempt(self, **payload):
        return self.client.post(
            f"/api/live/check/{self.token}/attempt/", payload,
            content_type="application/json",
        )

    def test_valid_attempt_creates_row(self):
        resp = self._attempt(correct=2, scored=3)
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json(), {"status": "ok"})
        self.assertEqual(SelfCheckAttempt.objects.count(), 1)
        attempt = SelfCheckAttempt.objects.get()
        self.assertEqual(attempt.question_set, self.check_set)
        self.assertIsNone(attempt.question)
        self.assertEqual((attempt.correct, attempt.scored), (2, 3))

    def test_attempt_clamps_to_question_count(self):
        self._attempt(correct=99, scored=99)
        attempt = SelfCheckAttempt.objects.get()
        self.assertEqual((attempt.correct, attempt.scored), (3, 3))

    def test_attempt_clamps_correct_to_scored(self):
        self._attempt(correct=5, scored=2)
        attempt = SelfCheckAttempt.objects.get()
        self.assertEqual((attempt.correct, attempt.scored), (2, 2))

    def test_attempt_with_question_scoped_to_one(self):
        resp = self._attempt(correct=1, scored=1, question=self.sc_choice.pk)
        self.assertEqual(resp.status_code, 201)
        attempt = SelfCheckAttempt.objects.get()
        self.assertEqual(attempt.question, self.sc_choice)
        self.assertEqual((attempt.correct, attempt.scored), (1, 1))
        # Even an inflated report is clamped to the single-question cap.
        SelfCheckAttempt.objects.all().delete()
        self._attempt(correct=9, scored=9, question=self.sc_choice.pk)
        attempt = SelfCheckAttempt.objects.get()
        self.assertEqual((attempt.correct, attempt.scored), (1, 1))

    def test_attempt_with_foreign_question_400(self):
        resp = self._attempt(correct=1, scored=1, question=self.question.pk)
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(SelfCheckAttempt.objects.count(), 0)

    def test_attempt_non_int_fields_400(self):
        resp = self._attempt(correct="nope", scored=3)
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(SelfCheckAttempt.objects.count(), 0)

    def test_attempt_unknown_token_404(self):
        resp = self.client.post(
            "/api/live/check/does-not-exist/attempt/", {"correct": 1, "scored": 1},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 404)

    # -- check_page / check_qr ----------------------------------------------

    def test_check_page_renders_with_token_in_context(self):
        resp = self.client.get(f"/c/{self.token}/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.context["check_token"], self.token)

    def test_check_page_unknown_token_404(self):
        resp = self.client.get("/c/does-not-exist/")
        self.assertEqual(resp.status_code, 404)

    def test_check_qr_returns_png(self):
        resp = self.client.get(f"/c/{self.token}/qr.png?q={self.sc_choice.pk}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Content-Type"], "image/png")

    def test_check_page_never_renders_the_live_join_flow(self):
        # #75 Phase 3 review carry-forward: before the participant template
        # grew a CHECK_TOKEN branch, /c/<token>/ fell into the live "else"
        # branch and would join the room / open SSE — a real leak for a
        # page that is meant to be anonymous, stateless and permanent. The
        # room's join code is the one piece of real, per-room templated data
        # that only a live/recording render would need (CODE is blanked for
        # the check page precisely so it never needs it) — its absence here
        # is a stable proxy for "this render took the check branch".
        from django.utils.html import escapejs

        # Proxy only: no browser/JS harness runs here, so this checks the
        # rendered template string, not that the check-mode JS itself never
        # calls join()/connect() at runtime.
        resp = self.client.get(f"/c/{self.token}/")
        html = resp.content.decode()
        self.assertEqual(resp.status_code, 200)
        self.assertIn(escapejs(self.token), html)  # CHECK_TOKEN, JS-escaped like room.code below
        self.assertNotIn(escapejs(self.room.code), html)


@override_settings(**AI_ON)
class SelfCheckGradeTests(TestCase):
    """#75 Phase 3: synchronous AI grading of Lernkontrolle free-text answers."""

    def setUp(self):
        # Reuse the same construction as test_payload_carries_solutions_per_kind.
        self.owner = User.objects.create_user(username="o", password="p")
        self.room = Room.objects.create(title="R")
        self.room.owners.add(self.owner)
        self.qs = QuestionSet.objects.create(
            room=self.room, title="S", type=QuestionSet.SetType.SELF_CHECK,
        )
        self.qs.enable_self_check()
        self.qs.refresh_from_db()
        self.token = self.qs.self_check_token
        self.q = Question.objects.create(
            question_set=self.qs, kind="open_text", text_de="Frage", text_en="Q",
            ai_evaluate=True, model_solution="Paris",
            evaluation_categories=["korrekt", "unklar", "falsch"],
        )
        from live import self_check_ai
        self_check_ai._reset_for_tests()

    def _grade(self, answer, question=None):
        return self.client.post(
            f"/api/live/check/{self.token}/grade/",
            {"question": question or self.q.pk, "answer": answer},
            content_type="application/json",
        )

    @patch("basicbar_integrations.ai.chat_json", return_value={"verdict": "korrekt", "note": "gut"})
    def test_grade_returns_verdict_index_correct(self, _m):
        resp = self._grade("Frankreichs Hauptstadt ist Paris")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["verdict"], "korrekt")
        self.assertEqual(data["note"], "gut")
        self.assertEqual(data["categories"], ["korrekt", "unklar", "falsch"])
        self.assertEqual(data["index"], 0)
        self.assertTrue(data["correct"])

    @patch("basicbar_integrations.ai.chat_json", return_value={"verdict": "falsch", "note": ""})
    def test_grade_wrong_is_not_correct(self, _m):
        data = self._grade("nonsense").json()
        self.assertEqual(data["index"], 2)
        self.assertFalse(data["correct"])

    def test_grade_rejects_non_open_text(self):
        mc = Question.objects.create(
            question_set=self.qs, kind="single_choice", text_de="x", text_en="x",
        )
        self.assertEqual(self._grade("a", question=mc.pk).status_code, 400)

    def test_grade_rejects_non_numeric_question(self):
        resp = self.client.post(
            f"/api/live/check/{self.token}/grade/",
            {"question": "abc", "answer": "x"},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_grade_rejects_ai_evaluate_off(self):
        self.q.ai_evaluate = False
        self.q.save(update_fields=["ai_evaluate"])
        self.assertEqual(self._grade("a").status_code, 400)

    def test_grade_rejects_foreign_question(self):
        other = QuestionSet.objects.create(room=self.room, title="O", type="self_check")
        fq = Question.objects.create(question_set=other, kind="open_text",
                                     text_de="x", text_en="x", ai_evaluate=True)
        self.assertEqual(self._grade("a", question=fq.pk).status_code, 400)

    @override_settings(AI_PROVIDER="none")
    def test_grade_409_when_ai_disabled(self):
        self.assertEqual(self._grade("a").status_code, 409)

    @patch("basicbar_integrations.ai.chat_json", return_value={"verdict": "korrekt", "note": ""})
    def test_grade_429_when_over_limit(self, _m):
        SiteConfig.objects.update_or_create(pk=1, defaults={"self_check_ai_per_minute": 1})
        self.assertEqual(self._grade("a").status_code, 200)
        self.assertEqual(self._grade("b").status_code, 429)

    def test_check_questions_payload_has_ai_evaluate(self):
        resp = self.client.get(f"/api/live/check/{self.token}/")
        self.assertEqual(resp.status_code, 200)
        q = resp.json()["questions"][0]
        self.assertIn("ai_evaluate", q)
        self.assertTrue(q["ai_evaluate"])

    def test_check_questions_payload_has_reveal_only_in_summary(self):
        resp = self.client.get(f"/api/live/check/{self.token}/")
        self.assertEqual(resp.status_code, 200)
        # Default is False (results after each question).
        self.assertFalse(resp.json()["reveal_only_in_summary"])
        self.qs.reveal_only_in_summary = True
        self.qs.save(update_fields=["reveal_only_in_summary"])
        resp = self.client.get(f"/api/live/check/{self.token}/")
        self.assertTrue(resp.json()["reveal_only_in_summary"])


class SelfCheckRegressionTests(LiveTestCase):
    """#75 Phase 3: solutions must stay exclusive to the check endpoints —
    neither the self-paced quiz payload nor the live payload may carry
    ``correct``/``model_solution``/``correct_order`` on their questions."""

    def setUp(self):
        super().setUp()
        self.sp_set = QuestionSet.objects.create(
            room=self.room, title="Self-paced", type=QuestionSet.SetType.SELF_PACED,
        )
        self.sp_question = Question.objects.create(
            question_set=self.sp_set, kind=Question.Kind.SINGLE_CHOICE, text="<p>Q</p>",
        )
        AnswerOption.objects.create(
            question=self.sp_question, text="4", is_correct=True, position=0
        )
        AnswerOption.objects.create(question=self.sp_question, text="5", position=1)
        self.sp_run = Run.objects.create(
            question_set=self.sp_set, mode=Run.Mode.SELF_PACED, phase=Run.Phase.OPEN,
        )

    def test_self_paced_quiz_payload_has_no_solution_keys(self):
        resp = self.client.get(f"/api/live/rooms/{self.room.code}/quiz/")
        self.assertEqual(resp.status_code, 200)
        for question in resp.json()["questions"]:
            self.assertNotIn("correct", question)
            self.assertNotIn("model_solution", question)
            self.assertNotIn("correct_order", question)

    def test_live_payload_has_no_solution_keys(self):
        self.open_question()
        payloads = build_payloads(self.room)
        question = payloads["participant"]["question"]
        self.assertNotIn("correct", question)
        self.assertNotIn("model_solution", question)
        self.assertNotIn("correct_order", question)


class WordCloudModerationAggregationTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            text="<p>Wort?</p>", position=1, allow_multiple=True,
        )
        self.run = Run.objects.create(question_set=self.question_set)

    def _cast(self, text, n):
        for _ in range(n):
            token = ParticipantToken.objects.create(room=self.room)
            Vote.objects.create(run=self.run, question=self.q, token=token, text=text)

    def test_hidden_term_is_dropped(self):
        from .models import WordCloudModeration
        from .results import words_with_counts
        self._cast("froh", 3)
        self._cast("wut", 2)
        WordCloudModeration.objects.create(run=self.run, question=self.q, hidden=["wut"])
        words = words_with_counts(self.run, self.q)
        texts = [w["text"] for w in words]
        self.assertIn("froh", texts)
        self.assertNotIn("wut", texts)
        # raw votes untouched
        self.assertEqual(self.run.votes.filter(question=self.q, text="wut").count(), 2)

    def test_merge_combines_counts_and_uses_label(self):
        from .models import WordCloudModeration
        from .results import words_with_counts
        self._cast("froh", 3)
        self._cast("gluecklich", 2)
        WordCloudModeration.objects.create(
            run=self.run, question=self.q,
            merges=[{"keys": ["froh", "gluecklich"], "label": "froh"}],
        )
        words = words_with_counts(self.run, self.q)
        self.assertEqual(len(words), 1)
        w = words[0]
        self.assertEqual(w["text"], "froh")
        self.assertEqual(w["count"], 5)
        self.assertTrue(w["merged"])
        self.assertEqual(sorted(w["keys"]), ["froh", "gluecklich"])

    def test_no_overlay_is_unchanged_and_exposes_keys(self):
        from .results import words_with_counts
        self._cast("froh", 1)
        [w] = words_with_counts(self.run, self.q)
        self.assertEqual(w["text"], "froh")
        self.assertEqual(w["keys"], ["froh"])
        self.assertFalse(w["merged"])

    def test_hidden_key_excluded_even_when_merged(self):
        from .models import WordCloudModeration
        from .results import words_with_counts
        self._cast("zorn", 2)
        self._cast("wut", 3)
        WordCloudModeration.objects.create(
            run=self.run, question=self.q, hidden=["wut"],
            merges=[{"keys": ["wut", "zorn"], "label": "zorn"}],
        )
        words = words_with_counts(self.run, self.q)
        self.assertEqual(len(words), 1)
        self.assertEqual(words[0]["text"], "zorn")
        self.assertEqual(words[0]["count"], 2)  # wut's votes are NOT counted


class WordCloudModerationApiTests(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            text="<p>Wort?</p>", position=1, allow_multiple=True,
        )
        self.run = Run.objects.create(question_set=self.question_set)
        for text, n in (("froh", 3), ("gluecklich", 2), ("wut", 1)):
            for _ in range(n):
                token = ParticipantToken.objects.create(room=self.room)
                Vote.objects.create(run=self.run, question=self.q, token=token, text=text)
        self.url = f"/api/runs/{self.run.pk}/wordcloud/{self.q.pk}/moderation"
        self.client.force_login(self.owner)

    def _post(self, body):
        # self.client must be authenticated as the room owner — use the same
        # login the other presenter-endpoint tests in this file use.
        return self.client.post(self.url, body, content_type="application/json")

    def test_hide_then_unhide(self):
        from .models import WordCloudModeration
        self.assertEqual(self._post({"op": "hide", "keys": ["wut"]}).status_code, 200)
        self.assertEqual(WordCloudModeration.objects.get(run=self.run).hidden, ["wut"])
        self.assertEqual(self._post({"op": "unhide", "keys": ["wut"]}).status_code, 200)
        self.assertEqual(WordCloudModeration.objects.get(run=self.run).hidden, [])

    def test_merge_and_rename_and_unmerge(self):
        from .models import WordCloudModeration
        self._post({"op": "merge", "keys": ["froh", "gluecklich"], "label": "froh"})
        m = WordCloudModeration.objects.get(run=self.run)
        self.assertEqual(m.merges, [{"keys": ["froh", "gluecklich"], "label": "froh"}])
        self._post({"op": "rename", "keys": ["froh", "gluecklich"], "label": "positiv"})
        self.assertEqual(WordCloudModeration.objects.get(run=self.run).merges[0]["label"], "positiv")
        self._post({"op": "unmerge", "keys": ["froh", "gluecklich"]})
        self.assertEqual(WordCloudModeration.objects.get(run=self.run).merges, [])

    def test_requires_owner(self):
        self.client.logout()
        self.assertIn(self._post({"op": "hide", "keys": ["wut"]}).status_code, (401, 403, 404))


class WordCloudAiSettingsApiTests(LiveTestCase):
    """Presenter endpoint: switch a word cloud's AI on/off, edit its grouping."""

    def setUp(self):
        super().setUp()
        self.wc = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            text="<p>Wort?</p>", position=1, allow_multiple=True,
        )
        self.run = Run.objects.create(question_set=self.question_set)
        self.url = f"/api/runs/{self.run.pk}/wordcloud/{self.wc.pk}/ai-settings"
        self.client.force_login(self.owner)

    def _post(self, body, url=None):
        return self.client.post(url or self.url, body, content_type="application/json")

    def test_requires_owner(self):
        self.client.logout()
        self.assertIn(self._post({"grouping": "x"}).status_code, (401, 403, 404))

    def test_non_wordcloud_question_404(self):
        self.question.wordcloud_ai_enabled = True
        self.question.save(update_fields=["wordcloud_ai_enabled"])
        url = f"/api/runs/{self.run.pk}/wordcloud/{self.question.pk}/ai-settings"
        self.assertEqual(self._post({"grouping": "x"}, url).status_code, 404)

    def test_question_of_other_set_404(self):
        url = f"/api/runs/{self.run.pk}/wordcloud/999999/ai-settings"
        self.assertEqual(self._post({"grouping": "x"}, url).status_code, 404)

    @override_settings(**AI_OFF)
    def test_enable_with_provider_off_is_409(self):
        resp = self._post({"ai_enabled": True})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("detail", resp.json())
        self.wc.refresh_from_db()
        self.assertFalse(self.wc.wordcloud_ai_enabled)

    @override_settings(**AI_ON)
    def test_enable_saves(self):
        resp = self._post({"ai_enabled": True})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIsInstance(data.pop("ai_seq"), int)
        self.assertEqual(
            data,
            {
                "ai_enabled": True, "grouping": "",
                "merge_variants": True, "merge_synonyms": True,
                "merge_concepts": False, "grouping_use_solution": True,
            },
        )
        self.wc.refresh_from_db()
        self.assertTrue(self.wc.wordcloud_ai_enabled)

    @override_settings(**AI_OFF)
    def test_disable_allowed_with_provider_off(self):
        self.wc.wordcloud_ai_enabled = True
        self.wc.save()
        resp = self._post({"ai_enabled": False})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["ai_enabled"])
        self.wc.refresh_from_db()
        self.assertFalse(self.wc.wordcloud_ai_enabled)

    def test_grouping_saved_stripped_and_refreshes(self):
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            resp = self._post({"grouping": "  nach positiv/negativ \n"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["grouping"], "nach positiv/negativ")
        self.wc.refresh_from_db()
        self.assertEqual(self.wc.wordcloud_grouping, "nach positiv/negativ")
        refresh.assert_called_once_with(self.run.pk, self.wc.pk, self.room.pk)

    def test_grouping_too_long_400(self):
        resp = self._post({"grouping": "x" * 1001})
        self.assertEqual(resp.status_code, 400)
        self.wc.refresh_from_db()
        self.assertEqual(self.wc.wordcloud_grouping, "")

    def test_unchanged_grouping_does_not_refresh(self):
        self.wc.wordcloud_grouping = "a"
        self.wc.save()
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            self._post({"grouping": "a"})
        refresh.assert_not_called()

    @override_settings(**AI_ON)
    def test_broadcasts_and_payload_reflects_state(self):
        with patch("live.views.broadcast") as bc:
            self._post({"ai_enabled": True, "grouping": "nach Genre"})
        bc.assert_called_once()
        self.run.active_question = self.wc
        self.run.phase = Run.Phase.OPEN
        self.run.save()
        presenter = build_payloads(self.room)["presenter"]
        self.assertTrue(presenter["question"]["wordcloud_ai_enabled"])
        self.assertEqual(presenter["question"]["wordcloud_grouping"], "nach Genre")

    def test_ai_enabled_must_be_bool(self):
        for bad in ("false", "true", 1, None):
            self.assertEqual(self._post({"ai_enabled": bad}).status_code, 400, bad)

    def test_regroup_forces_refresh_even_if_unchanged(self):
        self.wc.wordcloud_grouping = "a"
        self.wc.save()
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            self.assertEqual(self._post({"grouping": "a", "regroup": True}).status_code, 200)
        refresh.assert_called_once_with(self.run.pk, self.wc.pk, self.room.pk)

    def test_unchanged_legacy_long_grouping_accepted(self):
        Question.objects.filter(pk=self.wc.pk).update(wordcloud_grouping="y" * 1500)
        self.assertEqual(self._post({"grouping": "y" * 1500}).status_code, 200)

    @override_settings(**AI_ON)
    def test_disabling_stops_live_loop(self):
        key = (self.run.pk, self.wc.pk)
        self.addCleanup(ai_wordcloud_live._active.clear)
        self.addCleanup(ai_wordcloud_live._results.clear)
        self.addCleanup(ai_wordcloud_live._running.clear)
        self.wc.wordcloud_ai_enabled = True
        self.wc.save()
        with patch.object(ai_wordcloud_live._executor, "submit"):
            ai_wordcloud_live.set_active(self.run.pk, self.wc.pk, self.room.pk, True)
        self.assertTrue(ai_wordcloud_live.is_active(*key))
        self.assertEqual(self._post({"ai_enabled": False}).status_code, 200)
        self.assertFalse(ai_wordcloud_live.is_active(*key))

    @override_settings(**AI_OFF)
    def test_wordcloud_ai_deactivate_allowed_when_disabled(self):
        resp = self._post(
            {"question": self.wc.pk, "active": False},
            f"/api/runs/{self.run.pk}/wordcloud-ai/",
        )
        self.assertEqual(resp.status_code, 200)

    # --- Consolidation switches (variants / synonyms / concepts) ----------

    def test_merge_flags_saved_returned_and_refresh(self):
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            resp = self._post(
                {"merge_variants": False, "merge_synonyms": False,
                 "merge_concepts": True}
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertFalse(body["merge_variants"])
        self.assertFalse(body["merge_synonyms"])
        self.assertTrue(body["merge_concepts"])
        self.wc.refresh_from_db()
        self.assertFalse(self.wc.wordcloud_merge_variants)
        self.assertFalse(self.wc.wordcloud_merge_synonyms)
        self.assertTrue(self.wc.wordcloud_merge_concepts)
        refresh.assert_called_once_with(self.run.pk, self.wc.pk, self.room.pk)

    def test_unchanged_merge_flags_do_not_refresh(self):
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            resp = self._post(
                {"merge_variants": True, "merge_synonyms": True,
                 "merge_concepts": False}
            )
        self.assertEqual(resp.status_code, 200)
        refresh.assert_not_called()

    def test_unchanged_merge_flags_with_regroup_refresh(self):
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            self._post({"merge_concepts": False, "regroup": True})
        refresh.assert_called_once_with(self.run.pk, self.wc.pk, self.room.pk)

    def test_merge_flags_must_be_bool(self):
        for key in ("merge_variants", "merge_synonyms", "merge_concepts"):
            for bad in ("false", "true", 1, 0, None):
                resp = self._post({key: bad})
                self.assertEqual(resp.status_code, 400, (key, bad))
        self.wc.refresh_from_db()
        self.assertTrue(self.wc.wordcloud_merge_variants)
        self.assertTrue(self.wc.wordcloud_merge_synonyms)
        self.assertFalse(self.wc.wordcloud_merge_concepts)

    def test_invalid_flag_saves_nothing(self):
        # Validation happens before any write: a bad flag rejects the
        # whole request, including otherwise valid fields.
        resp = self._post({"grouping": "neu", "merge_concepts": "yes"})
        self.assertEqual(resp.status_code, 400)
        self.wc.refresh_from_db()
        self.assertEqual(self.wc.wordcloud_grouping, "")

    @override_settings(**AI_ON)
    def test_rejected_request_has_no_side_effects(self):
        # ai_enabled=false + too-long grouping → 400, and the live loop must
        # not have been stopped, nothing saved, nothing refreshed/broadcast.
        self.wc.wordcloud_ai_enabled = True
        self.wc.save()
        bad_bodies = [
            {"ai_enabled": False, "grouping": "x" * 1001},
            {"ai_enabled": False, "merge_concepts": "yes"},
            {"ai_enabled": "no", "grouping": "neu"},
            {"merge_concepts": True, "grouping": "x" * 1001},
        ]
        for body in bad_bodies:
            with patch("live.views.ai_wordcloud_live.set_active") as set_active, \
                    patch("live.views.ai_wordcloud_live.refresh") as refresh, \
                    patch("live.views.broadcast") as bc:
                self.assertEqual(self._post(body).status_code, 400, body)
            set_active.assert_not_called()
            refresh.assert_not_called()
            bc.assert_not_called()
            self.wc.refresh_from_db()
            self.assertTrue(self.wc.wordcloud_ai_enabled)
            self.assertEqual(self.wc.wordcloud_grouping, "")
            self.assertFalse(self.wc.wordcloud_merge_concepts)

    @override_settings(**AI_OFF)
    def test_conflict_has_no_side_effects(self):
        with patch("live.views.ai_wordcloud_live.refresh") as refresh, \
                patch("live.views.broadcast") as bc:
            resp = self._post(
                {"ai_enabled": True, "grouping": "neu", "merge_concepts": True}
            )
        self.assertEqual(resp.status_code, 409)
        refresh.assert_not_called()
        bc.assert_not_called()
        self.wc.refresh_from_db()
        self.assertEqual(self.wc.wordcloud_grouping, "")
        self.assertFalse(self.wc.wordcloud_merge_concepts)

    def test_presenter_payload_carries_merge_flags(self):
        self.wc.wordcloud_merge_variants = False
        self.wc.wordcloud_merge_concepts = True
        self.wc.save()
        self.run.active_question = self.wc
        self.run.phase = Run.Phase.OPEN
        self.run.save()
        payloads = build_payloads(self.room)
        question = payloads["presenter"]["question"]
        self.assertFalse(question["wordcloud_merge_variants"])
        self.assertTrue(question["wordcloud_merge_synonyms"])
        self.assertTrue(question["wordcloud_merge_concepts"])
        # Presenter-only: participants never see the AI settings.
        participant_q = payloads["participant"].get("question") or {}
        self.assertNotIn("wordcloud_merge_concepts", participant_q)


class AiFreetextSummaryTests(LiveTestCase):
    """AI key statements + grouping for free-text answers (open_text), reusing
    the live word-cloud AI machinery (cache, activation, throttle)."""

    def setUp(self):
        super().setUp()
        self.ot = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Was zeichnet eine anonyme Umfrage aus?</p>", position=8,
            wordcloud_ai_enabled=True,
        )
        self.run = self.open_question(self.ot)
        self.addCleanup(ai_wordcloud_live._active.clear)
        self.addCleanup(ai_wordcloud_live._results.clear)
        self.addCleanup(ai_wordcloud_live._running.clear)
        self.addCleanup(ai_wordcloud_live._dirty.clear)

    def _cast(self, text):
        return self.vote(self.join(), text=text)

    WORDS = [
        {"text": "Keine Namen", "count": 3, "keys": ["keine namen"]},
        {"text": "Niemand weiß, wer was antwortet", "count": 2,
         "keys": ["niemand weiß, wer was antwortet", "niemand weiss"]},
        {"text": "Ehrlichere Antworten", "count": 2, "keys": ["ehrlichere antworten"]},
        {"text": "x" * 120, "count": 1, "keys": ["x" * 120]},
    ]

    # --- apply_summary ------------------------------------------------------

    def test_apply_groups_members_by_id_and_recomputes_counts(self):
        data = {"statements": [
            {"label": "Keine Identifikation", "cluster": "Anonymität",
             "members": [1, 2]},
            {"label": "Ehrlichere Antworten", "cluster": "Qualität",
             "members": [3]},
        ]}
        out = ai_freetext_summary.apply_summary(self.WORDS, data)
        by_text = {s["text"]: s for s in out["merged"]}
        self.assertEqual(by_text["Keine Identifikation"]["count"], 5)
        self.assertEqual(
            by_text["Keine Identifikation"]["variants"],
            ["Keine Namen", "Niemand weiß, wer was antwortet"],
        )
        self.assertEqual(
            by_text["Keine Identifikation"]["keys"],
            ["keine namen", "niemand weiß, wer was antwortet", "niemand weiss"],
        )
        # Sorted by count, counts always sum to the total.
        self.assertEqual(out["merged"][0]["text"], "Keine Identifikation")
        self.assertEqual(sum(s["count"] for s in out["merged"]), 8)
        clusters = {c["label"]: c for c in out["clusters"]}
        self.assertEqual(clusters["Anonymität"]["count"], 5)
        self.assertEqual(clusters["Qualität"]["words"][0]["text"], "Ehrlichere Antworten")

    def test_apply_ignores_bad_ids_and_duplicates(self):
        data = {"statements": [
            {"label": "A", "cluster": "T", "members": [1, 1, 99, 0, -1, "x", None]},
            {"label": "B", "cluster": "T", "members": [1, "2"]},
            {"label": "Leer", "cluster": "T", "members": [42]},
            "kaputt",
            {"label": "Ohne Liste", "members": "1"},
        ]}
        out = ai_freetext_summary.apply_summary(self.WORDS, data)
        by_text = {s["text"]: s for s in out["merged"]}
        self.assertEqual(by_text["A"]["count"], 3)       # id 1 only once
        self.assertEqual(by_text["B"]["count"], 2)       # id 1 consumed; "2" accepted
        self.assertNotIn("Leer", by_text)
        self.assertNotIn("Ohne Liste", by_text)
        self.assertEqual(sum(s["count"] for s in out["merged"]), 8)

    def test_apply_unreferenced_answers_pooled_without_verbatim_label(self):
        data = {"statements": [
            {"label": "Keine Identifikation", "cluster": "Anonymität", "members": [1]},
        ]}
        out = ai_freetext_summary.apply_summary(self.WORDS, data)
        self.assertEqual(sum(s["count"] for s in out["merged"]), 8)
        texts = [s["text"] for s in out["merged"]]
        self.assertEqual(texts, ["Keine Identifikation", ai_freetext_summary.LEFTOVER_LABEL])
        leftover = out["merged"][-1]
        self.assertEqual(leftover["count"], 5)
        self.assertEqual(
            leftover["keys"],
            ["niemand weiß, wer was antwortet", "niemand weiss",
             "ehrlichere antworten", "x" * 120],
        )
        # No answer text ever becomes a label.
        for word in self.WORDS[1:]:
            self.assertNotIn(word["text"], texts)
        clusters = {c["label"]: c for c in out["clusters"]}
        self.assertEqual(
            [w["text"] for w in clusters[ai_freetext_summary.OTHER_CLUSTER]["words"]],
            [ai_freetext_summary.LEFTOVER_LABEL],
        )

    def test_apply_nothing_referenced_gives_one_leftover(self):
        out = ai_freetext_summary.apply_summary(self.WORDS, {"statements": []})
        self.assertEqual(len(out["merged"]), 1)
        self.assertEqual(out["merged"][0]["text"], ai_freetext_summary.LEFTOVER_LABEL)
        self.assertEqual(out["merged"][0]["count"], 8)

    def test_apply_leftover_sorts_last(self):
        data = {"statements": [
            {"label": "Ehrlicher", "cluster": "Q", "members": [3]},
        ]}
        out = ai_freetext_summary.apply_summary(self.WORDS, data)
        # Leftover (6) outnumbers the statement (2) but still comes last.
        self.assertEqual(out["merged"][-1]["text"], ai_freetext_summary.LEFTOVER_LABEL)
        self.assertEqual(out["merged"][-1]["count"], 6)

    def test_apply_truncates_label_and_cluster_and_pools_empty_labels(self):
        data = {"statements": [
            {"label": "L" * 200, "cluster": "C" * 200, "members": [1]},
            {"label": "", "cluster": "Q", "members": [3]},
            {"label": "Mit Label", "cluster": "", "members": [2]},
        ]}
        out = ai_freetext_summary.apply_summary(self.WORDS, data)
        by_text = {s["text"]: s for s in out["merged"]}
        self.assertIn("L" * ai_freetext_summary.LABEL_MAX, by_text)
        # Empty label → pooled with the unreferenced answer, never verbatim.
        self.assertNotIn("Ehrlichere Antworten", by_text)
        self.assertEqual(by_text[ai_freetext_summary.LEFTOVER_LABEL]["count"], 3)
        labels = [c["label"] for c in out["clusters"]]
        self.assertIn("C" * ai_freetext_summary.CLUSTER_MAX, labels)
        # Empty cluster → "Weitere", which sinks to the end.
        self.assertEqual(labels[-1], ai_freetext_summary.OTHER_CLUSTER)

    def test_apply_handles_garbage(self):
        for data in (None, [], "x", {"statements": "x"}):
            out = ai_freetext_summary.apply_summary(self.WORDS, data)
            self.assertEqual(sum(s["count"] for s in out["merged"]), 8)

    # --- prompts --------------------------------------------------------------

    def test_system_equivalent_only_vs_similar(self):
        strict = ai_freetext_summary.summary_system(merge_similar=False)
        broad = ai_freetext_summary.summary_system(merge_similar=True)
        self.assertIn(ai_freetext_summary.RULE_EQUIVALENT, strict)
        self.assertNotIn(ai_freetext_summary.RULE_SIMILAR, strict)
        self.assertIn(ai_freetext_summary.RULE_SIMILAR, broad)
        self.assertNotIn(ai_freetext_summary.RULE_EQUIVALENT, broad)
        for prompt in (strict, broad):
            self.assertIn("ausschließlich mit JSON", prompt)
            self.assertIn("höchstens einer", prompt)
            # Statements first, by the merge rule alone; themes only after.
            self.assertLess(
                prompt.index(ai_freetext_summary.STATEMENTS_FIRST),
                prompt.index(ai_freetext_summary.CLUSTER_ONLY),
            )

    def test_strict_rule_is_core_message_with_examples(self):
        strict = ai_freetext_summary.summary_system(merge_similar=False)
        self.assertIn("Kernaussage", ai_freetext_summary.RULE_EQUIVALENT)
        for example in ("Folien sind zu voll", "zu schnell", "Praxisbezug"):
            self.assertIn(example, strict)
        self.assertNotIn("Im Zweifel NICHT", strict)
        broad = ai_freetext_summary.summary_system(merge_similar=True)
        self.assertIn("Aspekt", broad)
        # Neutral domain: no examples from the test topic (anonymous surveys),
        # neither in the rules nor in the format example (no answers sent).
        for text in (strict, broad, ai_freetext_summary.build_summary_prompt([])):
            for topic_word in ("nonym", "zuordenbar", "Registrierung", "hrlicher",
                               "Gruppendruck", "unerkannt"):
                self.assertNotIn(topic_word, text)

    def test_grouping_criterion_only_in_second_step(self):
        # The statement prompt never sees a criterion (it cannot take one).
        with self.assertRaises(TypeError):
            ai_freetext_summary.summary_system("Studierende vs. Lehrende")
        prompt = ai_freetext_summary.grouping_system("Studierende vs. Lehrende")
        self.assertIn("Studierende vs. Lehrende", prompt)
        self.assertIn(ai_freetext_summary.POLES_RULE, prompt)
        self.assertIn(ai_freetext_summary.OTHER_CLUSTER, prompt)
        self.assertIn("stehen fest", prompt)

    def test_apply_grouping_keeps_statements_and_reclusters(self):
        summary = ai_freetext_summary.apply_summary(self.WORDS, {"statements": [
            {"label": "Keine Identifikation", "cluster": "Anonymität", "members": [1, 2]},
            {"label": "Ehrlicher", "cluster": "Qualität", "members": [3]},
        ]})
        grouping_prompt = ai_freetext_summary.build_grouping_prompt(summary["merged"])
        self.assertIn('"id": 1', grouping_prompt)
        self.assertIn("Keine Identifikation", grouping_prompt)
        out = ai_freetext_summary.apply_grouping(summary, {"clusters": [
            {"label": "Vorteil für Studierende", "members": [1, 1, 99]},
            {"label": "Vorteil für Lehrende", "members": [2, 1]},
            "kaputt",
        ]})
        self.assertEqual(out["merged"], summary["merged"])  # statements untouched
        clusters = {c["label"]: [w["text"] for w in c["words"]] for c in out["clusters"]}
        self.assertEqual(clusters["Vorteil für Studierende"], ["Keine Identifikation"])
        self.assertEqual(clusters["Vorteil für Lehrende"], ["Ehrlicher"])
        # The unassigned leftover statement → "Weitere", last.
        self.assertEqual(out["clusters"][-1]["label"], ai_freetext_summary.OTHER_CLUSTER)
        self.assertEqual(sum(c["count"] for c in out["clusters"]), 8)
        # The pooled leftover always stays in "Weitere", even if assigned.
        forced = ai_freetext_summary.apply_grouping(summary, {"clusters": [
            {"label": "G", "members": [1, 2, 3]},
        ]})
        self.assertEqual(
            [w["text"] for w in forced["clusters"][-1]["words"]],
            [ai_freetext_summary.LEFTOVER_LABEL],
        )

    def test_summarize_grouping_failure_keeps_step1_auto_themes(self):
        from basicbar_integrations import ai
        step1 = {"statements": [{"label": "S", "cluster": "Thema", "members": [1, 2, 3, 4]}]}
        replies = [step1, ai.AIError("timeout")]

        def fake(system, prompt):
            reply = replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply

        out = ai_freetext_summary.summarize(self.WORDS, grouping="nach Rolle", chat_json=fake)
        self.assertEqual(out["merged"][0]["text"], "S")
        self.assertEqual(out["clusters"][0]["label"], "Thema")

    def test_summarize_two_calls_only_with_grouping(self):
        step1 = {"statements": [{"label": "S", "cluster": "T", "members": [1]}]}
        calls = []

        def fake(system, prompt):
            calls.append(system)
            return step1 if len(calls) == 1 else {
                "clusters": [{"label": "G", "members": [1]}]
            }

        out = ai_freetext_summary.summarize(self.WORDS, chat_json=fake)
        self.assertEqual(len(calls), 1)
        self.assertEqual(out["clusters"][0]["label"], "T")
        calls.clear()
        out2 = ai_freetext_summary.summarize(
            self.WORDS, grouping="nach Rolle", chat_json=fake
        )
        self.assertEqual(len(calls), 2)
        self.assertNotIn("nach Rolle", calls[0])  # statements never see it
        self.assertIn("nach Rolle", calls[1])
        self.assertEqual(out2["merged"], out["merged"])
        self.assertEqual(out2["clusters"][0]["label"], "G")

    def test_build_prompt_numbers_and_truncates(self):
        words = [{"text": "a" * 900, "count": 2, "keys": ["k"]},
                 {"text": "kurz", "count": 1, "keys": ["kurz"]}]
        prompt = ai_freetext_summary.build_summary_prompt(words)
        self.assertIn('"id": 1', prompt)
        self.assertIn('"id": 2', prompt)
        self.assertIn("a" * (ai_freetext_summary.ANSWER_MAX - 1) + "…", prompt)
        self.assertNotIn("a" * ai_freetext_summary.ANSWER_MAX, prompt)

    # --- live compute ---------------------------------------------------------

    @override_settings(**AI_ON)
    def test_compute_open_text_uses_summary_and_moderation(self):
        from .models import WordCloudModeration
        self._cast("Keine Namen")
        self._cast("keine namen")
        self._cast("Beleidigung")
        self._cast("Niemand kennt mich")
        self._cast("Man bleibt unerkannt")
        WordCloudModeration.objects.create(
            run=self.run, question=self.ot, hidden=["beleidigung"],
            merges=[{"keys": ["niemand kennt mich", "man bleibt unerkannt"],
                     "label": "Unerkannt"}],
        )
        self.ot.wordcloud_merge_concepts = True
        self.ot.wordcloud_grouping = "nach Aspekt"
        self.ot.save()
        reply = {"statements": [
            {"label": "Identität bleibt verborgen", "cluster": "Anonymität",
             "members": [1, 2]},
        ]}
        regroup = {"clusters": [{"label": "Anonymität", "members": [1]}]}
        with patch(
            "basicbar_integrations.ai.chat_json", side_effect=[reply, regroup]
        ) as chat:
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        self.assertEqual(chat.call_count, 2)
        system, prompt = chat.call_args_list[0][0]
        self.assertIn(ai_freetext_summary.RULE_SIMILAR, system)
        self.assertNotIn("nach Aspekt", system)  # criterion: second call only
        self.assertIn("nach Aspekt", chat.call_args_list[1][0][0])
        self.assertNotIn("Beleidigung", prompt)  # hidden → never sent
        self.assertIn("Unerkannt", prompt)       # moderation merge = one input
        self.assertNotIn("Man bleibt unerkannt", prompt)
        result = ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)
        self.assertFalse(result["pending"])
        self.assertEqual(result["merged"][0]["text"], "Identität bleibt verborgen")
        self.assertEqual(result["merged"][0]["count"], 4)
        self.assertEqual(
            sorted(result["merged"][0]["keys"]),
            ["keine namen", "man bleibt unerkannt", "niemand kennt mich"],
        )
        presenter = build_payloads(self.room)["presenter"]
        self.assertEqual(
            presenter["wordcloud_ai"]["clusters"][0]["label"], "Anonymität"
        )

    @override_settings(**AI_ON)
    def test_compute_ai_error_yields_empty_result(self):
        from basicbar_integrations import ai
        self._cast("Keine Namen")
        with patch("basicbar_integrations.ai.chat_json", side_effect=ai.AIError("x")):
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        result = ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)
        self.assertIsInstance(result.pop("seq"), int)
        self.assertEqual(
            result, {"merged": [], "clusters": [], "pending": False, "error": True},
        )

    # --- seq: every finished compute is distinguishable -------------------

    @override_settings(**AI_ON)
    def test_compute_seq_increases_even_for_identical_result_and_error(self):
        from basicbar_integrations import ai
        self._cast("Keine Namen")
        reply = {"statements": [{"label": "S", "cluster": "T", "members": [1]}]}
        seqs = []
        for side_effect in ([reply], [reply], ai.AIError("x")):
            with patch("basicbar_integrations.ai.chat_json", side_effect=side_effect):
                ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
            seqs.append(ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)["seq"])
        self.assertLess(seqs[0], seqs[1])
        self.assertLess(seqs[1], seqs[2])

    @override_settings(**AI_ON)
    def test_placeholder_seq_is_below_any_mark(self):
        mark = ai_wordcloud_live.current_seq()
        with patch("live.ai_wordcloud_live.schedule"):
            ai_wordcloud_live.set_active(self.run.pk, self.ot.pk, self.room.pk, True)
        result = ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)
        self.assertTrue(result["pending"])
        self.assertLessEqual(result["seq"], mark)

    @override_settings(**AI_ON)
    def test_settings_response_has_ai_seq_mark_below_next_compute(self):
        self._cast("Keine Namen")
        self.client.force_login(self.owner)
        url = f"/api/runs/{self.run.pk}/wordcloud/{self.ot.pk}/ai-settings"
        with patch("live.views.ai_wordcloud_live.refresh"):
            resp = self.client.post(
                url, {"grouping": "nach Aspekt", "regroup": True},
                content_type="application/json",
            )
        mark = resp.json()["ai_seq"]
        self.assertIsInstance(mark, int)
        reply = {"statements": [{"label": "S", "cluster": "T", "members": [1]}]}
        with patch("basicbar_integrations.ai.chat_json", side_effect=[reply, {}]):
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        self.assertGreater(
            ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)["seq"], mark
        )

    # --- question context in both prompts ----------------------------------

    CONTEXT = {
        "question": "Erklären Sie kurz, was eine anonyme Umfrage auszeichnet.",
        "model_solution": "Keine Rückschlüsse auf die antwortende Person.",
        "hint": "Personenbezug fehlt",
    }

    def test_context_block_in_both_user_prompts(self):
        words = [{"text": "Keine Namen", "count": 1, "keys": ["keine namen"]}]
        step1 = ai_freetext_summary.build_summary_prompt(words, context=self.CONTEXT)
        step2 = ai_freetext_summary.build_grouping_prompt(
            [{"text": "S", "count": 1}], context=self.CONTEXT
        )
        for prompt in (step1, step2):
            self.assertIn("Frage: Erklären Sie kurz", prompt)
            self.assertIn("Musterlösung: Keine Rückschlüsse", prompt)
            self.assertIn("Bewertungshinweis: Personenbezug fehlt", prompt)
            # Context before the data.
            self.assertLess(prompt.index("Frage:"), prompt.index('"id": 1'))

    def test_context_without_model_solution_or_hint(self):
        ctx = {"question": "Was ist X?", "model_solution": "", "hint": ""}
        words = [{"text": "a", "count": 1, "keys": ["a"]}]
        for prompt in (
            ai_freetext_summary.build_summary_prompt(words, context=ctx),
            ai_freetext_summary.build_grouping_prompt(
                [{"text": "S", "count": 1}], context=ctx
            ),
        ):
            self.assertIn("Frage: Was ist X?", prompt)
            self.assertNotIn("Musterlösung", prompt)
            self.assertNotIn("Bewertungshinweis", prompt)
        # No context at all → no block.
        self.assertNotIn("Frage:", ai_freetext_summary.build_summary_prompt(words))

    def test_grouping_system_has_correctness_rule(self):
        prompt = ai_freetext_summary.grouping_system("korrekt / falsch / neutral")
        self.assertIn(ai_freetext_summary.CORRECTNESS_RULE, prompt)
        self.assertIn("Musterlösung", ai_freetext_summary.CORRECTNESS_RULE)

    def test_question_context_plain_canonical(self):
        self.ot.text_de = "<p>Was zeichnet eine <b>anonyme</b> Umfrage aus?</p>"
        self.ot.text_en = "<p>What makes a survey anonymous?</p>"
        self.ot.model_solution = "Keine Rückschlüsse"
        self.ot.save()
        with translation.override("en"):
            ctx = ai_freetext_summary.question_context(self.ot)
        self.assertEqual(ctx["question"], "Was zeichnet eine anonyme Umfrage aus?")
        self.assertEqual(ctx["model_solution"], "Keine Rückschlüsse")
        self.assertEqual(ctx["hint"], "")

    @override_settings(**AI_ON)
    def test_compute_passes_question_context_to_both_steps(self):
        self._cast("Keine Namen")
        self.ot.model_solution = "Keine Rückschlüsse auf Personen"
        self.ot.evaluation_hint = "Personenbezug"
        self.ot.wordcloud_grouping = "korrekt / falsch"
        self.ot.save()
        reply = {"statements": [{"label": "S", "cluster": "T", "members": [1]}]}
        with patch(
            "basicbar_integrations.ai.chat_json",
            side_effect=[reply, {"clusters": [{"label": "korrekt", "members": [1]}]}],
        ) as chat:
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        for call in chat.call_args_list:
            prompt = call[0][1]
            self.assertIn("Frage: Was zeichnet eine anonyme Umfrage aus?", prompt)
            self.assertIn("Musterlösung: Keine Rückschlüsse auf Personen", prompt)
            self.assertIn("Bewertungshinweis: Personenbezug", prompt)
            self.assertNotIn("<p>", prompt)

    # --- grouping_use_solution (model solution in the prompts) -----------

    def test_question_context_omits_solution_when_flag_off(self):
        self.ot.model_solution = "Keine Rückschlüsse"
        self.ot.evaluation_hint = "Personenbezug"
        self.ot.wordcloud_grouping_use_solution = False
        self.ot.save()
        ctx = ai_freetext_summary.question_context(self.ot)
        self.assertEqual(ctx["model_solution"], "")
        # Question text and hint stay.
        self.assertEqual(ctx["question"], "Was zeichnet eine anonyme Umfrage aus?")
        self.assertEqual(ctx["hint"], "Personenbezug")

    def test_question_context_includes_solution_by_default(self):
        self.ot.model_solution = "Keine Rückschlüsse"
        self.ot.save()
        self.assertTrue(self.ot.wordcloud_grouping_use_solution)
        ctx = ai_freetext_summary.question_context(self.ot)
        self.assertEqual(ctx["model_solution"], "Keine Rückschlüsse")

    @override_settings(**AI_ON)
    def test_compute_without_solution_when_flag_off(self):
        self._cast("Keine Namen")
        self.ot.model_solution = "Keine Rückschlüsse auf Personen"
        self.ot.evaluation_hint = "Personenbezug"
        self.ot.wordcloud_grouping = "korrekt / falsch"
        self.ot.wordcloud_grouping_use_solution = False
        self.ot.save()
        reply = {"statements": [{"label": "S", "cluster": "T", "members": [1]}]}
        with patch(
            "basicbar_integrations.ai.chat_json",
            side_effect=[reply, {"clusters": [{"label": "korrekt", "members": [1]}]}],
        ) as chat:
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        self.assertEqual(chat.call_count, 2)
        for call in chat.call_args_list:
            prompt = call[0][1]
            self.assertIn("Frage: Was zeichnet eine anonyme Umfrage aus?", prompt)
            self.assertNotIn("Musterlösung:", prompt)
            self.assertNotIn("Keine Rückschlüsse", prompt)
            self.assertIn("Bewertungshinweis: Personenbezug", prompt)

    def _settings(self, body):
        self.client.force_login(self.owner)
        return self.client.post(
            f"/api/runs/{self.run.pk}/wordcloud/{self.ot.pk}/ai-settings",
            body, content_type="application/json",
        )

    def test_settings_grouping_use_solution_saved_and_refresh(self):
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            resp = self._settings({"grouping_use_solution": False})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["grouping_use_solution"])
        self.ot.refresh_from_db()
        self.assertFalse(self.ot.wordcloud_grouping_use_solution)
        refresh.assert_called_once_with(self.run.pk, self.ot.pk, self.room.pk)

    def test_settings_unchanged_grouping_use_solution_no_refresh(self):
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            resp = self._settings({"grouping_use_solution": True})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["grouping_use_solution"])
        refresh.assert_not_called()

    def test_settings_grouping_use_solution_must_be_bool(self):
        for bad in ("false", "true", 1, 0, None):
            with patch("live.views.ai_wordcloud_live.refresh") as refresh, \
                    patch("live.views.broadcast") as bc:
                resp = self._settings(
                    {"grouping": "neu", "grouping_use_solution": bad}
                )
            self.assertEqual(resp.status_code, 400, bad)
            refresh.assert_not_called()
            bc.assert_not_called()
        self.ot.refresh_from_db()
        self.assertTrue(self.ot.wordcloud_grouping_use_solution)
        self.assertEqual(self.ot.wordcloud_grouping, "")

    def test_presenter_payload_has_solution_and_flag_participant_not(self):
        self.ot.model_solution = "Keine Rückschlüsse"
        self.ot.wordcloud_grouping_use_solution = False
        self.ot.save()
        payloads = build_payloads(self.room)
        question = payloads["presenter"]["question"]
        self.assertEqual(question["model_solution"], "Keine Rückschlüsse")
        self.assertFalse(question["wordcloud_grouping_use_solution"])
        participant_q = payloads["participant"]["question"]
        self.assertNotIn("model_solution", participant_q)
        self.assertNotIn("wordcloud_grouping_use_solution", participant_q)
        self.assertNotIn("Keine Rückschlüsse", json.dumps(payloads["participant"]))

    def test_participant_results_payload_has_no_model_solution(self):
        self.ot.model_solution = "Keine Rückschlüsse"
        self.ot.save()
        self.run.phase = Run.Phase.RESULTS
        self.run.save()
        self.question_set.show_results_to_participants = True
        self.question_set.save()
        payloads = build_payloads(self.room)
        self.assertNotIn("Keine Rückschlüsse", json.dumps(payloads["participant"]))
        self.assertEqual(
            payloads["presenter"]["question"]["model_solution"], "Keine Rückschlüsse"
        )

    @override_settings(**AI_ON)
    def test_compute_success_and_no_answers_flag_no_error(self):
        with patch("basicbar_integrations.ai.chat_json") as chat:
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        chat.assert_not_called()
        self.assertFalse(ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)["error"])
        self._cast("Keine Namen")
        reply = {"statements": [{"label": "S", "cluster": "T", "members": [1]}]}
        with patch("basicbar_integrations.ai.chat_json", return_value=reply):
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        result = ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)
        self.assertFalse(result["error"])
        self.assertEqual(result["merged"][0]["text"], "S")

    @override_settings(**AI_ON)
    def test_compute_grouping_failure_not_an_error(self):
        from basicbar_integrations import ai
        self._cast("Keine Namen")
        self.ot.wordcloud_grouping = "nach Rolle"
        self.ot.save()
        reply = {"statements": [{"label": "S", "cluster": "Thema", "members": [1]}]}
        with patch(
            "basicbar_integrations.ai.chat_json", side_effect=[reply, ai.AIError("x")]
        ):
            ai_wordcloud_live._compute(self.run.pk, self.ot.pk, self.room.pk)
        result = ai_wordcloud_live.get_result(self.run.pk, self.ot.pk)
        self.assertFalse(result["error"])
        self.assertEqual(result["clusters"][0]["label"], "Thema")

    def test_vote_schedules_live_summary(self):
        with patch("live.ai_wordcloud_live.schedule") as sched:
            self._cast("Keine Namen")
        sched.assert_called_once_with(self.run.pk, self.ot.pk, self.room.pk)

    # --- endpoints / payload --------------------------------------------------

    @override_settings(**AI_ON)
    def test_activation_accepts_open_text(self):
        self.client.force_login(self.owner)
        with patch("live.ai_wordcloud_live.schedule"):
            resp = self.client.post(
                f"/api/runs/{self.run.pk}/wordcloud-ai/",
                {"question": self.ot.pk, "active": True},
                content_type="application/json",
            )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(ai_wordcloud_live.is_active(self.run.pk, self.ot.pk))

    @override_settings(**AI_ON)
    def test_activation_rejects_open_text_without_ai_enabled(self):
        self.ot.wordcloud_ai_enabled = False
        self.ot.save()
        self.client.force_login(self.owner)
        resp = self.client.post(
            f"/api/runs/{self.run.pk}/wordcloud-ai/",
            {"question": self.ot.pk, "active": True},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    @override_settings(**AI_ON)
    def test_settings_accept_open_text(self):
        self.client.force_login(self.owner)
        url = f"/api/runs/{self.run.pk}/wordcloud/{self.ot.pk}/ai-settings"
        with patch("live.views.ai_wordcloud_live.refresh") as refresh:
            resp = self.client.post(
                url, {"grouping": "nach Aspekt", "merge_concepts": True},
                content_type="application/json",
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["grouping"], "nach Aspekt")
        self.assertTrue(resp.json()["merge_concepts"])
        refresh.assert_called_once()
        self.ot.refresh_from_db()
        self.assertEqual(self.ot.wordcloud_grouping, "nach Aspekt")
        # Other kinds remain 404.
        url = f"/api/runs/{self.run.pk}/wordcloud/{self.question.pk}/ai-settings"
        self.assertEqual(
            self.client.post(url, {"grouping": "x"},
                             content_type="application/json").status_code,
            404,
        )

    def test_close_eagerly_computes_open_text_summary(self):
        self.client.force_login(self.owner)
        url = f"/api/runs/{self.run.pk}/control/"
        with patch("live.views.ai_wordcloud_live.ensure_result") as ensure:
            self.client.post(url, {"phase": "closed"}, content_type="application/json")
        ensure.assert_called_once_with(self.run.pk, self.ot.pk, self.room.pk)

    def test_close_no_eager_summary_without_ai_enabled(self):
        self.ot.wordcloud_ai_enabled = False
        self.ot.save()
        self.client.force_login(self.owner)
        with patch("live.views.ai_wordcloud_live.ensure_result") as ensure:
            self.client.post(
                f"/api/runs/{self.run.pk}/control/", {"phase": "closed"},
                content_type="application/json",
            )
        ensure.assert_not_called()

    def test_presenter_payload_has_summary_participant_not(self):
        key = (self.run.pk, self.ot.pk)
        ai_wordcloud_live._results[key] = {
            "merged": [{"text": "S", "count": 1, "variants": ["a"], "keys": ["a"]}],
            "clusters": [], "pending": False,
        }
        self.run.phase = Run.Phase.RESULTS
        self.run.save()
        self.question_set.show_results_to_participants = True
        self.question_set.save()
        payloads = build_payloads(self.room)
        self.assertEqual(payloads["presenter"]["wordcloud_ai"]["merged"][0]["text"], "S")
        self.assertNotIn("wordcloud_ai", payloads["participant"])


class FreetextAiSummaryEndpointTests(LiveTestCase):
    """One-shot AI key statements (+ grouping) of a free-text question for the
    Quiz-Block walkthrough: POST /api/runs/<run>/questions/<q>/ai-summary/."""

    def setUp(self):
        super().setUp()
        self.ot = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            text="<p>Was zeichnet eine anonyme Umfrage aus?</p>", position=8,
            wordcloud_ai_enabled=True,
        )
        self.run = self.open_question(self.ot)
        for raw in ["Keine Namen", "keine namen", "Ehrlicher", "Peinlich", "Kein Login"]:
            self.vote(self.join(), text=raw)
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        self.url = f"/api/runs/{self.run.pk}/questions/{self.ot.pk}/ai-summary/"

    REPLY = {
        "statements": [
            {"label": "Anonymität", "cluster": "Schutz", "members": [1, 4]},
            {"label": "Ehrlichkeit", "cluster": "Qualität", "members": [2]},
        ]
    }

    @override_settings(**AI_ON)
    def test_returns_statements_in_wordcloud_shape(self):
        with patch("basicbar_integrations.ai.chat_json", return_value=self.REPLY) as chat:
            self.client.force_login(self.owner)
            response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(set(data), {"merged", "clusters"})
        self.assertEqual(sum(s["count"] for s in data["merged"]), 5)
        top = data["merged"][0]
        self.assertEqual(top["text"], "Anonymität")
        self.assertEqual(top["count"], 3)  # 2× "Keine Namen" + 1 other
        self.assertIn("keine namen", top["keys"])
        # No grouping criterion → a single call (key statements only).
        self.assertEqual(chat.call_count, 1)
        self.assertIn(ai_freetext_summary.RULE_EQUIVALENT, chat.call_args_list[0][0][0])

    @override_settings(**AI_ON)
    def test_uses_merge_flag_and_grouping_of_question(self):
        self.ot.wordcloud_merge_concepts = True
        self.ot.wordcloud_grouping = "nach Vorteil für Studierende vs. Lehrende"
        self.ot.save()
        replies = [self.REPLY, {"clusters": [{"label": "Studierende", "members": [1, 2]}]}]
        with patch("basicbar_integrations.ai.chat_json", side_effect=replies) as chat:
            self.client.force_login(self.owner)
            response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(chat.call_count, 2)
        self.assertIn(ai_freetext_summary.RULE_SIMILAR, chat.call_args_list[0][0][0])
        self.assertIn("nach Vorteil für Studierende", chat.call_args_list[1][0][0])
        self.assertEqual(response.json()["clusters"][0]["label"], "Studierende")
        # Both steps know the question (plain text).
        for call in chat.call_args_list:
            self.assertIn("Frage: Was zeichnet eine anonyme Umfrage aus?", call[0][1])

    @override_settings(**AI_ON)
    def test_passes_model_solution_context(self):
        self.ot.model_solution = "Keine Rückschlüsse auf Personen"
        self.ot.save()
        with patch("basicbar_integrations.ai.chat_json", return_value=self.REPLY) as chat:
            self.client.force_login(self.owner)
            self.client.post(self.url)
        self.assertIn(
            "Musterlösung: Keine Rückschlüsse auf Personen", chat.call_args_list[0][0][1]
        )

    @override_settings(**AI_ON)
    def test_omits_model_solution_when_flag_off(self):
        self.ot.model_solution = "Keine Rückschlüsse auf Personen"
        self.ot.wordcloud_grouping_use_solution = False
        self.ot.save()
        with patch("basicbar_integrations.ai.chat_json", return_value=self.REPLY) as chat:
            self.client.force_login(self.owner)
            self.client.post(self.url)
        prompt = chat.call_args_list[0][0][1]
        self.assertIn("Frage: Was zeichnet eine anonyme Umfrage aus?", prompt)
        self.assertNotIn("Musterlösung", prompt)

    @override_settings(**AI_ON)
    def test_respects_moderation(self):
        from .models import WordCloudModeration
        WordCloudModeration.objects.create(
            run=self.run, question=self.ot, hidden=["peinlich"],
            merges=[{"keys": ["ehrlicher", "kein login"], "label": "Ehrlich"}],
        )
        with patch(
            "basicbar_integrations.ai.chat_json", return_value={"statements": []}
        ) as chat:
            self.client.force_login(self.owner)
            response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        prompt = chat.call_args[0][1]
        self.assertNotIn("Peinlich", prompt)
        self.assertIn("Ehrlich", prompt)
        self.assertNotIn("Kein Login", prompt)
        # Unreferenced answers still appear as their own statement.
        self.assertEqual(sum(s["count"] for s in response.json()["merged"]), 4)

    @override_settings(**AI_ON)
    def test_model_error_returns_502(self):
        from basicbar_integrations import ai
        with patch("basicbar_integrations.ai.chat_json", side_effect=ai.AIError("x")):
            self.client.force_login(self.owner)
            self.assertEqual(self.client.post(self.url).status_code, 502)

    @override_settings(**AI_OFF)
    def test_disabled_returns_503(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.post(self.url).status_code, 503)

    @override_settings(**AI_ON)
    def test_requires_owner(self):
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(User.objects.create_user(username="eve"))
            self.assertEqual(self.client.post(self.url).status_code, 404)
        chat.assert_not_called()

    @override_settings(**AI_ON)
    def test_anonymous_rejected(self):
        self.assertIn(self.client.post(self.url).status_code, (401, 403))

    @override_settings(**AI_ON)
    def test_non_open_text_rejected(self):
        url = f"/api/runs/{self.run.pk}/questions/{self.question.pk}/ai-summary/"
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(self.owner)
            self.assertEqual(self.client.post(url).status_code, 400)
        chat.assert_not_called()

    @override_settings(**AI_ON)
    def test_ai_summary_off_for_question_rejected(self):
        self.ot.wordcloud_ai_enabled = False
        self.ot.save()
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(self.owner)
            self.assertEqual(self.client.post(self.url).status_code, 400)
        chat.assert_not_called()

    @override_settings(**AI_ON)
    def test_no_answers_skips_model(self):
        empty = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.OPEN_TEXT,
            position=9, wordcloud_ai_enabled=True,
        )
        url = f"/api/runs/{self.run.pk}/questions/{empty.pk}/ai-summary/"
        with patch("basicbar_integrations.ai.chat_json") as chat:
            self.client.force_login(self.owner)
            response = self.client.post(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"merged": [], "clusters": []})
        chat.assert_not_called()


# --- mind map (stage 1) -------------------------------------------------------


class MindmapTestCase(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.mq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.MINDMAP,
            text="<p>Was gehört zur <b>Energiewende</b>?</p>", position=1,
        )

    def open_mindmap(self, **fields):
        for key, value in fields.items():
            setattr(self.mq, key, value)
        self.mq.save()
        return self.open_question(self.mq)

    def add(self, token, text, parent=None, question=None, **extra):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/mindmap/add/",
            {"token": token, "question": question or self.mq.pk, "parent": parent,
             "text": text, **extra},
            content_type="application/json",
        )

    def remove(self, token, node, question=None):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/mindmap/remove/",
            {"token": token, "question": question or self.mq.pk, "node": node},
            content_type="application/json",
        )

    def mine(self, token, question=None):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/mindmap/mine/",
            {"token": token, "question": question or self.mq.pk},
            content_type="application/json",
        )

    def hide(self, run, node, hidden=True):
        return self.client.post(
            f"/api/runs/{run.pk}/mindmap/{self.mq.pk}/hide",
            {"node": node, "hidden": hidden},
            content_type="application/json",
        )

    def tree(self, role="participant"):
        return build_payloads(self.room)[role]["mindmap"]


class MindmapAddTests(MindmapTestCase):
    def test_add_creates_root_level_node(self):
        run = self.open_mindmap()
        token = self.join()
        response = self.add(token, "  Solar   Energie ")
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        node = MindmapNode.objects.get(pk=body["node_id"])
        self.assertEqual(node.run, run)
        self.assertIsNone(node.parent)
        self.assertEqual(node.text, "Solar Energie")
        self.assertEqual(node.text_key, "solar energie")
        self.assertFalse(body["merged"])
        self.assertEqual(body["mine"], [node.pk])

    def test_same_term_merges_case_and_whitespace_insensitive(self):
        self.open_mindmap()
        first = self.add(self.join(), "Energie").json()["node_id"]
        response = self.add(self.join(), "  ENERGIE ")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["node_id"], first)
        self.assertTrue(response.json()["merged"])
        self.assertEqual(MindmapNode.objects.count(), 1)
        nodes = self.tree()["nodes"]
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0]["count"], 2)
        # The first contributor's spelling is displayed.
        self.assertEqual(nodes[0]["text"], "Energie")

    def test_same_term_under_different_parents_is_two_nodes(self):
        self.open_mindmap()
        token = self.join()
        a = self.add(token, "A").json()["node_id"]
        b = self.add(token, "B").json()["node_id"]
        x1 = self.add(token, "X", parent=a).json()["node_id"]
        x2 = self.add(token, "x", parent=b).json()["node_id"]
        self.assertNotEqual(x1, x2)

    def test_contribution_per_token_is_unique(self):
        self.open_mindmap()
        token = self.join()
        self.add(token, "Energie")
        response = self.add(token, "energie")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Already added.")
        self.assertEqual(MindmapContribution.objects.count(), 1)

    def test_depth_limit(self):
        self.open_mindmap(mindmap_depth=2)
        token = self.join()
        level1 = self.add(token, "L1").json()["node_id"]
        level2 = self.add(token, "L2", parent=level1).json()["node_id"]
        response = self.add(token, "L3", parent=level2)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Maximum depth reached.")

    def test_per_person_cap(self):
        self.open_mindmap(mindmap_max_per_person=2)
        token = self.join()
        self.assertEqual(self.add(token, "A").status_code, 201)
        self.assertEqual(self.add(token, "B").status_code, 201)
        response = self.add(token, "C")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Maximum reached.")
        # Merging into someone else's node counts as well.
        self.add(self.join(), "D")
        self.assertEqual(self.add(token, "D").status_code, 409)
        # Another participant is unaffected.
        self.assertEqual(self.add(self.join(), "C").status_code, 201)

    def test_per_person_cap_zero_is_unlimited(self):
        self.open_mindmap(mindmap_max_per_person=0)
        token = self.join()
        for i in range(12):
            self.assertEqual(self.add(token, f"T{i}").status_code, 201)

    def test_total_cap(self):
        run = self.open_mindmap(mindmap_max_per_person=0)
        MindmapNode.objects.bulk_create(
            [MindmapNode(run=run, question=self.mq, text=f"N{i}", text_key=f"n{i}")
             for i in range(300)]
        )
        token = self.join()
        response = self.add(token, "New")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "The mind map is full.")
        # Merging into an existing node is still possible.
        self.assertEqual(self.add(token, "n5").status_code, 201)

    def test_length_limits(self):
        self.open_mindmap(mindmap_descriptions=True)
        token = self.join()
        response = self.add(token, "x" * 61)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Term too long.")
        response = self.add(token, "   ")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Empty term.")
        response = self.add(token, "ok", description="d" * 201)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Description too long.")
        self.assertEqual(self.add(token, "x" * 60, description="d" * 200).status_code, 201)

    def test_description_ignored_when_disabled(self):
        self.open_mindmap(mindmap_descriptions=False)
        self.add(self.join(), "Wind", description="Rotoren")
        self.assertEqual(MindmapContribution.objects.get().description, "")

    def test_phase_rules(self):
        run = self.open_mindmap()
        token = self.join()
        for phase in (Run.Phase.PREVIEW, Run.Phase.CLOSED, Run.Phase.RESULTS):
            run.phase = phase
            run.save()
            response = self.add(token, "Wind")
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["detail"], "Voting is closed.")
        run.phase = Run.Phase.FINISHED
        run.save()
        self.assertEqual(self.add(token, "Wind").status_code, 409)

    def test_question_must_be_the_active_mindmap(self):
        self.open_mindmap()
        token = self.join()
        response = self.add(token, "Wind", question=self.question.pk)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Question is not open.")

    def test_active_question_not_a_mindmap(self):
        self.open_question(self.question)
        response = self.add(self.join(), "Wind", question=self.question.pk)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Not a mind map question.")

    def test_unknown_token(self):
        self.open_mindmap()
        self.assertEqual(self.add("nope", "Wind").status_code, 403)

    def test_unknown_parent(self):
        self.open_mindmap()
        response = self.add(self.join(), "Wind", parent=999999)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Unknown parent.")

    def test_parent_from_another_run_is_unknown(self):
        other_set = QuestionSet.objects.create(room=self.room, title="Alt")
        other_run = Run.objects.create(question_set=other_set, phase=Run.Phase.FINISHED)
        foreign = MindmapNode.objects.create(
            run=other_run, question=self.mq, text="F", text_key="f"
        )
        self.open_mindmap()
        response = self.add(self.join(), "Wind", parent=foreign.pk)
        self.assertEqual(response.status_code, 400)

    def test_hidden_parent_blocks_add_including_descendants(self):
        run = self.open_mindmap()
        token = self.join()
        a = self.add(token, "A").json()["node_id"]
        b = self.add(token, "B", parent=a).json()["node_id"]
        MindmapNode.objects.filter(pk=a).update(hidden=True)
        for parent in (a, b):
            response = self.add(self.join(), "C", parent=parent)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["detail"], "Unknown parent.")
        self.assertEqual(run.mindmap_nodes.count(), 2)

    def test_add_broadcasts_debounced(self):
        self.open_mindmap()
        token = self.join()
        with patch("live.views.broadcast") as bc:
            self.add(token, "Wind")
        bc.assert_called_once()
        # Mind-map bursts coalesce into ~1 snapshot per second.
        self.assertEqual(bc.call_args.kwargs.get("debounce"), 1.0)

    def test_vote_endpoint_refuses_mindmap(self):
        self.open_mindmap()
        response = self.vote(self.join(), text="Wind")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"], "Mind map terms are added via the mind map."
        )
        self.assertFalse(Vote.objects.exists())

    def test_recording_vote_refuses_mindmap(self):
        run = self.open_mindmap()
        run.enable_recording()
        response = self.client.post(
            f"/api/live/recording/{run.recording_token}/vote/",
            {"token": self.join(), "question": self.mq.pk, "text": "Wind"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_recording_questions_skip_mindmap(self):
        # Recording viewers can't contribute after the fact, so the mind map
        # question is not listed at all (the other questions stay).
        run = self.open_mindmap()
        run.enable_recording()
        payload = self.client.get(
            f"/api/live/recording/{run.recording_token}/"
        ).json()
        ids = [q["id"] for q in payload["questions"]]
        self.assertNotIn(self.mq.pk, ids)
        self.assertIn(self.question.pk, ids)


class MindmapRemoveTests(MindmapTestCase):
    def test_remove_own_term_deletes_node(self):
        self.open_mindmap()
        token = self.join()
        node = self.add(token, "Wind").json()["node_id"]
        response = self.remove(token, node)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"status": "ok", "deleted": True, "mine": []})
        self.assertFalse(MindmapNode.objects.exists())

    def test_remove_decrements_count(self):
        self.open_mindmap()
        t1, t2 = self.join(), self.join()
        node = self.add(t1, "Wind").json()["node_id"]
        self.add(t2, "wind")
        response = self.remove(t1, node)
        self.assertEqual(response.json()["deleted"], False)
        self.assertEqual(self.tree()["nodes"][0]["count"], 1)
        # The remaining contributor may withdraw too, then the node is gone.
        self.remove(t2, node)
        self.assertFalse(MindmapNode.objects.exists())

    def test_children_block_remove(self):
        self.open_mindmap()
        t1, t2 = self.join(), self.join()
        node = self.add(t1, "Wind").json()["node_id"]
        child = self.add(t2, "Rotor", parent=node).json()["node_id"]
        response = self.remove(t1, node)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Terms hang below this one.")
        # Hidden children block too.
        MindmapNode.objects.filter(pk=child).update(hidden=True)
        self.assertEqual(self.remove(t1, node).status_code, 409)

    def test_only_own_contribution(self):
        self.open_mindmap()
        node = self.add(self.join(), "Wind").json()["node_id"]
        response = self.remove(self.join(), node)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"], "Not your term.")
        self.assertEqual(MindmapContribution.objects.count(), 1)

    def test_unknown_node(self):
        self.open_mindmap()
        response = self.remove(self.join(), 999999)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Unknown term.")

    def test_seeded_node_never_deleted(self):
        self.open_mindmap(mindmap_seed=[{"text": "Wind", "description": "", "children": []}])
        token = self.join()
        node = self.add(token, "wind").json()["node_id"]
        self.assertTrue(MindmapNode.objects.get(pk=node).seeded)
        response = self.remove(token, node)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["deleted"])
        self.assertTrue(MindmapNode.objects.filter(pk=node).exists())
        self.assertEqual(self.tree()["nodes"][0]["count"], 0)

    def test_remove_only_while_open(self):
        run = self.open_mindmap()
        token = self.join()
        node = self.add(token, "Wind").json()["node_id"]
        run.phase = Run.Phase.CLOSED
        run.save()
        response = self.remove(token, node)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Voting is closed.")


class MindmapMineTests(MindmapTestCase):
    def test_mine_lists_own_contributions_only(self):
        self.open_mindmap()
        t1, t2 = self.join(), self.join()
        a = self.add(t1, "A").json()["node_id"]
        self.add(t2, "B")
        self.add(t1, "B")
        b = MindmapNode.objects.get(text_key="b").pk
        response = self.mine(t1)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(sorted(response.json()["nodes"]), sorted([a, b]))

    def test_mine_works_after_close_and_without_run(self):
        run = self.open_mindmap()
        token = self.join()
        a = self.add(token, "A").json()["node_id"]
        run.phase = Run.Phase.RESULTS
        run.save()
        self.assertEqual(self.mine(token).json()["nodes"], [a])
        run.phase = Run.Phase.FINISHED
        run.save()
        self.assertEqual(self.mine(token).json()["nodes"], [])

    def test_mine_unknown_token_and_question(self):
        self.open_mindmap()
        self.assertEqual(self.mine("nope").status_code, 403)
        self.assertEqual(self.mine(self.join(), question=999999).status_code, 404)


class MindmapHideTests(MindmapTestCase):
    def test_owner_hides_and_unhides(self):
        run = self.open_mindmap()
        node = self.add(self.join(), "Spam").json()["node_id"]
        self.client.force_login(self.owner)
        with patch("live.views.broadcast") as bc:
            response = self.hide(run, node)
        self.assertEqual(response.status_code, 200)
        bc.assert_called_once()
        self.assertTrue(MindmapNode.objects.get(pk=node).hidden)
        self.hide(run, node, hidden=False)
        self.assertFalse(MindmapNode.objects.get(pk=node).hidden)

    def test_non_owner_gets_404(self):
        run = self.open_mindmap()
        node = self.add(self.join(), "Spam").json()["node_id"]
        self.client.force_login(User.objects.create_user(username="eve"))
        self.assertEqual(self.hide(run, node).status_code, 404)
        self.assertFalse(MindmapNode.objects.get(pk=node).hidden)

    def test_anonymous_is_refused(self):
        run = self.open_mindmap()
        node = self.add(self.join(), "Spam").json()["node_id"]
        self.assertIn(self.hide(run, node).status_code, (401, 403))

    def test_unknown_node_404(self):
        run = self.open_mindmap()
        self.client.force_login(self.owner)
        self.assertEqual(self.hide(run, 999999).status_code, 404)


class MindmapPayloadTests(MindmapTestCase):
    def test_participant_payload_shape(self):
        self.open_mindmap(mindmap_descriptions=True, mindmap_depth=3,
                          mindmap_max_per_person=4)
        t1, t2 = self.join(), self.join()
        a = self.add(t1, "Wind", description="Rotoren").json()["node_id"]
        self.add(t2, "wind", description="Offshore")
        self.add(t2, "Rotor", parent=a)
        payload = build_payloads(self.room)["participant"]
        self.assertEqual(payload["question"]["kind"], "mindmap")
        mindmap = payload["mindmap"]
        self.assertEqual(mindmap["depth"], 3)
        self.assertEqual(mindmap["max_per_person"], 4)
        self.assertTrue(mindmap["descriptions"])
        self.assertTrue(mindmap["highlight_duplicates"])
        self.assertEqual(mindmap["total"], 2)
        self.assertEqual(mindmap["max_nodes"], 300)
        self.assertEqual(
            resolve_translated_text(mindmap["root"]["label"]), "Was gehört zur Energiewende?"
        )
        wind = mindmap["nodes"][0]
        self.assertEqual(
            set(wind), {"id", "text", "count", "descriptions", "seeded", "children"}
        )  # "teacher" only appears on presenter-added nodes
        self.assertEqual(wind["id"], a)
        self.assertEqual(wind["count"], 2)
        self.assertEqual(wind["descriptions"], ["Rotoren", "Offshore"])
        self.assertEqual(wind["children"][0]["text"], "Rotor")
        self.assertEqual(wind["children"][0]["children"], [])
        # Anonymity: no tokens anywhere in the payload.
        self.assertNotIn(t1, json.dumps(payload))

    def test_root_label_from_setting(self):
        self.mq.mindmap_root_de = "Energiewende"
        self.open_mindmap()
        self.assertEqual(self.tree()["root"]["label"]["de"], "Energiewende")

    def test_descriptions_capped_at_three_and_off_when_disabled(self):
        self.open_mindmap(mindmap_descriptions=True)
        node = None
        for i in range(5):
            node = self.add(self.join(), "Wind", description=f"d{i}").json()["node_id"]
        self.assertEqual(self.tree()["nodes"][0]["descriptions"], ["d0", "d1", "d2"])
        self.mq.mindmap_descriptions = False
        self.mq.save()
        self.assertEqual(self.tree()["nodes"][0]["descriptions"], [])
        self.assertIsNotNone(node)

    def test_hidden_nodes_excluded_for_participants_included_for_presenter(self):
        run = self.open_mindmap()
        token = self.join()
        a = self.add(token, "A").json()["node_id"]
        self.add(token, "B", parent=a)
        self.add(token, "C")
        MindmapNode.objects.filter(pk=a).update(hidden=True)
        participant = self.tree("participant")
        self.assertEqual([n["text"] for n in participant["nodes"]], ["C"])
        self.assertEqual(participant["total"], 1)
        self.assertNotIn("hidden", participant["nodes"][0])
        presenter = self.tree("presenter")
        self.assertEqual([n["text"] for n in presenter["nodes"]], ["A", "C"])
        self.assertTrue(presenter["nodes"][0]["hidden"])
        self.assertFalse(presenter["nodes"][0]["children"][0]["hidden"])
        self.assertEqual(presenter["total"], 3)
        self.assertEqual(run.pk, build_payloads(self.room)["presenter"]["run_id"])

    def test_presenter_votes_counts_contributors(self):
        self.open_mindmap()
        t1 = self.join()
        self.add(t1, "A")
        self.add(t1, "B")
        self.add(self.join(), "A")
        self.assertEqual(build_payloads(self.room)["presenter"]["votes"], 2)

    def test_phases_participant(self):
        run = self.open_mindmap()
        self.add(self.join(), "A")
        for phase in (Run.Phase.CLOSED, Run.Phase.RESULTS):
            run.phase = phase
            run.save()
            payload = build_payloads(self.room)["participant"]
            self.assertEqual(payload["question"]["id"], self.mq.pk)
            self.assertEqual(payload["mindmap"]["nodes"][0]["text"], "A")
        run.phase = Run.Phase.PREVIEW
        run.save()
        payloads = build_payloads(self.room)
        self.assertNotIn("mindmap", payloads["participant"])
        self.assertIn("mindmap", payloads["presenter"])

    def test_non_mindmap_payload_has_no_mindmap(self):
        self.open_question(self.question)
        payloads = build_payloads(self.room)
        self.assertNotIn("mindmap", payloads["participant"])
        self.assertNotIn("mindmap", payloads["presenter"])

    def test_bounded_queries(self):
        self.open_mindmap(mindmap_max_per_person=0, mindmap_descriptions=True)
        token = self.join()
        parent = None
        for i in range(5):
            parent = self.add(token, f"T{i}", parent=parent).json()["node_id"]
        run = active_run(self.room)
        from .mindmap import build_tree

        with self.assertNumQueries(3):
            build_tree(run, self.mq, presenter=True)


class MindmapSeedTests(MindmapTestCase):
    SEED = [
        {"text": "Wind", "description": "Rotoren", "children": [
            {"text": "Offshore", "description": "", "children": []},
        ]},
        {"text": "Sonne", "description": "", "children": []},
    ]

    def test_seed_materialised_once_per_run(self):
        run = self.open_mindmap(mindmap_seed=self.SEED)
        tree = self.tree()
        self.assertEqual([n["text"] for n in tree["nodes"]], ["Wind", "Sonne"])
        wind = tree["nodes"][0]
        self.assertTrue(wind["seeded"])
        self.assertEqual(wind["count"], 0)
        self.assertEqual(wind["descriptions"], [])  # descriptions off
        self.assertEqual(wind["children"][0]["text"], "Offshore")
        self.tree()
        build_payloads(self.room)
        self.assertEqual(run.mindmap_nodes.count(), 3)
        # A new run gets its own copy.
        run.phase = Run.Phase.FINISHED
        run.save()
        run2 = self.open_question(self.mq)
        self.tree()
        self.assertEqual(run2.mindmap_nodes.count(), 3)
        self.assertEqual(MindmapNode.objects.count(), 6)

    def test_seed_description_shown_first(self):
        self.open_mindmap(mindmap_seed=self.SEED, mindmap_descriptions=True)
        wind = self.tree()["nodes"][0]["id"]
        self.add(self.join(), "Wind", description="Windkraft")
        node = self.tree()["nodes"][0]
        self.assertEqual(node["id"], wind)
        self.assertEqual(node["descriptions"], ["Rotoren", "Windkraft"])

    def test_add_materialises_seed_first(self):
        self.open_mindmap(mindmap_seed=self.SEED)
        token = self.join()
        node = self.add(token, "sonne").json()["node_id"]
        self.assertTrue(MindmapNode.objects.get(pk=node).seeded)
        self.assertEqual(MindmapNode.objects.count(), 3)

    def test_seed_counts_towards_depth(self):
        self.open_mindmap(mindmap_seed=self.SEED, mindmap_depth=2)
        self.tree()
        offshore = MindmapNode.objects.get(text="Offshore")
        response = self.add(self.join(), "Turbine", parent=offshore.pk)
        self.assertEqual(response.status_code, 400)


class MindmapSeedI18nTests(MindmapTestCase):
    SEED = [
        {"text": {"de": "Wind", "en": "Wind power"},
         "description": {"de": "Rotoren", "en": "Rotors"}, "children": [
            {"text": {"de": "Meer", "en": "Offshore"},
             "description": {"de": "", "en": ""}, "children": []},
        ]},
        {"text": "Sonne", "description": "", "children": []},  # legacy string
    ]

    def test_seeded_nodes_carry_both_languages(self):
        self.open_mindmap(mindmap_seed=self.SEED, mindmap_descriptions=True)
        for role in ("participant", "presenter"):
            nodes = self.tree(role)["nodes"]
            wind, sonne = nodes
            # ``text`` stays the canonical string (merge key, CSV, legacy
            # clients); the maps are added for seeded nodes.
            self.assertEqual(wind["text"], "Wind", role)
            self.assertEqual(wind["text_i18n"], {"de": "Wind", "en": "Wind power"}, role)
            self.assertEqual(wind["descriptions"], ["Rotoren"], role)
            self.assertEqual(
                wind["description_i18n"], {"de": "Rotoren", "en": "Rotors"}, role
            )
            self.assertEqual(
                wind["children"][0]["text_i18n"], {"de": "Meer", "en": "Offshore"}, role
            )
            self.assertNotIn("description_i18n", wind["children"][0], role)
            self.assertEqual(sonne["text_i18n"], {"de": "Sonne", "en": ""}, role)
        node = MindmapNode.objects.get(text="Wind")
        self.assertEqual(node.text_key, "wind")
        self.assertEqual(node.description, "Rotoren")
        self.assertEqual(
            node.seed_i18n,
            {"text": {"de": "Wind", "en": "Wind power"},
             "description": {"de": "Rotoren", "en": "Rotors"}},
        )

    def test_participant_nodes_have_no_maps(self):
        self.open_mindmap(mindmap_seed=self.SEED)
        self.add(self.join(), "Wasser")
        water = self.tree()["nodes"][-1]
        self.assertEqual(water["text"], "Wasser")
        self.assertNotIn("text_i18n", water)
        self.assertNotIn("description_i18n", water)

    def test_description_map_only_when_descriptions_on(self):
        self.open_mindmap(mindmap_seed=self.SEED)
        wind = self.tree()["nodes"][0]
        self.assertEqual(wind["descriptions"], [])
        self.assertNotIn("description_i18n", wind)

    def test_merge_only_on_canonical_term(self):
        self.open_mindmap(mindmap_seed=self.SEED)
        wind = self.tree()["nodes"][0]["id"]
        token = self.join()
        self.assertEqual(self.add(token, "wind").json()["node_id"], wind)
        other = self.add(token, "Wind power").json()["node_id"]
        self.assertNotEqual(other, wind)

    def test_results_and_csv_use_canonical(self):
        run = self.open_mindmap(mindmap_seed=self.SEED)
        wind = self.tree()["nodes"][0]["id"]
        self.add(self.join(), "Wind")
        self.add(self.join(), "Turbine", parent=wind)
        run.phase = Run.Phase.FINISHED
        run.save()
        self.client.force_login(self.owner)
        results = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        item = next(q for q in results[0]["questions"] if q["kind"] == "mindmap")
        node = item["mindmap"]["nodes"][0]
        self.assertEqual(node["text"], "Wind")
        self.assertEqual(node["text_i18n"], {"de": "Wind", "en": "Wind power"})
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8")
        self.assertIn(";Wind > Meer;;0;", body)
        self.assertNotIn("Wind power", body)


class MindmapResultsTests(MindmapTestCase):
    def _run(self):
        run = self.open_mindmap()
        t1 = self.join()
        a = self.add(t1, "Wind").json()["node_id"]
        self.add(self.join(), "Rotor", parent=a)
        self.add(self.join(), "wind")
        spam = self.add(t1, "Spam").json()["node_id"]
        MindmapNode.objects.filter(pk=spam).update(hidden=True)
        run.phase = Run.Phase.FINISHED
        run.save()
        return run

    def test_run_results_tree_and_listing(self):
        self._run()
        self.client.force_login(self.owner)
        results = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        # A run with only mind-map contributions is listed.
        self.assertEqual(len(results), 1)
        item = next(q for q in results[0]["questions"] if q["kind"] == "mindmap")
        self.assertEqual(item["votes"], 3)
        nodes = item["mindmap"]["nodes"]
        self.assertEqual([n["text"] for n in nodes], ["Wind"])
        self.assertEqual(nodes[0]["count"], 2)
        self.assertEqual(nodes[0]["children"][0]["text"], "Rotor")
        self.assertNotIn("options", item)

    def test_csv_rows_per_node_path(self):
        self._run()
        self.client.force_login(self.owner)
        response = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        )
        self.assertEqual(response.status_code, 200)
        body = response.content.decode("utf-8")
        self.assertIn(";Wind;;2;", body)
        self.assertIn(";Wind > Rotor;;1;", body)
        self.assertNotIn("Spam", body)

    def test_archive_results_finishes_run_with_mindmap_only(self):
        run = self.open_mindmap()
        self.add(self.join(), "Wind")
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/archive-results/"
        )
        self.assertNotEqual(response.json()["run"], run.pk)
        run.refresh_from_db()
        self.assertEqual(run.phase, Run.Phase.FINISHED)


class MindmapConcurrencyTests(TransactionTestCase):
    """Two participants adding the same term at the same moment end as one
    node with count 2 (real Postgres concurrency, like ConcurrentStartRunTests)."""

    def setUp(self):
        self.room = Room.objects.create(title="Bio 101")
        qs = QuestionSet.objects.create(room=self.room, title="Termin 1")
        self.mq = Question.objects.create(
            question_set=qs, kind=Question.Kind.MINDMAP, text="<p>Energie?</p>"
        )
        Run.objects.create(question_set=qs, phase=Run.Phase.OPEN, active_question=self.mq)
        self.tokens = [ParticipantToken.objects.create(room=self.room).key for _ in range(4)]

    def test_simultaneous_same_term(self):
        barrier = threading.Barrier(4)
        results = [None] * 4

        def worker(index):
            client = Client()
            try:
                barrier.wait(timeout=5)
                results[index] = client.post(
                    f"/api/live/rooms/{self.room.code}/mindmap/add/",
                    {"token": self.tokens[index], "question": self.mq.pk,
                     "parent": None, "text": "Energie" if index % 2 else "energie "},
                    content_type="application/json",
                )
            finally:
                connections.close_all()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        for response in results:
            self.assertIsNotNone(response)
            self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(MindmapNode.objects.count(), 1)
        self.assertEqual(MindmapContribution.objects.count(), 4)


class MindmapFixRoundTests(MindmapTestCase):
    """Final-review fixes: run lifecycle counts contributions, key overflow,
    normalisation, strict moderation input, CSV injection."""

    def _contribute(self):
        run = self.open_mindmap()
        self.add(self.join(), "Wind")
        return run

    def test_other_set_start_keeps_mindmap_only_run(self):
        run = self._contribute()
        other = QuestionSet.objects.create(room=self.room, title="Termin 2")
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/question-sets/{other.pk}/start-run/", {}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        run.refresh_from_db()
        self.assertEqual(run.phase, Run.Phase.FINISHED)
        self.assertEqual(MindmapContribution.objects.count(), 1)

    def test_archive_start_finishes_stale_mindmap_run(self):
        run = self._contribute()
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "archive"}, content_type="application/json",
        )
        self.assertNotEqual(response.json()["run"], run.pk)
        run.refresh_from_db()
        self.assertEqual(run.phase, Run.Phase.FINISHED)

    def test_live_status_counts_contributions(self):
        self._contribute()
        self.client.force_login(self.owner)
        data = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()
        self.assertTrue(data["has_votes"])
        self.assertTrue(data["active_run_has_votes"])

    def test_votes_total_includes_contributions(self):
        run = self._contribute()
        self.add(self.join(), "Sonne")
        self.vote(self.join(), options=[self.correct.pk])  # other question not open
        from .results import run_results

        self.assertEqual(run_results(run)["votes_total"], 2)

    def test_sharp_s_term_fits_text_key(self):
        self.open_mindmap()
        response = self.add(self.join(), "ß" * 60)
        self.assertEqual(response.status_code, 201, response.content)
        node = MindmapNode.objects.get()
        self.assertEqual(len(node.text_key), 60)
        # The same term again merges (same truncated key).
        self.assertTrue(self.add(self.join(), "ß" * 60).json()["merged"])

    def test_sharp_s_seed_materialises(self):
        self.open_mindmap(mindmap_seed=[{"text": "ß" * 60, "description": "", "children": []}])
        self.assertEqual(self.tree()["nodes"][0]["text"], "ß" * 60)

    def test_nul_and_zero_width_terms(self):
        self.open_mindmap(mindmap_descriptions=True)
        token = self.join()
        response = self.add(token, "Wi\x00nd", description="Ro\x00tor")
        self.assertEqual(response.status_code, 201, response.content)
        node = MindmapNode.objects.get()
        self.assertEqual(node.text, "Wind")
        self.assertEqual(MindmapContribution.objects.get().description, "Rotor")
        response = self.add(token, "\u200b\u200b")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Empty term.")

    def test_nfc_and_nfd_merge(self):
        self.open_mindmap()
        first = self.add(self.join(), "Caf\u00e9").json()["node_id"]
        response = self.add(self.join(), "Cafe\u0301")
        self.assertEqual(response.json()["node_id"], first)

    def test_hide_requires_boolean(self):
        run = self._contribute()
        node = MindmapNode.objects.get().pk
        self.client.force_login(self.owner)
        for bad in ("false", 0, None, "yes"):
            response = self.hide(run, node, hidden=bad)
            self.assertEqual(response.status_code, 400, bad)
            self.assertEqual(response.json()["detail"], "hidden must be true or false.")
        self.assertFalse(MindmapNode.objects.get().hidden)

    def test_participant_tree_has_no_key_presenter_has(self):
        self._contribute()
        self.assertNotIn("key", self.tree("participant")["nodes"][0])
        self.assertEqual(self.tree("presenter")["nodes"][0]["key"], "wind")

    def test_csv_escapes_formula_cells(self):
        run = self.open_mindmap()
        self.add(self.join(), "=HYPERLINK(1)")
        wc = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.WORD_CLOUD,
            text="<p>W</p>", position=2,
        )
        Vote.objects.create(
            run=run, question=wc, token=ParticipantToken.objects.create(room=self.room),
            text="@SUM(A1)",
        )
        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8")
        self.assertIn(";'=HYPERLINK(1);", body)
        self.assertIn(";'@SUM(A1);", body)
        self.assertNotIn(";=HYPERLINK", body)

    def test_csv_safe_helper(self):
        from common.csv_safe import csv_safe

        for raw in ("=1", "+1", "-1", "@x", "\tx", "\rx"):
            self.assertEqual(csv_safe(raw), "'" + raw)
        self.assertEqual(csv_safe("Wind"), "Wind")
        self.assertEqual(csv_safe(3), 3)


class MindmapModerationTestCase(MindmapTestCase):
    """Stage 2: the presenter's moderation operations (owner-only)."""

    def setUp(self):
        super().setUp()
        self.run = self.open_mindmap()

    def mod(self, op, run=None, **body):
        return self.client.post(
            f"/api/runs/{(run or self.run).pk}/mindmap/{self.mq.pk}/{op}",
            body, content_type="application/json",
        )

    def owner_mod(self, op, **body):
        self.client.force_login(self.owner)
        with patch("live.views.broadcast"):
            return self.mod(op, **body)

    def node(self, text, parent=None):
        return MindmapNode.objects.get(
            run=self.run, question=self.mq, text_key=text.casefold(), parent=parent
        )

    def contribute(self, text, parent=None, token=None, **extra):
        token = token or self.join()
        response = self.add(token, text, parent=parent, **extra)
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()["node_id"]

    def shape(self):
        """{text: (parent text, count)} of all nodes — for exact-restore checks."""
        result = {}
        for node in MindmapNode.objects.filter(run=self.run, question=self.mq):
            result[(node.parent.text if node.parent else None, node.text)] = (
                node.contributions.count(), node.seeded, node.teacher, node.hidden,
                node.description,
            )
        return result


class MindmapModerationAccessTests(MindmapModerationTestCase):
    OPS = ("add", "merge", "unmerge", "move", "rename", "delete")

    def test_non_owner_gets_404_everywhere(self):
        node = self.contribute("Wind")
        self.client.force_login(User.objects.create_user(username="eve"))
        for op in self.OPS:
            self.assertEqual(
                self.mod(op, node=node, text="X", parent=None, source=node,
                         target=node, undo="x").status_code, 404, op,
            )
        self.assertEqual(MindmapNode.objects.get(pk=node).text, "Wind")

    def test_anonymous_refused(self):
        for op in self.OPS:
            self.assertIn(self.mod(op, text="X").status_code, (401, 403), op)

    def test_non_mindmap_question_404(self):
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/runs/{self.run.pk}/mindmap/{self.question.pk}/add",
            {"parent": None, "text": "X"}, content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_broadcasts_after_change(self):
        self.client.force_login(self.owner)
        with patch("live.views.broadcast") as bc:
            self.assertEqual(self.mod("add", parent=None, text="Wind").status_code, 201)
        bc.assert_called_once()


class MindmapTeacherAddTests(MindmapModerationTestCase):
    def test_add_creates_teacher_node_without_contribution(self):
        response = self.owner_mod("add", parent=None, text="  Solar  ")
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertEqual(set(body), {"node_id", "merged"})
        self.assertFalse(body["merged"])
        node = MindmapNode.objects.get(pk=body["node_id"])
        self.assertEqual((node.text, node.text_key, node.parent), ("Solar", "solar", None))
        self.assertTrue(node.teacher)
        self.assertFalse(node.seeded)
        self.assertFalse(node.contributions.exists())
        tree = self.tree()
        self.assertEqual(tree["nodes"][0]["count"], 0)
        self.assertTrue(tree["nodes"][0]["teacher"])

    def test_teacher_flag_only_on_teacher_nodes_in_payload(self):
        self.contribute("Wind")
        self.assertNotIn("teacher", self.tree()["nodes"][0])

    def test_add_same_name_returns_existing_node(self):
        existing = self.contribute("Wind")
        response = self.owner_mod("add", parent=None, text="WIND")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"node_id": existing, "merged": True})
        node = MindmapNode.objects.get(pk=existing)
        self.assertFalse(node.teacher)
        self.assertEqual(node.contributions.count(), 1)

    def test_add_child_and_depth(self):
        self.mq.mindmap_depth = 2
        self.mq.save()
        a = self.owner_mod("add", parent=None, text="A").json()["node_id"]
        b = self.owner_mod("add", parent=a, text="B")
        self.assertEqual(b.status_code, 201)
        response = self.owner_mod("add", parent=b.json()["node_id"], text="C")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Maximum depth reached.")

    def test_add_description_only_when_enabled(self):
        node = self.owner_mod("add", parent=None, text="A", description="d").json()
        self.assertEqual(MindmapNode.objects.get(pk=node["node_id"]).description, "")
        self.mq.mindmap_descriptions = True
        self.mq.save()
        node = self.owner_mod("add", parent=None, text="B", description=" Erklärung ").json()
        self.assertEqual(MindmapNode.objects.get(pk=node["node_id"]).description, "Erklärung")
        self.assertEqual(self.tree()["nodes"][1]["descriptions"], ["Erklärung"])

    def test_add_validation(self):
        self.assertEqual(self.owner_mod("add", parent=None, text="  ").status_code, 400)
        self.assertEqual(self.owner_mod("add", parent=None, text="x" * 61).status_code, 400)
        self.assertEqual(self.owner_mod("add", parent=None, text=5).status_code, 400)
        self.assertEqual(self.owner_mod("add", parent="1", text="A").status_code, 400)
        self.assertEqual(self.owner_mod("add", parent=True, text="A").status_code, 400)
        self.assertEqual(
            self.owner_mod("add", parent=None, text="A", description=3).status_code, 400
        )
        self.assertEqual(self.owner_mod("add", parent=999999, text="A").status_code, 404)
        hidden = self.contribute("H")
        MindmapNode.objects.filter(pk=hidden).update(hidden=True)
        self.assertEqual(self.owner_mod("add", parent=hidden, text="A").status_code, 409)
        self.assertFalse(MindmapNode.objects.filter(text="A").exists())

    def test_add_respects_node_cap(self):
        from live import mindmap as mm

        with patch.object(mm, "MINDMAP_MAX_NODES", 1):
            self.owner_mod("add", parent=None, text="A")
            response = self.owner_mod("add", parent=None, text="B")
        self.assertEqual(response.status_code, 409)

    def test_participants_cannot_delete_teacher_node_and_no_quota(self):
        self.mq.mindmap_max_per_person = 1
        self.mq.save()
        node = self.owner_mod("add", parent=None, text="Wind").json()["node_id"]
        token = self.join()
        # Joining the teacher's term costs the participant one contribution …
        self.assertEqual(self.add(token, "wind").status_code, 201)
        response = self.remove(token, node)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["deleted"])
        self.assertTrue(MindmapNode.objects.filter(pk=node).exists())
        # … but the teacher's own nodes never count towards anyone's quota.
        self.owner_mod("add", parent=None, text="Solar")
        self.assertEqual(self.add(token, "Biogas").status_code, 201)


class MindmapTeacherDeleteTests(MindmapModerationTestCase):
    def test_delete_teacher_leaf(self):
        node = self.owner_mod("add", parent=None, text="A").json()["node_id"]
        response = self.owner_mod("delete", node=node)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertFalse(MindmapNode.objects.filter(pk=node).exists())

    def test_delete_refusals(self):
        participant = self.contribute("P")
        self.assertEqual(self.owner_mod("delete", node=participant).status_code, 409)
        teacher = self.owner_mod("add", parent=None, text="T").json()["node_id"]
        self.contribute("t")
        self.assertEqual(self.owner_mod("delete", node=teacher).status_code, 409)
        parent = self.owner_mod("add", parent=None, text="Q").json()["node_id"]
        self.owner_mod("add", parent=parent, text="child")
        self.assertEqual(self.owner_mod("delete", node=parent).status_code, 409)
        self.assertEqual(self.owner_mod("delete", node=999999).status_code, 404)
        self.assertEqual(self.owner_mod("delete", node="1").status_code, 400)
        self.assertEqual(MindmapNode.objects.count(), 4)


class MindmapMergeTests(MindmapModerationTestCase):
    def test_merge_moves_contributions_and_deletes_source(self):
        t1, t2, t3 = self.join(), self.join(), self.join()
        source = self.contribute("Windrad", token=t1)
        self.contribute("Windrad", token=t2)
        target = self.contribute("Windkraft", token=t2)
        self.contribute("Windkraft", token=t3)
        response = self.owner_mod("merge", source=source, target=target)
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(set(body), {"undo"})
        self.assertIsInstance(body["undo"], str)
        self.assertFalse(MindmapNode.objects.filter(pk=source).exists())
        # Distinct contributors: t2's duplicate is dropped.
        self.assertEqual(MindmapNode.objects.get(pk=target).contributions.count(), 3)
        # Anonymity: no participant token in the undo data.
        for token in (t1, t2, t3):
            self.assertNotIn(token, json.dumps(body))

    def test_merge_reparents_children_and_merges_same_named_recursively(self):
        source = self.contribute("Wind")
        target = self.contribute("Windenergie")
        rotor_s = self.contribute("Rotor", parent=source)
        self.contribute("Blatt", parent=rotor_s)
        rotor_t = self.contribute("rotor", parent=target)
        self.contribute("blatt", parent=rotor_t)
        mast = self.contribute("Mast", parent=source)
        response = self.owner_mod("merge", source=source, target=target)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(MindmapNode.objects.get(pk=mast).parent_id, target)
        self.assertFalse(MindmapNode.objects.filter(pk=rotor_s).exists())
        rotor = MindmapNode.objects.get(pk=rotor_t)
        self.assertEqual(rotor.contributions.count(), 2)
        blatt = rotor.children.get()
        self.assertEqual(blatt.contributions.count(), 2)
        self.assertEqual(MindmapNode.objects.count(), 4)

    def test_merge_refusals(self):
        a = self.contribute("A")
        b = self.contribute("B", parent=a)
        c = self.contribute("C")
        self.assertEqual(self.owner_mod("merge", source=a, target=a).status_code, 400)
        self.assertEqual(self.owner_mod("merge", source=a, target=b).status_code, 409)
        self.assertEqual(self.owner_mod("merge", source=b, target=a).status_code, 409)
        self.assertEqual(self.owner_mod("merge", source=a, target=999999).status_code, 404)
        self.assertEqual(self.owner_mod("merge", source="1", target=c).status_code, 400)
        self.assertEqual(self.owner_mod("merge", source=None, target=c).status_code, 400)
        MindmapNode.objects.filter(pk=c).update(hidden=True)
        self.assertEqual(self.owner_mod("merge", source=b, target=c).status_code, 409)
        self.assertEqual(self.owner_mod("merge", source=c, target=b).status_code, 409)
        self.assertEqual(MindmapNode.objects.count(), 3)

    def test_merge_refused_into_hidden_subtree(self):
        a = self.contribute("A")
        b = self.contribute("B", parent=a)
        c = self.contribute("C")
        MindmapNode.objects.filter(pk=a).update(hidden=True)
        self.assertEqual(self.owner_mod("merge", source=c, target=b).status_code, 409)

    def test_merge_refused_beyond_depth(self):
        self.mq.mindmap_depth = 3
        self.mq.save()
        deep_parent = self.contribute("P")
        target = self.contribute("T", parent=self.contribute("Q", parent=deep_parent))
        source = self.contribute("S")
        self.contribute("child", parent=source)
        response = self.owner_mod("merge", source=source, target=target)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Maximum depth reached.")

    def test_merge_inherits_protection(self):
        source = self.owner_mod("add", parent=None, text="T").json()["node_id"]
        target = self.contribute("P")
        self.owner_mod("merge", source=source, target=target)
        self.assertTrue(MindmapNode.objects.get(pk=target).teacher)

    def test_merging_away_seeded_node_keeps_seed_materialised(self):
        self.mq.mindmap_seed = [{"text": "Wind", "description": "", "children": []}]
        self.mq.save()
        self.tree()
        seeded = self.node("Wind")
        target = self.contribute("Windkraft")
        self.assertEqual(self.owner_mod("merge", source=seeded.pk, target=target).status_code, 200)
        self.tree()  # ensure_seed must not re-create the merged seed node
        self.assertFalse(MindmapNode.objects.filter(text_key="wind").exists())
        self.assertTrue(MindmapNode.objects.get(pk=target).seeded)


class MindmapUnmergeTests(MindmapModerationTestCase):
    def build(self):
        t1, t2, t3 = self.join(), self.join(), self.join()
        self.source = self.contribute("Wind", token=t1, description="")
        self.contribute("Wind", token=t2)
        self.target = self.contribute("Windkraft", token=t2)
        self.contribute("Windkraft", token=t3)
        rotor_s = self.contribute("Rotor", parent=self.source, token=t1)
        self.contribute("Blatt", parent=rotor_s, token=t1)
        rotor_t = self.contribute("Rotor", parent=self.target, token=t1)
        self.contribute("Nabe", parent=rotor_t, token=t2)
        hidden = self.contribute("Mast", parent=self.source, token=t3)
        MindmapNode.objects.filter(pk=hidden).update(hidden=True)
        self.tokens = (t1, t2, t3)

    def test_unmerge_restores_exactly(self):
        self.build()
        before = self.shape()
        ids = set(MindmapNode.objects.values_list("id", flat=True))
        undo = self.owner_mod("merge", source=self.source, target=self.target).json()["undo"]
        self.assertNotEqual(self.shape(), before)
        response = self.owner_mod("unmerge", undo=undo)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(self.shape(), before)
        # Same node ids (the beamer keeps its layout/undo stack valid).
        self.assertEqual(set(MindmapNode.objects.values_list("id", flat=True)), ids)
        # Own-term lists of participants are intact.
        self.assertIn(self.source, self.mine(self.tokens[0]).json()["nodes"])
        self.assertIn(self.source, self.mine(self.tokens[1]).json()["nodes"])

    def test_unmerge_restores_target_flags(self):
        self.mq.mindmap_descriptions = True
        self.mq.save()
        source = self.owner_mod("add", parent=None, text="T", description="Info").json()["node_id"]
        target = self.contribute("P")
        undo = self.owner_mod("merge", source=source, target=target).json()["undo"]
        node = MindmapNode.objects.get(pk=target)
        self.assertEqual((node.teacher, node.description), (True, "Info"))
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 200)
        node.refresh_from_db()
        self.assertEqual((node.teacher, node.description), (False, ""))
        self.assertTrue(MindmapNode.objects.get(pk=source).teacher)

    def test_unmerge_conflict_when_contribution_withdrawn(self):
        self.build()
        undo = self.owner_mod("merge", source=self.source, target=self.target).json()["undo"]
        # t1's moved "Wind" contribution disappears in the meantime.
        MindmapContribution.objects.filter(
            node_id=self.target, token__key=self.tokens[0]
        ).delete()
        before = self.shape()
        response = self.owner_mod("unmerge", undo=undo)
        self.assertEqual(response.status_code, 409)
        self.assertIn("detail", response.json())
        self.assertEqual(self.shape(), before)  # nothing half-restored

    def test_unmerge_conflict_when_child_moved_away(self):
        source = self.contribute("A")
        target = self.contribute("B")
        child = self.contribute("C", parent=source)
        undo = self.owner_mod("merge", source=source, target=target).json()["undo"]
        self.owner_mod("move", node=child, parent=None)
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 409)

    def test_unmerge_conflict_when_name_taken_again(self):
        source = self.contribute("A")
        target = self.contribute("B")
        undo = self.owner_mod("merge", source=source, target=target).json()["undo"]
        self.contribute("a")
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 409)

    def test_unmerge_twice_conflicts(self):
        source = self.contribute("A")
        target = self.contribute("B")
        undo = self.owner_mod("merge", source=source, target=target).json()["undo"]
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 200)
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 409)

    def test_unmerge_rejects_forged_or_foreign_data(self):
        source = self.contribute("A")
        target = self.contribute("B")
        undo = self.owner_mod("merge", source=source, target=target).json()["undo"]
        self.assertEqual(self.owner_mod("unmerge", undo=undo + "x").status_code, 400)
        self.assertEqual(self.owner_mod("unmerge", undo={"source": 1}).status_code, 400)
        self.assertEqual(self.owner_mod("unmerge").status_code, 400)
        other = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.FINISHED, active_question=self.mq
        )
        self.client.force_login(self.owner)
        with patch("live.views.broadcast"):
            self.assertEqual(self.mod("unmerge", run=other, undo=undo).status_code, 400)


class MindmapMoveTests(MindmapModerationTestCase):
    def test_move_to_other_parent_and_back(self):
        a = self.contribute("A")
        b = self.contribute("B")
        c = self.contribute("C", parent=a)
        response = self.owner_mod("move", node=c, parent=b)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"undo": {"node": c, "parent": a}})
        self.assertEqual(MindmapNode.objects.get(pk=c).parent_id, b)
        response = self.owner_mod("move", node=c, parent=None)
        self.assertEqual(response.json(), {"undo": {"node": c, "parent": b}})
        self.assertIsNone(MindmapNode.objects.get(pk=c).parent_id)

    def test_move_not_into_own_subtree(self):
        a = self.contribute("A")
        b = self.contribute("B", parent=a)
        self.assertEqual(self.owner_mod("move", node=a, parent=b).status_code, 409)
        self.assertEqual(self.owner_mod("move", node=a, parent=a).status_code, 409)

    def test_move_depth_counts_deepest_descendant(self):
        self.mq.mindmap_depth = 3
        self.mq.save()
        a = self.contribute("A")
        b = self.contribute("B", parent=a)
        x = self.contribute("X")
        self.contribute("Y", parent=x)
        response = self.owner_mod("move", node=x, parent=b)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Maximum depth reached.")
        self.assertEqual(self.owner_mod("move", node=x, parent=a).status_code, 200)

    def test_move_clash_suggests_merge(self):
        a = self.contribute("A")
        existing = self.contribute("Rotor", parent=a)
        other = self.contribute("rotor")
        response = self.owner_mod("move", node=other, parent=a)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["conflict"], existing)
        self.assertIn("detail", response.json())

    def test_move_refusals(self):
        a = self.contribute("A")
        h = self.contribute("H")
        MindmapNode.objects.filter(pk=h).update(hidden=True)
        self.assertEqual(self.owner_mod("move", node=a, parent=h).status_code, 409)
        self.assertEqual(self.owner_mod("move", node=a, parent=999999).status_code, 404)
        self.assertEqual(self.owner_mod("move", node=999999, parent=None).status_code, 404)
        self.assertEqual(self.owner_mod("move", node=a, parent="x").status_code, 400)
        self.assertEqual(self.owner_mod("move", node=a).status_code, 400)  # parent missing

    def test_move_same_parent_is_noop(self):
        a = self.contribute("A")
        response = self.owner_mod("move", node=a, parent=None)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"undo": {"node": a, "parent": None}})


class MindmapRenameTests(MindmapModerationTestCase):
    def test_rename_and_undo(self):
        a = self.contribute("Wnd")
        response = self.owner_mod("rename", node=a, text=" Wind ")
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual((body["node_id"], body["merged"]), (a, False))
        node = MindmapNode.objects.get(pk=a)
        self.assertEqual((node.text, node.text_key), ("Wind", "wind"))
        self.assertEqual(self.owner_mod("unmerge", undo=body["undo"]).status_code, 200)
        node.refresh_from_db()
        self.assertEqual((node.text, node.text_key), ("Wnd", "wnd"))

    def test_rename_case_only(self):
        a = self.contribute("wind")
        body = self.owner_mod("rename", node=a, text="Wind").json()
        self.assertFalse(body["merged"])
        self.assertEqual(MindmapNode.objects.get(pk=a).text, "Wind")

    def test_rename_seeded_drops_stale_translation_and_undo_restores_it(self):
        self.mq.mindmap_seed = [
            {"text": {"de": "Wind", "en": "Wind power"}, "description": "", "children": []}
        ]
        self.mq.save()
        self.tree()
        seeded = self.node("Wind")
        undo = self.owner_mod("rename", node=seeded.pk, text="Windkraft").json()["undo"]
        node = self.tree()["nodes"][0]
        self.assertEqual(node["text_i18n"]["de"], "Windkraft")
        self.assertEqual(node["text_i18n"]["en"], "")
        self.owner_mod("unmerge", undo=undo)
        node = self.tree()["nodes"][0]
        self.assertEqual(node["text_i18n"], {"de": "Wind", "en": "Wind power"})

    def test_rename_clash_merges_into_existing(self):
        t1, t2 = self.join(), self.join()
        a = self.contribute("Wnd", token=t1)
        b = self.contribute("Wind", token=t2)
        child = self.contribute("Rotor", parent=a)
        before = self.shape()
        response = self.owner_mod("rename", node=a, text="wind")
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual((body["node_id"], body["merged"]), (b, True))
        self.assertFalse(MindmapNode.objects.filter(pk=a).exists())
        self.assertEqual(MindmapNode.objects.get(pk=child).parent_id, b)
        self.assertEqual(MindmapNode.objects.get(pk=b).contributions.count(), 2)
        self.assertEqual(self.owner_mod("unmerge", undo=body["undo"]).status_code, 200)
        self.assertEqual(self.shape(), before)

    def test_rename_clash_with_hidden_sibling_refused(self):
        a = self.contribute("Wnd")
        b = self.contribute("Wind")
        MindmapNode.objects.filter(pk=b).update(hidden=True)
        self.assertEqual(self.owner_mod("rename", node=a, text="Wind").status_code, 409)

    def test_rename_validation(self):
        a = self.contribute("A")
        self.assertEqual(self.owner_mod("rename", node=a, text="").status_code, 400)
        self.assertEqual(self.owner_mod("rename", node=a, text="x" * 61).status_code, 400)
        self.assertEqual(self.owner_mod("rename", node=a, text=None).status_code, 400)
        self.assertEqual(self.owner_mod("rename", node=999999, text="B").status_code, 404)

    def test_rename_undo_conflict_when_old_name_taken(self):
        a = self.contribute("A")
        undo = self.owner_mod("rename", node=a, text="B").json()["undo"]
        self.contribute("a")
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 409)
        self.assertEqual(MindmapNode.objects.get(pk=a).text, "B")


class MindmapHideUndoTests(MindmapModerationTestCase):
    def test_hide_echoes_node_and_state(self):
        a = self.contribute("A")
        response = self.owner_mod("hide", node=a, hidden=True)
        self.assertEqual(response.json(), {"status": "ok", "node": a, "hidden": True})


class MindmapModerationConcurrencyTests(TransactionTestCase):
    """Two presenter tabs merging the same source at the same moment: exactly
    one merge happens, the other is refused cleanly."""

    def setUp(self):
        self.owner = User.objects.create_user(username="frank")
        self.room = Room.objects.create(title="Bio 101")
        self.room.owners.add(self.owner)
        qs = QuestionSet.objects.create(room=self.room, title="Termin 1")
        self.mq = Question.objects.create(
            question_set=qs, kind=Question.Kind.MINDMAP, text="<p>Energie?</p>"
        )
        self.run = Run.objects.create(
            question_set=qs, phase=Run.Phase.OPEN, active_question=self.mq
        )
        self.source = MindmapNode.objects.create(
            run=self.run, question=self.mq, text="A", text_key="a"
        )
        self.targets = [
            MindmapNode.objects.create(
                run=self.run, question=self.mq, text=t, text_key=t.lower()
            )
            for t in ("B", "C")
        ]
        for node in (self.source, *self.targets):
            MindmapContribution.objects.create(
                node=node, token=ParticipantToken.objects.create(room=self.room)
            )

    def test_simultaneous_merges_of_one_source(self):
        barrier = threading.Barrier(2)
        results = [None] * 2

        def worker(index):
            client = Client()
            client.force_login(self.owner)
            try:
                barrier.wait(timeout=5)
                with patch("live.views.broadcast"):
                    results[index] = client.post(
                        f"/api/runs/{self.run.pk}/mindmap/{self.mq.pk}/merge",
                        {"source": self.source.pk, "target": self.targets[index].pk},
                        content_type="application/json",
                    )
            finally:
                connections.close_all()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        codes = sorted(r.status_code for r in results)
        self.assertEqual(codes, [200, 404])
        self.assertFalse(MindmapNode.objects.filter(pk=self.source.pk).exists())
        self.assertEqual(MindmapContribution.objects.count(), 3)


class MindmapModerationFixRoundTests(MindmapModerationTestCase):
    """Final-review fixes of the moderation backend."""

    def test_merge_refused_when_nested_same_name_differs_in_hidden(self):
        for hidden_side in ("source", "target"):
            MindmapNode.objects.all().delete()
            source = self.contribute("S")
            target = self.contribute("T")
            rs = self.contribute("Rotor", parent=source)
            rt = self.contribute("Rotor", parent=target)
            MindmapNode.objects.filter(pk=rs if hidden_side == "source" else rt).update(
                hidden=True
            )
            before = self.shape()
            response = self.owner_mod("merge", source=source, target=target)
            self.assertEqual(response.status_code, 409, hidden_side)
            self.assertIn("hidden", response.json()["detail"])
            self.assertEqual(self.shape(), before)

    def test_merge_refused_for_deeper_nested_hidden_mismatch(self):
        source = self.contribute("S")
        target = self.contribute("T")
        bs = self.contribute("Blatt", parent=self.contribute("Rotor", parent=source))
        self.contribute("Blatt", parent=self.contribute("Rotor", parent=target))
        MindmapNode.objects.filter(pk=bs).update(hidden=True)
        self.assertEqual(self.owner_mod("merge", source=source, target=target).status_code, 409)

    def test_merge_allowed_when_nested_pair_both_hidden(self):
        source = self.contribute("S")
        target = self.contribute("T")
        rs = self.contribute("Rotor", parent=source)
        rt = self.contribute("Rotor", parent=target)
        MindmapNode.objects.filter(pk__in=[rs, rt]).update(hidden=True)
        self.assertEqual(self.owner_mod("merge", source=source, target=target).status_code, 200)

    def test_rename_clash_refused_when_nested_hidden_differs(self):
        for hidden_side in ("source", "target"):
            MindmapNode.objects.all().delete()
            a = self.contribute("Wnd")
            b = self.contribute("Wind")
            ra = self.contribute("Rotor", parent=a)
            rb = self.contribute("Rotor", parent=b)
            MindmapNode.objects.filter(pk=ra if hidden_side == "source" else rb).update(
                hidden=True
            )
            response = self.owner_mod("rename", node=a, text="Wind")
            self.assertEqual(response.status_code, 409, hidden_side)
            self.assertEqual(MindmapNode.objects.get(pk=a).text, "Wnd")

    def test_expired_undo_is_409(self):
        source = self.contribute("A")
        target = self.contribute("B")
        undo = self.owner_mod("merge", source=source, target=target).json()["undo"]
        later = timezone.now() + timezone.timedelta(hours=25)
        with patch("django.core.signing.time.time", return_value=later.timestamp()):
            response = self.owner_mod("unmerge", undo=undo)
        self.assertEqual(response.status_code, 409)
        self.assertIn("expired", response.json()["detail"])
        self.assertFalse(MindmapNode.objects.filter(pk=source).exists())

    def test_unmerge_after_move_creating_cycle_is_409(self):
        p = self.contribute("P")
        source = self.contribute("S", parent=p)
        target = self.contribute("T")
        child = self.contribute("C", parent=source)
        undo = self.owner_mod("merge", source=source, target=target).json()["undo"]
        # P now hangs below C (which came over from S): restoring S below P
        # and C below S would close a cycle P → C → S → P.
        self.assertEqual(self.owner_mod("move", node=p, parent=child).status_code, 200)
        before = self.shape()
        response = self.owner_mod("unmerge", undo=undo)
        self.assertEqual(response.status_code, 409)
        self.assertIn("changed", response.json()["detail"])
        self.assertEqual(self.shape(), before)
        self.assertFalse(MindmapNode.objects.filter(pk=source).exists())

    def test_add_matching_hidden_node_reports_hidden(self):
        node = self.contribute("Spam")
        MindmapNode.objects.filter(pk=node).update(hidden=True)
        response = self.owner_mod("add", parent=None, text="spam")
        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual((body["conflict"], body["hidden"]), (node, True))
        self.assertIn("detail", body)

    def test_hide_echoes_integer_node_id(self):
        node = self.contribute("A")
        response = self.owner_mod("hide", node=str(node), hidden=True)
        self.assertEqual(response.json()["node"], node)


# --- Mindmap rating phase ------------------------------------------------------


class MindmapRatingTestCase(MindmapModerationTestCase):
    """Rating phase: points (dot voting) or plus/minus within a budget."""

    def setUp(self):
        super().setUp()
        self.mq.mindmap_rating_mode = "points"
        self.mq.mindmap_rating_budget = 3
        self.mq.save()

    def configure(self, **fields):
        for key, value in fields.items():
            setattr(self.mq, key, value)
        self.mq.save()

    def stage(self, stage, run=None):
        return self.owner_mod("stage", run=run, stage=stage)

    def rate(self, token, node, question=None, **body):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/mindmap/rate/",
            {"token": token, "question": question or self.mq.pk, "node": node, **body},
            content_type="application/json",
        )

    def my_ratings(self, token, question=None):
        return self.client.post(
            f"/api/live/rooms/{self.room.code}/mindmap/my-ratings/",
            {"token": token, "question": question or self.mq.pk},
            content_type="application/json",
        )

    def start_rating(self):
        response = self.stage("rate")
        self.assertEqual(response.status_code, 200, response.content)
        self.client.logout()

    def set_phase(self, phase):
        self.run.phase = phase
        self.run.save()

    def rating_payload(self, role):
        return build_payloads(self.room)[role]["mindmap"].get("rating")

    def ratings(self):
        """{(node text, token key, value)} — exact-restore checks."""
        from .models import MindmapRating

        return {
            (r.node.text, r.token.key, r.value)
            for r in MindmapRating.objects.select_related("node", "token")
        }


class MindmapStageTests(MindmapRatingTestCase):
    def test_owner_switches_stage(self):
        response = self.stage("rate")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"stage": "rate", "phase": "open"})
        self.assertEqual(self.rating_payload("presenter")["stage"], "rate")
        self.assertEqual(self.rating_payload("participant")["stage"], "rate")
        response = self.stage("collect")
        self.assertEqual(response.json(), {"stage": "collect", "phase": "open"})
        self.assertEqual(self.rating_payload("presenter")["stage"], "collect")

    def test_default_stage_is_collect(self):
        self.assertEqual(self.rating_payload("presenter")["stage"], "collect")

    def test_non_owner_404_and_anonymous_refused(self):
        self.client.force_login(User.objects.create_user(username="eve"))
        self.assertEqual(self.mod("stage", stage="rate").status_code, 404)
        self.client.logout()
        self.assertIn(self.mod("stage", stage="rate").status_code, (401, 403))
        self.assertEqual(self.rating_payload("presenter")["stage"], "collect")

    def test_non_mindmap_question_404(self):
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/runs/{self.run.pk}/mindmap/{self.question.pk}/stage",
            {"stage": "rate"}, content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_invalid_stage_400(self):
        for bad in ("vote", "", None, 1):
            self.assertEqual(self.stage(bad).status_code, 400, bad)

    def test_rate_needs_a_rating_mode(self):
        self.configure(mindmap_rating_mode="")
        response = self.stage("rate")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.stage("collect").status_code, 200)

    def test_finished_run_refused(self):
        self.set_phase(Run.Phase.FINISHED)
        self.assertEqual(self.stage("rate").status_code, 409)

    def test_broadcasts(self):
        self.client.force_login(self.owner)
        with patch("live.views.broadcast") as bc:
            self.mod("stage", stage="rate")
        bc.assert_called_once()

    def test_add_and_remove_refused_while_rating(self):
        token = self.join()
        node = self.contribute("Wind", token=token)
        self.start_rating()
        response = self.add(token, "Solar")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Rating in progress — no new terms.")
        self.assertEqual(self.remove(token, node).status_code, 409)
        self.assertTrue(MindmapNode.objects.filter(pk=node).exists())
        self.stage("collect")
        self.assertEqual(self.add(token, "Solar").status_code, 201)

    def test_rating_mode_turned_off_means_collect(self):
        self.start_rating()
        self.configure(mindmap_rating_mode="")
        self.assertEqual(self.add(self.join(), "Solar").status_code, 201)
        self.assertNotIn("rating", build_payloads(self.room)["presenter"]["mindmap"])


class MindmapRatePointsTests(MindmapRatingTestCase):
    def setUp(self):
        super().setUp()
        self.token = self.join()
        self.wind = self.contribute("Wind", token=self.token)
        self.solar = self.contribute("Solar")
        self.start_rating()

    def test_points_add_up_within_budget(self):
        response = self.rate(self.token, self.wind, delta=1)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"node": self.wind, "value": 1, "remaining": 2})
        self.assertEqual(self.rate(self.token, self.wind, delta=1).json()["value"], 2)
        self.assertEqual(self.rate(self.token, self.solar, delta=1).json()["remaining"], 0)
        response = self.rate(self.token, self.solar, delta=1)
        self.assertEqual(response.status_code, 409)
        # Taking one back frees a point; at 0 the row is gone.
        self.assertEqual(
            self.rate(self.token, self.solar, delta=-1).json(),
            {"node": self.solar, "value": 0, "remaining": 1},
        )
        from .models import MindmapRating

        self.assertFalse(MindmapRating.objects.filter(node_id=self.solar).exists())

    def test_minus_at_zero_refused(self):
        response = self.rate(self.token, self.wind, delta=-1)
        self.assertEqual(response.status_code, 409)

    def test_single_point_per_entry(self):
        self.configure(mindmap_rating_multi=False)
        self.assertEqual(self.rate(self.token, self.wind, delta=1).status_code, 200)
        self.assertEqual(self.rate(self.token, self.wind, delta=1).status_code, 409)
        self.assertEqual(self.rate(self.token, self.solar, delta=1).status_code, 200)

    def test_strict_types(self):
        for body in ({"delta": "1"}, {"delta": True}, {"delta": 2}, {"delta": 0},
                     {"delta": 1.0},
                     {"value": 1}, {}):
            self.assertEqual(self.rate(self.token, self.wind, **body).status_code, 400, body)
        self.assertEqual(self.rate(self.token, str(self.wind), delta=1).status_code, 400)
        self.assertEqual(self.rate(self.token, None, delta=1).status_code, 400)

    def test_unknown_and_foreign_nodes(self):
        self.assertEqual(self.rate(self.token, 999999, delta=1).status_code, 404)
        other_run = Run.objects.create(
            question_set=QuestionSet.objects.create(room=self.room, title="Andere"),
            phase=Run.Phase.FINISHED,
        )
        foreign = MindmapNode.objects.create(
            run=other_run, question=self.mq, text="X", text_key="x"
        )
        self.assertEqual(self.rate(self.token, foreign.pk, delta=1).status_code, 404)

    def test_hidden_node_and_hidden_branch_refused(self):
        self.stage("collect")
        rotor = self.contribute("Rotor", parent=self.wind)
        self.start_rating()
        MindmapNode.objects.filter(pk=self.wind).update(hidden=True)
        self.assertEqual(self.rate(self.token, self.wind, delta=1).status_code, 404)
        self.assertEqual(self.rate(self.token, rotor, delta=1).status_code, 404)

    def test_needs_rating_stage_and_open_phase(self):
        self.stage("collect")
        self.assertEqual(self.rate(self.token, self.wind, delta=1).status_code, 409)
        self.start_rating()
        self.set_phase(Run.Phase.CLOSED)
        self.assertEqual(self.rate(self.token, self.wind, delta=1).status_code, 409)

    def test_unknown_token_and_wrong_question(self):
        self.assertEqual(self.rate("nope", self.wind, delta=1).status_code, 403)
        response = self.rate(self.token, self.wind, question=self.question.pk, delta=1)
        self.assertEqual(response.status_code, 409)

    def test_broadcasts(self):
        with patch("live.views.broadcast") as bc:
            self.rate(self.token, self.wind, delta=1)
        bc.assert_called_once()


class MindmapRateUpDownTests(MindmapRatingTestCase):
    def setUp(self):
        super().setUp()
        self.configure(mindmap_rating_mode="updown", mindmap_rating_budget=2)
        self.token = self.join()
        self.a = self.contribute("A", token=self.token)
        self.b = self.contribute("B")
        self.c = self.contribute("C")
        self.start_rating()

    def test_toggle_and_budget(self):
        self.assertEqual(
            self.rate(self.token, self.a, value=1).json(),
            {"node": self.a, "value": 1, "remaining": 1},
        )
        # Switching plus → minus costs nothing extra.
        self.assertEqual(
            self.rate(self.token, self.a, value=-1).json(),
            {"node": self.a, "value": -1, "remaining": 1},
        )
        self.assertEqual(self.rate(self.token, self.b, value=1).json()["remaining"], 0)
        self.assertEqual(self.rate(self.token, self.c, value=-1).status_code, 409)
        # Removing (value 0) frees one.
        self.assertEqual(
            self.rate(self.token, self.a, value=0).json(),
            {"node": self.a, "value": 0, "remaining": 1},
        )
        self.assertEqual(self.rate(self.token, self.c, value=-1).status_code, 200)

    def test_value_zero_without_rating_is_ok(self):
        self.assertEqual(
            self.rate(self.token, self.a, value=0).json(),
            {"node": self.a, "value": 0, "remaining": 2},
        )

    def test_strict_types(self):
        for body in ({"value": 2}, {"value": "1"}, {"value": True}, {"delta": 1},
                     {"value": 1.0},
                     {"value": None}):
            self.assertEqual(self.rate(self.token, self.a, **body).status_code, 400, body)


class MindmapMyRatingsTests(MindmapRatingTestCase):
    def test_own_ratings_only(self):
        t1, t2 = self.join(), self.join()
        wind = self.contribute("Wind", token=t1)
        solar = self.contribute("Solar", token=t2)
        self.start_rating()
        self.rate(t1, wind, delta=1)
        self.rate(t1, wind, delta=1)
        self.rate(t2, solar, delta=1)
        response = self.my_ratings(t1)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ratings": {str(wind): 2}, "remaining": 1})
        self.assertEqual(
            self.my_ratings(t2).json(), {"ratings": {str(solar): 1}, "remaining": 2}
        )

    def test_unknown_token_and_question(self):
        self.assertEqual(self.my_ratings("nope").status_code, 403)
        self.assertEqual(self.my_ratings(self.join(), question=999999).status_code, 404)

    def test_fresh_participant(self):
        self.assertEqual(
            self.my_ratings(self.join()).json(), {"ratings": {}, "remaining": 3}
        )


class MindmapRatingHiddenTests(MindmapRatingTestCase):
    def test_hidden_ratings_excluded_and_refunded(self):
        token = self.join()
        wind = self.contribute("Wind", token=token)
        solar = self.contribute("Solar")
        self.configure(mindmap_rating_live=True)
        self.start_rating()
        self.rate(token, wind, delta=1)
        self.rate(token, wind, delta=1)
        self.rate(token, solar, delta=1)
        self.owner_mod("hide", node=wind, hidden=True)
        self.client.logout()
        rating = self.rating_payload("presenter")
        self.assertEqual(rating["scores"], {str(solar): {"points": 1}})
        self.assertEqual(rating["raters"], 1)
        # Hidden ratings stay stored but give the points back.
        self.assertEqual(
            self.my_ratings(token).json(), {"ratings": {str(solar): 1}, "remaining": 2}
        )
        self.owner_mod("hide", node=wind, hidden=False)
        self.assertEqual(self.rating_payload("presenter")["scores"][str(wind)], {"points": 2})


class MindmapRatingMergeTests(MindmapRatingTestCase):
    def build(self):
        self.t1, self.t2, self.t3 = self.join(), self.join(), self.join()
        self.source = self.contribute("Windrad", token=self.t1)
        self.target = self.contribute("Windkraft", token=self.t2)
        self.configure(mindmap_rating_budget=10)
        self.start_rating()
        self.rate(self.t1, self.source, delta=1)  # t1: source only → moves
        for _ in range(2):
            self.rate(self.t2, self.source, delta=1)  # t2: both → combined
        self.rate(self.t2, self.target, delta=1)
        self.rate(self.t3, self.target, delta=1)  # t3: target only
        self.stage("collect")  # moderation is refused while rating

    def target_ratings(self):
        from .models import MindmapRating

        return dict(
            MindmapRating.objects.filter(node_id=self.target).values_list(
                "token__key", "value"
            )
        )

    def test_points_add_up(self):
        self.build()
        self.assertEqual(
            self.owner_mod("merge", source=self.source, target=self.target).status_code, 200
        )
        self.assertEqual(
            self.target_ratings(), {self.t1: 1, self.t2: 3, self.t3: 1}
        )

    def test_single_point_rule_caps_at_one(self):
        self.build()
        self.configure(mindmap_rating_multi=False)
        self.owner_mod("merge", source=self.source, target=self.target)
        self.assertEqual(self.target_ratings(), {self.t1: 1, self.t2: 1, self.t3: 1})

    def test_updown_keeps_target_vote(self):
        self.t1, self.t2 = self.join(), self.join()
        self.source = self.contribute("Windrad", token=self.t1)
        self.target = self.contribute("Windkraft", token=self.t2)
        self.configure(mindmap_rating_mode="updown")
        self.start_rating()
        self.rate(self.t1, self.source, value=-1)
        self.rate(self.t2, self.source, value=-1)
        self.rate(self.t2, self.target, value=1)
        self.stage("collect")
        self.owner_mod("merge", source=self.source, target=self.target)
        self.assertEqual(self.target_ratings(), {self.t1: -1, self.t2: 1})

    def test_unmerge_restores_ratings_exactly(self):
        self.build()
        before = self.ratings()
        undo = self.owner_mod("merge", source=self.source, target=self.target).json()["undo"]
        for token in (self.t1, self.t2, self.t3):
            self.assertNotIn(token, undo)
        self.assertNotEqual(self.ratings(), before)
        response = self.owner_mod("unmerge", undo=undo)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.ratings(), before)

    def test_unmerge_refused_when_combined_rating_changed(self):
        self.build()
        undo = self.owner_mod("merge", source=self.source, target=self.target).json()["undo"]
        self.start_rating()
        self.assertEqual(self.rate(self.t2, self.target, delta=-1).status_code, 200)
        self.stage("collect")
        response = self.owner_mod("unmerge", undo=undo)
        self.assertEqual(response.status_code, 409)

    def test_rename_merge_moves_ratings(self):
        self.build()
        response = self.owner_mod("rename", node=self.source, text="windkraft")
        self.assertTrue(response.json()["merged"])
        self.assertEqual(self.target_ratings()[self.t2], 3)


class MindmapRatingProtectionTests(MindmapRatingTestCase):
    def test_teacher_delete_refused_when_rated(self):
        node = self.owner_mod("add", parent=None, text="Wind").json()["node_id"]
        self.start_rating()
        self.rate(self.join(), node, delta=1)
        self.stage("collect")
        response = self.owner_mod("delete", node=node)
        self.assertEqual(response.status_code, 409)

    def test_withdraw_refused_when_rated(self):
        token = self.join()
        node = self.contribute("Wind", token=token)
        self.start_rating()
        self.rate(self.join(), node, delta=1)
        self.stage("collect")
        self.client.logout()
        self.assertEqual(self.remove(token, node).status_code, 409)
        self.assertTrue(MindmapNode.objects.filter(pk=node).exists())


class MindmapRatingPayloadTests(MindmapRatingTestCase):
    def rated(self, **settings):
        self.configure(**settings)
        self.t1, self.t2 = self.join(), self.join()
        self.wind = self.contribute("Wind", token=self.t1)
        self.solar = self.contribute("Solar", token=self.t2)
        self.start_rating()
        self.rate(self.t1, self.wind, **({"value": 1} if settings.get(
            "mindmap_rating_mode") == "updown" else {"delta": 1}))
        self.rate(self.t2, self.wind, **({"value": -1} if settings.get(
            "mindmap_rating_mode") == "updown" else {"delta": 1}))

    def test_no_rating_key_without_mode(self):
        self.configure(mindmap_rating_mode="")
        payloads = build_payloads(self.room)
        self.assertNotIn("rating", payloads["presenter"]["mindmap"])
        self.assertNotIn("rating", payloads["participant"]["mindmap"])

    def test_hidden_until_reveal(self):
        self.rated()
        presenter = self.rating_payload("presenter")
        self.assertEqual(
            presenter,
            {"mode": "points", "budget": 3, "multi": True, "live": False,
             "stage": "rate", "raters": 2},
        )
        participant = self.rating_payload("participant")
        self.assertEqual(
            participant,
            {"mode": "points", "budget": 3, "multi": True, "live": False, "stage": "rate"},
        )
        self.set_phase(Run.Phase.CLOSED)
        self.assertNotIn("scores", self.rating_payload("presenter"))
        # Reveal: the results phase shows the scores.
        self.set_phase(Run.Phase.RESULTS)
        self.assertEqual(
            self.rating_payload("presenter")["scores"], {str(self.wind): {"points": 2}}
        )
        self.assertEqual(
            self.rating_payload("participant")["totals"], {str(self.wind): {"points": 2}}
        )

    def test_results_hidden_from_participants_when_set_says_so(self):
        self.rated()
        self.question_set.show_results_to_participants = False
        self.question_set.save()
        self.set_phase(Run.Phase.RESULTS)
        self.assertNotIn("totals", self.rating_payload("participant"))
        self.assertIn("scores", self.rating_payload("presenter"))

    def test_live_display(self):
        self.rated(mindmap_rating_live=True)
        self.assertEqual(
            self.rating_payload("presenter")["scores"], {str(self.wind): {"points": 2}}
        )
        self.assertEqual(
            self.rating_payload("participant")["totals"], {str(self.wind): {"points": 2}}
        )

    def test_live_display_only_while_rating(self):
        self.rated(mindmap_rating_live=True)
        self.stage("collect")
        self.assertNotIn("scores", self.rating_payload("presenter"))
        self.assertNotIn("totals", self.rating_payload("participant"))

    def test_updown_scores(self):
        self.rated(mindmap_rating_mode="updown", mindmap_rating_live=True)
        self.assertEqual(
            self.rating_payload("presenter")["scores"],
            {str(self.wind): {"up": 1, "down": 1, "balance": 0}},
        )

    def test_no_tokens_in_payloads(self):
        self.rated(mindmap_rating_live=True)
        dumped = json.dumps(build_payloads(self.room))
        for token in (self.t1, self.t2):
            self.assertNotIn(token, dumped)


class MindmapRatingResultsTests(MindmapRatingTestCase):
    def build(self, mode="points"):
        self.configure(mindmap_rating_mode=mode, mindmap_rating_budget=5)
        self.t1, self.t2 = self.join(), self.join()
        self.wind = self.contribute("Wind", token=self.t1)
        self.rotor = self.contribute("Rotor", parent=self.wind, token=self.t2)
        self.solar = self.contribute("Solar", token=self.t2)
        self.contribute("Solar", token=self.t1)
        self.spam = self.contribute("=Spam")
        self.start_rating()
        if mode == "points":
            for _ in range(3):
                self.rate(self.t1, self.rotor, delta=1)
            self.rate(self.t1, self.solar, delta=1)
            self.rate(self.t2, self.wind, delta=1)
            self.rate(self.t2, self.spam, delta=1)
        else:
            self.rate(self.t1, self.rotor, value=1)
            self.rate(self.t2, self.rotor, value=1)
            self.rate(self.t1, self.solar, value=-1)
            self.rate(self.t2, self.wind, value=1)
        self.set_phase(Run.Phase.FINISHED)

    def item(self):
        self.client.force_login(self.owner)
        results = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        return next(q for q in results[0]["questions"] if q["kind"] == "mindmap")

    def test_run_results_scores_and_ranking(self):
        self.build()
        MindmapNode.objects.filter(pk=self.spam).update(hidden=True)
        rating = self.item()["mindmap"]["rating"]
        self.assertEqual(rating["mode"], "points")
        self.assertEqual(rating["raters"], 2)
        self.assertEqual(
            rating["scores"],
            {str(self.rotor): {"points": 3}, str(self.solar): {"points": 1},
             str(self.wind): {"points": 1}},
        )
        # Ties (Solar, Wind: 1 point) are broken by the count of contributions.
        self.assertEqual(
            [(r["id"], r["path"], r["points"]) for r in rating["ranking"]],
            [(self.rotor, "Wind > Rotor", 3), (self.solar, "Solar", 1),
             (self.wind, "Wind", 1)],
        )

    def test_updown_ranking_by_balance(self):
        self.build("updown")
        ranking = self.item()["mindmap"]["rating"]["ranking"]
        self.assertEqual(
            [(r["id"], r["up"], r["down"], r["balance"]) for r in ranking],
            [(self.rotor, 2, 0, 2), (self.wind, 1, 0, 1), (self.solar, 0, 1, -1)],
        )

    def test_csv_rating_column(self):
        self.build()
        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8-sig")
        lines = body.splitlines()
        self.assertTrue(lines[0].endswith(";prozent;bewertung;beschreibung;kategorie;zone;x;y;stapel"))
        self.assertIn(";Wind > Rotor;;1;;;;3", body)
        self.assertIn(";Solar;;2;;;;1", body)
        # Formula-injection guard for participant text stays in place.
        self.assertIn(";'=Spam;;1;;;;1", body)
        # Every row has the same number of columns.
        self.assertEqual({line.count(";") for line in lines}, {lines[0].count(";")})

    def test_csv_updown_format(self):
        self.build("updown")
        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8-sig")
        self.assertIn(";Wind > Rotor;;1;;;;'+2/−0 (2)", body)
        self.assertIn(";Solar;;2;;;;'+0/−1 (-1)", body)


class MindmapRatingFixRoundTests(MindmapRatingTestCase):
    def rated(self, **settings):
        self.configure(**settings)
        self.t1 = self.join()
        self.wind = self.contribute("Wind", token=self.t1)
        self.start_rating()
        self.assertEqual(self.rate(self.t1, self.wind, delta=1).status_code, 200)

    def results_rating(self):
        self.client.force_login(self.owner)
        results = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        item = next(q for q in results[0]["questions"] if q["kind"] == "mindmap")
        return item["mindmap"]["rating"]

    def csv(self):
        self.client.force_login(self.owner)
        return self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8-sig")

    def test_results_hide_scores_while_rating_hidden(self):
        self.rated()
        rating = self.results_rating()
        self.assertTrue(rating["rating_in_progress"])
        self.assertNotIn("scores", rating)
        self.assertNotIn("ranking", rating)
        self.assertEqual(rating["raters"], 1)
        self.assertIn(";Wind;;1;;;;;;;;;;\r\n", self.csv())
        # Reveal (results phase) or a finished run: scores again.
        self.set_phase(Run.Phase.RESULTS)
        rating = self.results_rating()
        self.assertNotIn("rating_in_progress", rating)
        self.assertEqual(rating["scores"], {str(self.wind): {"points": 1}})
        self.assertIn(";Wind;;1;;;;1", self.csv())

    def test_results_show_scores_while_rating_live(self):
        self.rated(mindmap_rating_live=True)
        rating = self.results_rating()
        self.assertNotIn("rating_in_progress", rating)
        self.assertIn("scores", rating)

    def test_moderation_refused_while_rating(self):
        a = self.contribute("A")
        b = self.contribute("B")
        undo = self.owner_mod("rename", node=b, text="Bee").json()["undo"]
        teacher = self.owner_mod("add", parent=None, text="T").json()["node_id"]
        self.start_rating()
        for op, body in (
            ("merge", {"source": a, "target": b}),
            ("move", {"node": a, "parent": b}),
            ("rename", {"node": a, "text": "X"}),
            ("add", {"parent": None, "text": "Neu"}),
            ("delete", {"node": teacher}),
            ("unmerge", {"undo": undo}),
        ):
            response = self.owner_mod(op, **body)
            self.assertEqual(response.status_code, 409, op)
            self.assertEqual(
                response.json()["detail"], "Not possible while rating is in progress.", op
            )
        self.assertEqual(self.owner_mod("hide", node=a, hidden=True).status_code, 200)
        self.assertEqual(self.owner_mod("hide", node=a, hidden=False).status_code, 200)
        self.stage("collect")
        self.assertEqual(self.owner_mod("rename", node=a, text="X").status_code, 200)

    def test_stage_with_open_opens_the_vote(self):
        self.set_phase(Run.Phase.CLOSED)
        self.run.answers_revealed = True
        self.run.opened_at = timezone.now() - timezone.timedelta(minutes=5)
        self.run.save()
        self.client.force_login(self.owner)
        with patch("live.views.broadcast") as bc:
            response = self.mod("stage", stage="rate", open=True)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"stage": "rate", "phase": "open"})
        bc.assert_called_once()
        self.run.refresh_from_db()
        self.assertEqual(self.run.phase, Run.Phase.OPEN)
        self.assertEqual(self.run.active_question, self.mq)
        self.assertFalse(self.run.answers_revealed)
        self.assertGreater(self.run.opened_at, timezone.now() - timezone.timedelta(seconds=5))
        payload = build_payloads(self.room)
        self.assertEqual(payload["presenter"]["phase"], "open")
        self.assertEqual(payload["presenter"]["mindmap"]["rating"]["stage"], "rate")

    def test_stage_open_must_be_bool_and_refusal_does_not_open(self):
        self.set_phase(Run.Phase.CLOSED)
        self.assertEqual(self.stage_open("rate", "yes").status_code, 400)
        self.configure(mindmap_rating_mode="")
        self.assertEqual(self.stage_open("rate", True).status_code, 409)
        self.run.refresh_from_db()
        self.assertEqual(self.run.phase, Run.Phase.CLOSED)

    def test_stage_without_open_keeps_phase(self):
        self.set_phase(Run.Phase.CLOSED)
        response = self.stage("rate")
        self.assertEqual(response.json(), {"stage": "rate", "phase": "closed"})

    def stage_open(self, stage, value):
        return self.owner_mod("stage", stage=stage, open=value)


class PresenterAwayTests(LiveTestCase):
    """✕/Esc in the presenter leaves without ending (spec PR 2): the run is
    marked ``presenter_away`` (participants see „paused"), an open vote is
    closed, and the flag clears on any other control or on (re)start."""

    def control(self, run, **data):
        return self.client.post(
            f"/api/runs/{run.pk}/control/", data, content_type="application/json"
        )

    def test_away_closes_open_vote_and_pauses_without_finishing(self):
        run = self.open_question()
        self.client.force_login(self.owner)
        response = self.control(run, away=True)
        self.assertEqual(response.status_code, 200)
        run.refresh_from_db()
        self.assertTrue(run.presenter_away)
        self.assertEqual(run.phase, Run.Phase.CLOSED)
        self.assertIsNone(run.ended_at)
        self.assertTrue(build_payloads(self.room)["participant"]["paused"])
        self.assertNotIn("paused", build_payloads(self.room)["presenter"])

    def test_away_keeps_non_open_phase(self):
        run = self.open_question()
        run.phase = Run.Phase.RESULTS
        run.save()
        self.client.force_login(self.owner)
        self.control(run, away=True)
        run.refresh_from_db()
        self.assertEqual(run.phase, Run.Phase.RESULTS)
        self.assertTrue(run.presenter_away)

    def test_other_control_clears_away(self):
        run = self.open_question()
        run.presenter_away = True
        run.phase = Run.Phase.CLOSED
        run.save()
        self.client.force_login(self.owner)
        self.control(run, phase="open")
        run.refresh_from_db()
        self.assertFalse(run.presenter_away)
        self.assertNotIn("paused", build_payloads(self.room)["participant"])
        run.presenter_away = True
        run.save()
        self.control(run, reveal=True)
        run.refresh_from_db()
        self.assertFalse(run.presenter_away)

    def test_start_run_clears_away(self):
        run = self.open_question()
        run.presenter_away = True
        run.save()
        self.client.force_login(self.owner)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "continue"},
            content_type="application/json",
        )
        self.assertEqual(response.json()["run"], run.pk)
        run.refresh_from_db()
        self.assertFalse(run.presenter_away)

    def test_finished_run_shows_no_paused(self):
        run = self.open_question()
        run.presenter_away = True
        run.save()
        self.client.force_login(self.owner)
        self.assertEqual(self.control(run, phase="finished").status_code, 200)
        participant = build_payloads(self.room)["participant"]
        self.assertEqual(participant["phase"], "finished")
        self.assertNotIn("paused", participant)
        # A finished run can't be marked away any more.
        self.assertEqual(self.control(run, away=True).status_code, 409)

    def test_away_is_owner_only(self):
        run = self.open_question()
        stranger = User.objects.create_user(username="mallory")
        self.client.force_login(stranger)
        self.assertEqual(self.control(run, away=True).status_code, 404)
        self.client.logout()
        self.assertIn(self.control(run, away=True).status_code, (401, 403))
        run.refresh_from_db()
        self.assertFalse(run.presenter_away)
        self.assertEqual(run.phase, Run.Phase.OPEN)

    def test_invalid_control_keeps_away(self):
        run = self.open_question()
        run.presenter_away = True
        run.phase = Run.Phase.CLOSED
        run.save()
        self.client.force_login(self.owner)
        self.assertEqual(self.control(run, phase="bogus").status_code, 400)
        self.assertEqual(self.control(run, away=False).status_code, 400)
        run.refresh_from_db()
        self.assertTrue(run.presenter_away)

    def live_status(self):
        return self.client.get(
            f"/api/question-sets/{self.question_set.pk}/live-status/"
        ).json()

    def test_live_status_in_use(self):
        self.client.force_login(self.owner)
        # Empty lobby run (e.g. prepared by "archive results"): not in use.
        run = Run.objects.create(question_set=self.question_set, phase=Run.Phase.LOBBY)
        status = self.live_status()
        self.assertEqual(status["active_run"], run.pk)
        self.assertEqual(status["active_run_phase"], "lobby")
        self.assertFalse(status["active_run_in_use"])
        # Left from the lobby: participants see „paused" → in use.
        self.control(run, away=True)
        self.assertTrue(self.live_status()["active_run_in_use"])
        # A question shown (past the lobby) → in use.
        run.presenter_away = False
        run.phase = Run.Phase.PREVIEW
        run.active_question = self.question
        run.save()
        self.assertTrue(self.live_status()["active_run_in_use"])
        run.phase = Run.Phase.FINISHED
        run.save()
        status = self.live_status()
        self.assertIsNone(status["active_run"])
        self.assertFalse(status["active_run_in_use"])

    def test_live_status_after_archive_not_in_use(self):
        token = self.join()
        run = self.open_question()
        self.vote(token, options=[self.correct.pk])
        self.client.force_login(self.owner)
        self.assertTrue(self.live_status()["active_run_in_use"])
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/archive-results/",
            {}, content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        status = self.live_status()
        self.assertNotEqual(status["active_run"], run.pk)
        self.assertFalse(status["active_run_in_use"])


class MatrixTestCase(LiveTestCase):
    def setUp(self):
        super().setUp()
        self.xq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.MATRIX,
            text="<p>Where?</p>", position=2,
        )
        self.run = self.open_question(self.xq)
        self.tok = ParticipantToken.objects.create(room=self.room)
        self.tok2 = ParticipantToken.objects.create(room=self.room)

    def configure(self, **fields):
        for key, value in fields.items():
            setattr(self.xq, key, value)
        self.xq.save()

    def add(self, token=None, zone="q1", title="Card", **kw):
        return mxs.add_card(self.run, self.xq, token or self.tok, zone, title, **kw)

    def stacked(self, top, *members):
        for m in members:
            mxs.stack_card(self.run, self.xq, m.pk, top.pk)
        for obj in (top, *members):
            obj.refresh_from_db()


class MatrixServiceTests(MatrixTestCase):
    def assertRefused(self, status, fn, *args, **kwargs):
        with self.assertRaises(MatrixError) as cm:
            fn(*args, **kwargs)
        self.assertEqual(cm.exception.status, status)
        return cm.exception

    def test_add_lands_in_zone_and_cards_spread(self):
        a, b = self.add(title="A"), self.add(title="B")
        self.assertEqual(zone_at(a.x, a.y, False), "q1")
        self.assertEqual(zone_at(b.x, b.y, False), "q1")
        self.assertNotEqual((a.x, a.y), (b.x, b.y))
        self.assertFalse(a.teacher)
        self.assertFalse(a.placed)

    def test_edge_zone_needs_edges(self):
        self.assertRefused(400, self.add, zone="e_top")
        self.configure(matrix_edges=True)
        card = self.add(zone="e_top")
        self.assertEqual(card.x, 0.0)
        self.assertGreater(card.y, 0)

    def test_category_rules(self):
        self.configure(matrix_category_mode="named", matrix_categories=[
            {"key": "blue", "name": {"de": "Idee", "en": "Idea"}},
            {"key": "red", "name": {"de": "Risiko", "en": "Risk"}},
        ])
        self.assertRefused(400, self.add)
        self.assertRefused(400, self.add, category="green")
        self.assertEqual(self.add(category="blue").category, "blue")
        self.configure(matrix_category_mode="off", matrix_categories=[])
        self.assertEqual(self.add(category="blue").category, "")

    def test_description_only_when_enabled(self):
        self.assertEqual(self.add(description="more").description, "")
        self.configure(matrix_descriptions=True)
        self.assertEqual(self.add(description=" more  text ").description, "more text")
        self.assertRefused(400, self.add, description="x" * 201)

    def test_title_validation(self):
        self.assertRefused(400, self.add, title="   ")
        self.assertRefused(400, self.add, title="x" * 61)
        self.assertEqual(len(self.add(title="x" * 60).title), 60)

    def test_limit_per_person(self):
        self.configure(matrix_max_per_person=2)
        self.add(title="1")
        self.add(title="2")
        error = self.assertRefused(409, self.add, title="3")
        self.assertEqual(error.detail, "Card limit reached.")
        self.add(token=self.tok2, title="other")  # others unaffected

    def test_remove_own_only(self):
        mine = self.add()
        foreign = self.add(token=self.tok2)
        self.assertRefused(404, mxs.remove_card, self.run, self.xq, self.tok, foreign.pk)
        mxs.remove_card(self.run, self.xq, self.tok, mine.pk)
        self.assertFalse(MatrixCard.objects.filter(pk=mine.pk).exists())

    def test_remove_top_promotes_oldest_member(self):
        top, m1, m2 = self.add(title="T"), self.add(title="M1"), self.add(title="M2")
        mxs.move_card(self.run, self.xq, top.pk, 0.6, 0.6)
        self.stacked(top, m1, m2)
        top.refresh_from_db()
        mxs.remove_card(self.run, self.xq, self.tok, top.pk)
        m1.refresh_from_db()
        m2.refresh_from_db()
        self.assertIsNone(m1.stack_id)
        self.assertEqual((m1.x, m1.y, m1.zone, m1.placed), (0.6, 0.6, "q1", True))
        self.assertEqual(m2.stack_id, m1.pk)

    def test_remove_member_of_pair_leaves_single(self):
        top, m = self.add(title="T"), self.add(title="M")
        self.stacked(top, m)
        mxs.remove_card(self.run, self.xq, self.tok, m.pk)
        top.refresh_from_db()
        self.assertIsNone(top.stack_id)
        self.assertFalse(top.members.exists())

    def test_move_clamps_and_changes_zone(self):
        card = self.add()
        moved = mxs.move_card(self.run, self.xq, card.pk, -0.05, 0.5)  # within hysteresis
        self.assertEqual(moved.zone, "q1")
        self.assertEqual(moved.x, 0.0)
        self.assertTrue(moved.placed)
        moved = mxs.move_card(self.run, self.xq, card.pk, -0.5, 0.5)
        self.assertEqual(moved.zone, "q2")
        self.assertEqual((moved.x, moved.y), (-0.5, 0.5))

    def test_move_member_moves_top(self):
        top, m = self.add(title="T"), self.add(title="M")
        self.stacked(top, m)
        result = mxs.move_card(self.run, self.xq, m.pk, -0.5, -0.5)
        self.assertEqual(result.pk, top.pk)
        top.refresh_from_db()
        m.refresh_from_db()
        self.assertEqual((top.x, top.y, top.zone), (-0.5, -0.5, "q3"))
        # Members carry the top's position (the top's values count).
        self.assertEqual((m.x, m.y, m.zone), (-0.5, -0.5, "q3"))

    def test_stack_and_stack_of_stack(self):
        a, b, c, d = (self.add(title=t) for t in "ABCD")
        self.stacked(c, d)
        self.assertEqual(mxs.stack_card(self.run, self.xq, a.pk, b.pk).pk, b.pk)
        a.refresh_from_db()
        self.assertEqual(a.stack_id, b.pk)
        mxs.stack_card(self.run, self.xq, c.pk, b.pk)
        for obj in (c, d):
            obj.refresh_from_db()
        self.assertEqual((c.stack_id, d.stack_id), (b.pk, b.pk))

    def test_stack_onto_own_stack_refused(self):
        a, b = self.add(title="A"), self.add(title="B")
        self.stacked(a, b)
        self.assertRefused(400, mxs.stack_card, self.run, self.xq, b.pk, a.pk)
        self.assertRefused(400, mxs.stack_card, self.run, self.xq, a.pk, a.pk)

    def test_stack_onto_hidden_card_refused(self):
        target, moving = self.add(title="Target"), self.add(title="Moving")
        mxs.set_hidden(self.run, self.xq, target.pk, True)
        with self.assertRaises(mxs.MatrixError) as ctx:
            mxs.stack_card(self.run, self.xq, moving.pk, target.pk)
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.detail, "Cannot stack onto a hidden card.")
        moving.refresh_from_db()
        self.assertIsNone(moving.stack_id)

    def test_free_slot_is_public(self):
        x, y = mxs.free_slot(self.run, self.xq, "q1")
        self.assertTrue(-1 <= x <= 1 and -1 <= y <= 1)

    def test_unstack_member(self):
        top, m = self.add(title="T"), self.add(title="M")
        self.stacked(top, m)
        result = mxs.unstack_card(self.run, self.xq, m.pk)
        self.assertIsNone(result.stack_id)
        self.assertEqual(result.zone, top.zone)
        self.assertNotEqual((result.x, result.y), (top.x, top.y))
        self.assertFalse(result.placed)

    def test_unstack_top_promotes_oldest(self):
        top, m1, m2 = self.add(title="T"), self.add(title="M1"), self.add(title="M2")
        self.stacked(top, m1, m2)
        result = mxs.unstack_card(self.run, self.xq, top.pk)
        self.assertIsNone(result.stack_id)
        self.assertFalse(result.members.exists())
        m1.refresh_from_db()
        m2.refresh_from_db()
        self.assertIsNone(m1.stack_id)
        self.assertEqual(m2.stack_id, m1.pk)
        self.assertNotEqual((result.x, result.y), (m1.x, m1.y))

    def test_unstack_single_refused(self):
        self.assertRefused(400, mxs.unstack_card, self.run, self.xq, self.add().pk)

    def test_hide_and_board_payload(self):
        a, b, c = self.add(title="A"), self.add(title="B"), self.add(title="C")
        self.stacked(a, b)
        mxs.set_hidden(self.run, self.xq, c.pk, True)
        full = mxs.board_payload(self.run, self.xq, presenter=True)
        self.assertEqual([x["title"] for x in full["cards"]], ["A", "B", "C"])
        self.assertTrue(full["cards"][2]["hidden"])
        self.assertEqual(full["cards"][1]["stack"], a.pk)
        self.assertIsNone(full["cards"][0]["stack"])
        self.assertEqual((full["count"], full["contributors"]), (2, 1))
        public = mxs.board_payload(self.run, self.xq, presenter=False)
        self.assertEqual([x["title"] for x in public["cards"]], ["A", "B"])
        mxs.set_hidden(self.run, self.xq, c.pk, False)
        self.assertEqual(mxs.board_payload(self.run, self.xq, presenter=False)["count"], 3)
        # hidden top drops its members; hidden member is just dropped
        mxs.set_hidden(self.run, self.xq, a.pk, True)
        self.assertEqual([x["title"] for x in mxs.board_payload(self.run, self.xq, False)["cards"]], ["C"])
        mxs.set_hidden(self.run, self.xq, a.pk, False)
        mxs.set_hidden(self.run, self.xq, b.pk, True)
        public = mxs.board_payload(self.run, self.xq, False)
        self.assertEqual([x["title"] for x in public["cards"]], ["A", "C"])

    def test_teacher_cards(self):
        self.configure(matrix_max_per_person=1)
        self.add()
        t1 = mxs.add_teacher_card(self.run, self.xq, "q2", "T1")
        t2 = mxs.add_teacher_card(self.run, self.xq, "q2", "T2")
        self.assertTrue(t1.teacher and t1.token_id is None)
        self.assertEqual(mxs.contributor_count(self.run, self.xq), 1)
        self.assertEqual(mxs.card_count(self.run, self.xq), 3)
        participant = MatrixCard.objects.get(token=self.tok)
        self.assertRefused(404, mxs.delete_teacher_card, self.run, self.xq, participant.pk)
        mxs.delete_teacher_card(self.run, self.xq, t2.pk)
        self.assertFalse(MatrixCard.objects.filter(pk=t2.pk).exists())
        self.run.phase = Run.Phase.FINISHED
        self.assertRefused(409, mxs.add_teacher_card, self.run, self.xq, "q2", "late")

    def test_mine_payload(self):
        mine = self.add(title="Mine")
        self.add(token=self.tok2, title="Theirs")
        self.assertEqual(mxs.own_card_ids(self.run, self.xq, self.tok), [mine.pk])
        self.assertEqual(
            mxs.mine_payload(self.run, self.xq, self.tok),
            [{"id": mine.pk, "title": "Mine", "description": "", "category": "", "zone": "q1"}],
        )

    def test_csv_rows(self):
        self.configure(matrix_category_mode="named", matrix_categories=[
            {"key": "blue", "name": {"de": "Idee", "en": "Idea"}},
            {"key": "red", "name": {"de": "Risiko", "en": "Risk"}},
        ])
        top = self.add(title="Top", category="blue")
        m = self.add(title="Member", category="red")
        self.stacked(top, m)
        rows = mxs.csv_rows(self.run, self.xq)
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            {k: rows[0][k] for k in ("title", "description", "category", "zone", "stack")},
            {"title": "Top", "description": "", "category": "Idee", "zone": "q1", "stack": ""},
        )
        self.assertRegex(rows[0]["x"], r"^-?\d\.\d\d$")
        self.assertEqual(rows[1]["category"], "Risiko")
        self.assertEqual(rows[1]["stack"], "Top")
        self.configure(matrix_category_mode="colors")
        self.assertEqual(mxs.csv_rows(self.run, self.xq)[0]["category"], "blue")
        self.configure(matrix_category_mode="off", matrix_categories=[])
        self.assertEqual(mxs.csv_rows(self.run, self.xq)[0]["category"], "")
        mxs.set_hidden(self.run, self.xq, top.pk, True)
        self.assertEqual(mxs.csv_rows(self.run, self.xq), [])


class MatrixAnsweredTests(MatrixTestCase):
    def test_participant_card_counts_teacher_card_does_not(self):
        self.assertFalse(Run.objects.filter(answered_runs_q(), pk=self.run.pk).exists())
        mxs.add_teacher_card(self.run, self.xq, "q1", "T")
        self.assertFalse(Run.objects.filter(answered_runs_q(), pk=self.run.pk).exists())
        from .mindmap import run_has_answers
        self.assertFalse(run_has_answers(self.run))
        mxs.add_card(self.run, self.xq, self.tok, "q1", "P")
        self.assertTrue(Run.objects.filter(answered_runs_q(), pk=self.run.pk).exists())
        self.assertTrue(run_has_answers(self.run))


class MatrixApiTests(MatrixTestCase):
    def base(self):
        return f"/api/live/rooms/{self.room.code}/matrix"

    def post(self, path, **body):
        return self.client.post(
            f"{self.base()}/{path}/", body, content_type="application/json"
        )

    def p_add(self, token=None, **kw):
        payload = {"token": (token or self.tok).key, "question": self.xq.pk,
                   "zone": "q1", "title": "Idea"}
        payload.update(kw)
        return self.post("add", **payload)

    def run_post(self, action, **body):
        return self.client.post(
            f"/api/runs/{self.run.pk}/matrix/{self.xq.pk}/{action}",
            body, content_type="application/json",
        )

    def test_participant_add_mine_remove(self):
        response = self.p_add(title="Idea")
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertEqual(body["mine"][0]["title"], "Idea")
        card = MatrixCard.objects.get(pk=body["card_id"])
        self.assertEqual(card.token, self.tok)
        mine = self.post("mine", token=self.tok.key, question=self.xq.pk)
        self.assertEqual(mine.status_code, 200)
        self.assertEqual([c["id"] for c in mine.json()["mine"]], [card.pk])
        removed = self.post(
            "remove", token=self.tok.key, question=self.xq.pk, card=card.pk
        )
        self.assertEqual(removed.status_code, 200)
        self.assertEqual(removed.json(), {"status": "ok", "mine": []})
        self.assertFalse(MatrixCard.objects.exists())

    def test_mine_works_after_close_and_is_token_scoped(self):
        self.add(self.tok, title="Mine")
        self.add(self.tok2, title="Other")
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        mine = self.post("mine", token=self.tok.key, question=self.xq.pk).json()["mine"]
        self.assertEqual([c["title"] for c in mine], ["Mine"])

    def test_add_refusals(self):
        self.assertEqual(self.p_add(question=self.question.pk).status_code, 409)
        self.assertEqual(self.p_add(token=ParticipantToken(key="nope")).status_code, 403)
        self.assertEqual(self.p_add(title="  ").status_code, 400)
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        self.assertEqual(self.p_add().status_code, 409)

    def test_kind_mismatch_is_400(self):
        self.run.active_question = self.question
        self.run.save()
        self.assertEqual(self.p_add(question=self.question.pk).status_code, 400)

    def test_remove_foreign_card_404(self):
        card = self.add(self.tok2)
        response = self.post(
            "remove", token=self.tok.key, question=self.xq.pk, card=card.pk
        )
        self.assertEqual(response.status_code, 404)

    def test_presenter_endpoints_return_board(self):
        a, b = self.add(title="A"), self.add(title="B")
        self.client.force_login(self.owner)
        with patch("live.views.broadcast") as bc:
            r = self.run_post("move", card=a.pk, x=0.5, y=0.5)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(bc.call_count, 1)
        by_id = {c["id"]: c for c in r.json()["matrix"]["cards"]}
        self.assertTrue(by_id[a.pk]["placed"])
        r = self.run_post("stack", card=a.pk, onto=b.pk)
        self.assertEqual(r.status_code, 200)
        by_id = {c["id"]: c for c in r.json()["matrix"]["cards"]}
        self.assertEqual(by_id[a.pk]["stack"], b.pk)
        r = self.run_post("unstack", card=a.pk)
        self.assertIsNone({c["id"]: c for c in r.json()["matrix"]["cards"]}[a.pk]["stack"])
        r = self.run_post("hide", card=b.pk, hidden=True)
        self.assertTrue({c["id"]: c for c in r.json()["matrix"]["cards"]}[b.pk]["hidden"])
        r = self.run_post("add", zone="q2", title="Teacher")
        self.assertEqual(r.status_code, 201, r.content)
        t = next(c for c in r.json()["matrix"]["cards"] if c["teacher"])
        r = self.run_post("delete", card=t["id"])
        self.assertEqual(r.status_code, 200)
        self.assertFalse(any(c["teacher"] for c in r.json()["matrix"]["cards"]))

    def test_presenter_invalid_input(self):
        a = self.add()
        self.client.force_login(self.owner)
        self.assertEqual(self.run_post("move", card=a.pk, x="abc", y=0).status_code, 400)
        self.assertEqual(self.run_post("move", card=a.pk, x=None, y=0).status_code, 400)
        self.assertEqual(self.run_post("hide", card=a.pk, hidden="yes").status_code, 400)
        self.assertEqual(self.run_post("hide", card=999999, hidden=True).status_code, 404)

    def test_presenter_permissions(self):
        a = self.add()
        self.assertIn(self.run_post("hide", card=a.pk, hidden=True).status_code, (401, 403))
        # a participant token is no authentication
        self.assertIn(
            self.run_post("hide", card=a.pk, hidden=True, token=self.tok.key).status_code,
            (401, 403),
        )
        self.client.force_login(User.objects.create_user(username="eve"))
        for action, body in (
            ("move", {"card": a.pk, "x": 0, "y": 0}), ("hide", {"card": a.pk, "hidden": True}),
            ("add", {"zone": "q1", "title": "x"}), ("delete", {"card": a.pk}),
            ("stack", {"card": a.pk, "onto": a.pk}), ("unstack", {"card": a.pk}),
        ):
            self.assertEqual(self.run_post(action, **body).status_code, 404, action)
        a.refresh_from_db()
        self.assertFalse(a.hidden)

    def test_wrong_kind_question_404(self):
        self.client.force_login(self.owner)
        r = self.client.post(
            f"/api/runs/{self.run.pk}/matrix/{self.question.pk}/add",
            {"zone": "q1", "title": "x"}, content_type="application/json",
        )
        self.assertEqual(r.status_code, 404)

    def test_finished_run_refuses_teacher_add(self):
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        self.client.force_login(self.owner)
        r = self.run_post("add", zone="q1", title="Late")
        self.assertEqual(r.status_code, 409)
        self.assertFalse(MatrixCard.objects.exists())

    def test_reopen_keeps_cards_positions_stacks(self):
        a, b = self.add(title="A"), self.add(title="B")
        self.client.force_login(self.owner)
        self.run_post("move", card=a.pk, x=0.6, y=0.7)
        self.run_post("stack", card=b.pk, onto=a.pk)
        before = {c["id"]: c for c in board(self).values()}
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        self.run.phase = Run.Phase.OPEN
        self.run.save()
        after = {c["id"]: c for c in board(self).values()}
        self.assertEqual(before, after)
        self.assertEqual(after[b.pk]["stack"], a.pk)


def board(case):
    return {c["id"]: c for c in build_payloads(case.room)["presenter"]["matrix"]["cards"]}


class MatrixFinalReviewTests(MatrixTestCase):
    """Whole-branch review fixes (PR 1)."""

    def test_stacked_card_reports_the_tops_zone_and_position(self):
        top, member = self.add(zone="q1", title="Top"), self.add(zone="q2", title="Member")
        self.stacked(top, member)
        mxs.move_card(self.run, self.xq, top.pk, -0.6, -0.6)  # into q3
        top.refresh_from_db()
        member.refresh_from_db()
        self.assertEqual((member.zone, member.x, member.y), (top.zone, top.x, top.y))
        self.assertEqual(top.zone, "q3")
        payload = {c["id"]: c for c in mxs.board_payload(self.run, self.xq, True)["cards"]}
        self.assertEqual(
            (payload[member.pk]["zone"], payload[member.pk]["x"], payload[member.pk]["y"]),
            (top.zone, top.x, top.y),
        )
        row = next(r for r in mxs.csv_rows(self.run, self.xq) if r["title"] == "Member")
        self.assertEqual(
            (row["zone"], row["x"], row["y"]), (top.zone, f"{top.x:.2f}", f"{top.y:.2f}")
        )

    def test_stacking_copies_target_position_onto_moving_stack(self):
        target = self.add(zone="q1", title="Target")
        moving, sub = self.add(zone="q2", title="Moving"), self.add(zone="q2", title="Sub")
        self.stacked(moving, sub)
        mxs.stack_card(self.run, self.xq, moving.pk, target.pk)
        for card in (moving, sub):
            card.refresh_from_db()
            self.assertEqual((card.zone, card.x, card.y), (target.zone, target.x, target.y))
            self.assertEqual(card.stack_id, target.pk)

    def test_card_cap_per_run_and_question(self):
        with patch.object(mxs, "MATRIX_MAX_CARDS", 2):
            self.configure(matrix_max_per_person=50)
            self.add(self.tok)
            mxs.add_teacher_card(self.run, self.xq, "q1", "T")
            with self.assertRaises(MatrixError) as cm:
                self.add(self.tok2)
            self.assertEqual((cm.exception.status, cm.exception.detail), (409, "Card limit reached."))
            with self.assertRaises(MatrixError) as cm:
                mxs.add_teacher_card(self.run, self.xq, "q1", "T2")
            self.assertEqual(cm.exception.status, 409)
            self.assertEqual(MatrixCard.objects.count(), 2)

    def test_hidden_top_stacked_onto_card_hides_its_members(self):
        target = self.add(title="Target")
        top, member = self.add(title="Top"), self.add(title="Member")
        self.stacked(top, member)
        mxs.set_hidden(self.run, self.xq, top.pk, True)
        mxs.stack_card(self.run, self.xq, top.pk, target.pk)
        member.refresh_from_db()
        self.assertTrue(member.hidden)
        visible = [c["title"] for c in mxs.board_payload(self.run, self.xq, False)["cards"]]
        self.assertEqual(visible, ["Target"])

    def test_promoted_member_of_hidden_top_stays_hidden(self):
        top, member = self.add(title="Top"), self.add(title="Member")
        self.stacked(top, member)
        mxs.set_hidden(self.run, self.xq, top.pk, True)
        mxs.unstack_card(self.run, self.xq, top.pk)  # promotes Member
        member.refresh_from_db()
        self.assertIsNone(member.stack_id)
        self.assertTrue(member.hidden)
        self.assertEqual(
            [c["title"] for c in mxs.board_payload(self.run, self.xq, False)["cards"]], []
        )

    def test_unstacked_member_of_hidden_top_stays_hidden(self):
        top, member = self.add(title="Top"), self.add(title="Member")
        self.stacked(top, member)
        mxs.set_hidden(self.run, self.xq, top.pk, True)
        mxs.unstack_card(self.run, self.xq, member.pk)
        member.refresh_from_db()
        self.assertTrue(member.hidden)

    def test_deleting_hidden_teacher_top_promotes_hidden_member(self):
        top = mxs.add_teacher_card(self.run, self.xq, "q1", "Top")
        member = self.add(title="Member")
        self.stacked(top, member)
        mxs.set_hidden(self.run, self.xq, top.pk, True)
        mxs.delete_teacher_card(self.run, self.xq, top.pk)
        member.refresh_from_db()
        self.assertTrue(member.hidden)


class MatrixPayloadTests(MatrixTestCase):
    def test_presenter_payload_has_cards_and_votes(self):
        self.add(self.tok, title="Secret card")
        self.add(self.tok2, title="Other card")
        presenter = build_payloads(self.room)["presenter"]
        self.assertEqual(len(presenter["matrix"]["cards"]), 2)
        self.assertEqual(presenter["votes"], 2)
        # One contract: ``matrix`` is the board, ``matrix_settings`` the settings.
        self.assertEqual(set(presenter["matrix"]), {"cards", "count", "contributors"})
        self.assertIn("axes", presenter["matrix_settings"])
        self.assertNotIn("cards", presenter["matrix_settings"])

    def test_participant_payload_has_settings_but_no_cards(self):
        self.configure(
            matrix_x_from_de="klein", matrix_x_from_en="small", matrix_edges=True,
            matrix_category_mode="named",
            matrix_categories=[{"key": "blue", "name": {"de": "Idee", "en": "Idea"}}],
        )
        self.add(self.tok2, title="Other participant card", category="blue")
        participant = build_payloads(self.room)["participant"]
        self.assertNotIn("matrix", participant)
        m = participant["matrix_settings"]
        self.assertIn("e_top", m["zones"])
        self.assertTrue(m["edges"])
        self.assertEqual(m["axes"]["x_from"]["en"], "small")
        self.assertEqual(m["axes"]["x_from"]["de"], "klein")
        self.assertEqual(m["categories"][0]["name"]["en"], "Idea")
        for key in ("max_per_person", "category_mode", "descriptions"):
            self.assertIn(key, m)
        self.assertNotIn("cards", m)
        self.assertNotIn("Other participant card", json.dumps(participant))

    def test_participant_payload_stays_after_close(self):
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        self.assertIn("matrix_settings", build_payloads(self.room)["participant"])


class MatrixResultsTests(MatrixTestCase):
    def test_results_include_board_and_settings(self):
        self.add(title="Visible")
        hidden = self.add(title="Hidden one")
        mxs.set_hidden(self.run, self.xq, hidden.pk, True)
        self.client.force_login(self.owner)
        data = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        item = next(q for r in data for q in r["questions"] if q["kind"] == "matrix")
        # The owner's results mark hidden cards instead of dropping them.
        flags = {c["title"]: c["hidden"] for c in item["matrix"]["cards"]}
        self.assertEqual(flags, {"Visible": False, "Hidden one": True})
        self.assertEqual(item["matrix"]["count"], 1)
        self.assertIn("x", item["matrix"]["cards"][0])
        self.assertIn("axes", item["matrix_settings"])
        self.assertEqual(item["votes"], 1)

    def _item(self):
        self.client.force_login(self.owner)
        data = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        run = next(r for r in data if any(q["kind"] == "matrix" for q in r["questions"]))
        return run, next(q for q in run["questions"] if q["kind"] == "matrix")

    def test_votes_total_counts_participant_cards(self):
        self.add(title="One")
        self.add(token=self.tok2, title="Two")
        mxs.add_teacher_card(self.run, self.xq, "q2", "Teacher")
        run, _ = self._item()
        # Participant cards count; the teacher's own card does not.
        self.assertEqual(run["votes_total"], 2)

    def test_count_excludes_members_of_a_hidden_top(self):
        top = self.add(title="Top")
        member = self.add(token=self.tok2, title="Member")
        self.stacked(top, member)
        self.assertEqual(self._item()[1]["matrix"]["count"], 2)
        mxs.set_hidden(self.run, self.xq, top.pk, True)
        _, item = self._item()
        self.assertEqual(item["matrix"]["count"], 0)
        # Hidden cards stay in the owner's payload, flagged.
        self.assertEqual(len(item["matrix"]["cards"]), 2)

    def test_csv_columns_align_with_header(self):
        import csv
        import io
        top = self.add(title="=Top card", description="")
        member = self.add(title="Member")
        self.stacked(top, member)
        hidden = self.add(title="Hidden card")
        mxs.set_hidden(self.run, self.xq, hidden.pk, True)
        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(body), delimiter=";"))
        header = rows[0]
        self.assertEqual(header[-6:], ["beschreibung", "kategorie", "zone", "x", "y", "stapel"])
        for row in rows[1:]:
            self.assertEqual(len(row), len(header), row)
        cards = [dict(zip(header, r, strict=True)) for r in rows[1:] if r[3] == "Where?"]
        self.assertEqual(len(cards), 2)
        by_title = {c["antwort"]: c for c in cards}
        self.assertNotIn("Hidden card", by_title)
        self.assertEqual(by_title["'=Top card"]["stapel"], "")
        self.assertEqual(by_title["Member"]["stapel"], "'=Top card")
        self.assertEqual(by_title["Member"]["stimmen"], "1")
        self.assertEqual(by_title["Member"]["zone"], "q1")
        self.assertRegex(by_title["Member"]["x"], r"^-?\d\.\d\d$")

    def test_vote_endpoint_refuses_matrix(self):
        r = self.vote(self.tok.key, question=self.xq.pk, text="x")
        self.assertEqual(r.status_code, 400)


class MatrixRatingServiceTests(MatrixTestCase):
    """Rating stage of the matrix (Task 1): budgets, locks, counting rules."""

    def setUp(self):
        super().setUp()
        from . import matrix_rating as mr

        self.mr = mr
        self.configure(matrix_rating_mode="points", matrix_rating_budget=3)
        self.a = self.add(title="A")
        self.b = self.add(title="B", zone="q2")
        self.c = self.add(title="C", zone="q3")

    def rate_stage(self):
        self.mr.set_stage(self.run, self.xq, "rate")

    def refused(self, status, fn, *args, **kwargs):
        with self.assertRaises(MatrixError) as cm:
            fn(*args, **kwargs)
        self.assertEqual(cm.exception.status, status)
        return cm.exception

    def rate(self, card, token=None, **kw):
        return self.mr.rate(self.run, self.xq, token or self.tok, card.pk, **kw)

    # -- stage
    def test_stage_default_collect_and_switch(self):
        self.assertEqual(self.mr.stage_of(self.run, self.xq), "collect")
        self.assertFalse(mxs.is_rating(self.run, self.xq))
        self.rate_stage()
        self.assertEqual(self.mr.stage_of(self.run, self.xq), "rate")
        self.assertTrue(mxs.is_rating(self.run, self.xq))
        self.mr.set_stage(self.run, self.xq, "collect")
        self.assertEqual(self.mr.stage_of(self.run, self.xq), "collect")
        self.refused(400, self.mr.set_stage, self.run, self.xq, "bogus")

    def test_stage_needs_mode_and_active_run(self):
        self.configure(matrix_rating_mode="")
        self.refused(409, self.mr.set_stage, self.run, self.xq, "rate")
        self.assertEqual(self.mr.stage_of(self.run, self.xq), "collect")
        self.configure(matrix_rating_mode="points")
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        self.refused(409, self.mr.set_stage, self.run, self.xq, "rate")

    def test_open_vote_opens_question(self):
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        self.mr.set_stage(self.run, self.xq, "rate", open_vote=True)
        self.run.refresh_from_db()
        self.assertEqual(self.run.phase, Run.Phase.OPEN)
        self.assertEqual(self.run.active_question_id, self.xq.pk)

    # -- points
    def test_rating_needs_rate_stage(self):
        self.refused(409, self.rate, self.a, delta=1)

    def test_points_budget_multi(self):
        self.rate_stage()
        self.assertEqual(self.rate(self.a, delta=1), (1, 2))
        self.assertEqual(self.rate(self.a, delta=1), (2, 1))
        self.assertEqual(self.rate(self.b, delta=1), (1, 0))
        self.refused(409, self.rate, self.c, delta=1)
        self.assertEqual(self.rate(self.a, delta=-1), (1, 1))
        self.refused(409, self.rate, self.c, delta=-1)  # nothing to take back
        # Another participant has their own budget.
        self.assertEqual(self.rate(self.a, self.tok2, delta=1), (1, 2))

    def test_points_multi_off_one_per_card(self):
        self.configure(matrix_rating_multi=False)
        self.rate_stage()
        self.assertEqual(self.rate(self.a, delta=1), (1, 2))
        self.refused(409, self.rate, self.a, delta=1)
        self.assertEqual(self.rate(self.a, delta=-1), (0, 3))
        self.assertEqual(self.mr.my_ratings(self.run, self.xq, self.tok)["ratings"], {})

    # -- updown
    def test_updown_budget_counts_rated_cards(self):
        self.configure(matrix_rating_mode="updown", matrix_rating_budget=2)
        self.rate_stage()
        self.assertEqual(self.rate(self.a, value=1), (1, 1))
        self.assertEqual(self.rate(self.a, value=-1), (-1, 1))  # switching is free
        self.assertEqual(self.rate(self.b, value=-1), (-1, 0))
        self.refused(409, self.rate, self.c, value=1)
        self.assertEqual(self.rate(self.b, value=0), (0, 1))
        self.assertEqual(self.rate(self.c, value=1), (1, 0))

    # -- which cards are rateable
    def test_member_and_hidden_cards_refused(self):
        self.stacked(self.a, self.b)
        self.rate_stage()
        self.refused(404, self.rate, self.b, delta=1)
        mxs.set_hidden(self.run, self.xq, self.c.pk, True)
        self.refused(404, self.rate, self.c, delta=1)
        self.refused(404, self.mr.rate, self.run, self.xq, self.tok, 999999, delta=1)
        self.assertEqual(self.rate(self.a, delta=1), (1, 2))

    def test_hiding_returns_points(self):
        self.rate_stage()
        self.rate(self.a, delta=1)
        self.rate(self.a, delta=1)
        self.assertEqual(self.mr.my_ratings(self.run, self.xq, self.tok)["remaining"], 1)
        mxs.set_hidden(self.run, self.xq, self.a.pk, True)
        mine = self.mr.my_ratings(self.run, self.xq, self.tok)
        self.assertEqual(mine["remaining"], 3)
        self.assertEqual(mine["ratings"], {})
        self.assertEqual(self.mr.aggregate(self.run, self.xq), ({}, 0))
        mxs.set_hidden(self.run, self.xq, self.a.pk, False)
        self.assertEqual(self.mr.my_ratings(self.run, self.xq, self.tok)["remaining"], 1)

    def test_members_not_counted_and_counted_again_after_unstack(self):
        self.rate_stage()
        self.rate(self.b, delta=1)
        self.rate(self.b, self.tok2, delta=1)
        self.mr.set_stage(self.run, self.xq, "collect")
        self.stacked(self.a, self.b)
        self.rate_stage()
        self.assertEqual(self.mr.aggregate(self.run, self.xq), ({}, 0))
        self.assertEqual(self.mr.my_ratings(self.run, self.xq, self.tok)["remaining"], 3)
        self.mr.set_stage(self.run, self.xq, "collect")
        mxs.unstack_card(self.run, self.xq, self.b.pk)
        scores, raters = self.mr.aggregate(self.run, self.xq)
        self.assertEqual(scores, {str(self.b.pk): {"points": 2}})
        self.assertEqual(raters, 2)

    def test_back_to_collect_keeps_ratings(self):
        self.rate_stage()
        self.rate(self.a, delta=1)
        self.mr.set_stage(self.run, self.xq, "collect")
        self.rate_stage()
        self.assertEqual(
            self.mr.my_ratings(self.run, self.xq, self.tok),
            {"ratings": {str(self.a.pk): 1}, "remaining": 2, "budget": 3, "mode": "points"},
        )

    def test_over_budget_after_unhide(self):
        self.rate_stage()
        self.rate(self.a, delta=1)
        self.rate(self.b, delta=1)
        mxs.set_hidden(self.run, self.xq, self.a.pk, True)
        self.rate(self.c, delta=1)
        self.rate(self.c, delta=1)
        mxs.set_hidden(self.run, self.xq, self.a.pk, False)
        mine = self.mr.my_ratings(self.run, self.xq, self.tok)
        self.assertEqual(mine["remaining"], 0)
        self.refused(409, self.rate, self.b, delta=1)
        self.assertEqual(self.rate(self.a, delta=-1), (0, 0))  # still over budget

    def test_over_budget_updown_sign_switch_allowed(self):
        d = self.add(title="D", zone="q4")
        self.configure(matrix_rating_mode="updown", matrix_rating_budget=2)
        self.rate_stage()
        self.rate(self.a, value=1)
        self.rate(self.b, value=1)
        mxs.set_hidden(self.run, self.xq, self.a.pk, True)
        self.rate(self.c, value=1)
        mxs.set_hidden(self.run, self.xq, self.a.pk, False)
        self.assertEqual(self.mr.my_ratings(self.run, self.xq, self.tok)["remaining"], 0)
        # a new rating is refused, a sign switch is not
        self.refused(409, self.rate, d, value=1)
        self.assertEqual(self.rate(self.b, value=-1), (-1, 0))

    # -- locks
    def test_locks_while_rating(self):
        teacher = mxs.add_teacher_card(self.run, self.xq, "q4", "T")
        self.rate_stage()
        e = self.refused(409, mxs.add_card, self.run, self.xq, self.tok2, "q1", "New")
        self.assertEqual(e.detail, "Collecting is paused while rating.")
        self.refused(409, mxs.remove_card, self.run, self.xq, self.tok, self.a.pk)
        e = self.refused(409, mxs.stack_card, self.run, self.xq, self.b.pk, self.a.pk)
        self.assertEqual(e.detail, "Stacks are locked while rating.")
        self.refused(409, mxs.unstack_card, self.run, self.xq, self.a.pk)
        self.refused(409, mxs.delete_teacher_card, self.run, self.xq, teacher.pk)
        # Moving, hiding and the teacher's own new cards stay possible.
        mxs.add_teacher_card(self.run, self.xq, "q2", "T2")
        mxs.move_card(self.run, self.xq, self.a.pk, 0.5, 0.5)
        mxs.set_hidden(self.run, self.xq, self.a.pk, True)
        # Back in collect everything works again.
        self.mr.set_stage(self.run, self.xq, "collect")
        mxs.delete_teacher_card(self.run, self.xq, teacher.pk)
        mxs.add_card(self.run, self.xq, self.tok2, "q1", "New")

    # -- visibility of scores
    def test_scores_hidden_vs_live_vs_results(self):
        self.rate_stage()
        self.rate(self.a, delta=2)
        self.assertTrue(self.mr.scores_hidden(self.run, self.xq))
        pres = self.mr.payload(self.run, self.xq, presenter=True)
        self.assertEqual((pres["stage"], pres["raters"]), ("rate", 1))
        self.assertNotIn("scores", pres)
        self.assertNotIn("totals", self.mr.payload(self.run, self.xq, presenter=False))
        res = self.mr.results(self.run, self.xq, mxs.board_payload(self.run, self.xq, False))
        self.assertTrue(res["rating_in_progress"])
        self.assertNotIn("ranking", res)
        # live
        self.configure(matrix_rating_live=True)
        self.assertFalse(self.mr.scores_hidden(self.run, self.xq))
        self.assertEqual(
            self.mr.payload(self.run, self.xq, presenter=True)["scores"],
            {str(self.a.pk): {"points": 2}},
        )
        self.assertIn("totals", self.mr.payload(self.run, self.xq, presenter=False))
        # results phase reveals (participants only if the set shows results)
        self.configure(matrix_rating_live=False)
        self.run.phase = Run.Phase.RESULTS
        self.run.save()
        self.assertFalse(self.mr.scores_hidden(self.run, self.xq))
        self.assertIn("scores", self.mr.payload(self.run, self.xq, presenter=True))
        self.question_set.show_results_to_participants = False
        self.question_set.save()
        self.run.refresh_from_db()
        self.assertNotIn("totals", self.mr.payload(self.run, self.xq, presenter=False))
        self.question_set.show_results_to_participants = True
        self.question_set.save()
        self.run.refresh_from_db()
        self.assertIn("totals", self.mr.payload(self.run, self.xq, presenter=False))

    def test_no_mode_no_payload(self):
        self.configure(matrix_rating_mode="")
        self.assertIsNone(self.mr.payload(self.run, self.xq, presenter=True))
        self.assertIsNone(self.mr.results(self.run, self.xq, mxs.board_payload(self.run, self.xq, False)))
        self.assertEqual(self.mr.csv_cell(self.xq, {}, self.a.pk), "")

    # -- ranking & csv
    def test_ranking_points_and_csv_cell(self):
        self.configure(matrix_rating_live=True)
        self.rate_stage()
        self.rate(self.a, delta=1)
        self.rate(self.b, delta=1)
        self.rate(self.b, delta=1)
        self.rate(self.b, self.tok2, delta=1)
        scores, raters = self.mr.aggregate(self.run, self.xq)
        self.assertEqual(raters, 2)
        res = self.mr.results(self.run, self.xq, mxs.board_payload(self.run, self.xq, False))
        self.assertEqual([r["title"] for r in res["ranking"]], ["B", "A"])
        self.assertEqual(res["ranking"][0]["points"], 3)
        self.assertEqual(res["ranking"][0]["zone"], "q2")
        self.assertEqual(res["raters"], 2)
        self.assertEqual(self.mr.csv_cell(self.xq, scores, self.b.pk), 3)
        self.assertEqual(self.mr.csv_cell(self.xq, scores, self.c.pk), 0)

    def test_ranking_updown_and_csv_cell(self):
        self.configure(matrix_rating_mode="updown", matrix_rating_budget=3,
                       matrix_rating_live=True)
        self.rate_stage()
        self.rate(self.a, value=1)
        self.rate(self.a, self.tok2, value=-1)
        self.rate(self.b, value=1)
        self.rate(self.c, value=-1)
        scores, _ = self.mr.aggregate(self.run, self.xq)
        res = self.mr.results(self.run, self.xq, mxs.board_payload(self.run, self.xq, False))
        self.assertEqual([r["title"] for r in res["ranking"]], ["B", "A", "C"])
        self.assertEqual(self.mr.csv_cell(self.xq, scores, self.a.pk), "+1/−1 (0)")
        self.assertEqual(self.mr.csv_cell(self.xq, scores, self.b.pk), "+1/−0 (1)")
        self.assertEqual(self.mr.csv_cell(self.xq, scores, 0), "+0/−0 (0)")


class MatrixRatingApiTests(MatrixTestCase):
    def setUp(self):
        super().setUp()
        from . import matrix_rating as mr

        self.mr = mr
        self.configure(matrix_rating_mode="points", matrix_rating_budget=3)
        self.a = self.add(title="A", description="da", zone="q1")
        self.b = self.add(title="B", zone="q2", token=self.tok2)
        self.hid = self.add(title="Hid", zone="q3")
        mxs.set_hidden(self.run, self.xq, self.hid.pk, True)

    def base(self):
        return f"/api/live/rooms/{self.room.code}/matrix"

    def post(self, path, **body):
        return self.client.post(
            f"{self.base()}/{path}/", body, content_type="application/json"
        )

    def p_rate(self, card, token=None, **kw):
        return self.post(
            "rate", token=(token or self.tok).key, question=self.xq.pk, card=card.pk, **kw
        )

    def stage(self, stage, **kw):
        self.client.force_login(self.owner)
        return self.client.post(
            f"/api/runs/{self.run.pk}/matrix/{self.xq.pk}/stage",
            {"stage": stage, **kw}, content_type="application/json",
        )

    def payloads(self):
        return build_payloads(self.room)

    # -- stage endpoint
    def test_stage_endpoint(self):
        r = self.stage("rate")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"stage": "rate", "phase": "open"})
        self.assertTrue(mxs.is_rating(self.run, self.xq))
        self.assertEqual(self.stage("collect").json()["stage"], "collect")

    def test_stage_open_flag_opens_vote(self):
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        r = self.stage("rate", open=True)
        self.assertEqual(r.json(), {"stage": "rate", "phase": "open"})

    def test_stage_refusals(self):
        self.assertEqual(self.stage("bogus").status_code, 400)
        self.assertEqual(self.stage("rate", open="yes").status_code, 400)
        self.assertEqual(self.stage(3).status_code, 400)
        self.configure(matrix_rating_mode="")
        self.assertEqual(self.stage("rate").status_code, 409)

    def test_stage_permissions(self):
        url = f"/api/runs/{self.run.pk}/matrix/{self.xq.pk}/stage"
        body = {"stage": "rate"}
        self.assertIn(
            self.client.post(url, body, content_type="application/json").status_code,
            (401, 403),
        )
        self.client.force_login(User.objects.create_user(username="eve"))
        self.assertEqual(
            self.client.post(url, body, content_type="application/json").status_code, 404
        )
        self.assertFalse(mxs.is_rating(self.run, self.xq))
        self.client.force_login(self.owner)
        r = self.client.post(
            f"/api/runs/{self.run.pk}/matrix/{self.question.pk}/stage",
            body, content_type="application/json",
        )
        self.assertEqual(r.status_code, 404)

    # -- rate endpoint
    def test_rate_points(self):
        self.stage("rate")
        r = self.p_rate(self.a, delta=1)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"card": self.a.pk, "value": 1, "remaining": 2})
        self.assertEqual(self.p_rate(self.a, delta=1).json()["value"], 2)
        self.assertEqual(self.p_rate(self.a, delta=-1).json()["remaining"], 2)

    def test_rate_updown(self):
        self.configure(matrix_rating_mode="updown", matrix_rating_budget=2)
        self.stage("rate")
        r = self.p_rate(self.a, value=-1)
        self.assertEqual(r.json(), {"card": self.a.pk, "value": -1, "remaining": 1})
        self.assertEqual(self.p_rate(self.a, value=0).json()["remaining"], 2)

    def test_rate_409_when_not_rating_or_closed(self):
        self.assertEqual(self.p_rate(self.a, delta=1).status_code, 409)
        self.stage("rate")
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        self.assertEqual(self.p_rate(self.a, delta=1).status_code, 409)
        self.run.phase = Run.Phase.OPEN
        self.run.save()
        self.assertEqual(self.p_rate(self.a, delta=1).status_code, 200)

    def test_rate_refusals(self):
        self.stage("rate")
        self.assertEqual(self.p_rate(self.a, delta=2).status_code, 400)
        self.assertEqual(self.p_rate(self.a, delta=True).status_code, 400)
        self.assertEqual(self.p_rate(self.a).status_code, 400)
        self.assertEqual(self.p_rate(self.a, token=ParticipantToken(key="nope"), delta=1).status_code, 403)
        self.assertEqual(self.p_rate(self.hid, delta=1).status_code, 404)
        r = self.post("rate", token=self.tok.key, question=self.xq.pk, card="x", delta=1)
        self.assertEqual(r.status_code, 400)
        r = self.post("rate", token=self.tok.key, question=self.question.pk, card=self.a.pk, delta=1)
        self.assertEqual(r.status_code, 409)

    def test_rate_budget_errors(self):
        self.configure(matrix_rating_budget=1)
        self.stage("rate")
        self.assertEqual(self.p_rate(self.a, delta=1).status_code, 200)
        r = self.p_rate(self.b, delta=1)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "No points left.")
        self.assertEqual(self.p_rate(self.b, delta=-1).status_code, 409)

    def test_updown_refuses_delta(self):
        self.configure(matrix_rating_mode="updown")
        self.stage("rate")
        self.assertEqual(self.p_rate(self.a, delta=1).status_code, 400)

    def test_participant_add_409_while_rating(self):
        self.stage("rate")
        r = self.post("add", token=self.tok.key, question=self.xq.pk, zone="q1", title="X")
        self.assertEqual(r.status_code, 409)

    # -- my-ratings
    def test_my_ratings_token_scoped(self):
        self.stage("rate")
        self.p_rate(self.a, delta=1)
        self.p_rate(self.a, token=self.tok2, delta=1)
        self.p_rate(self.b, token=self.tok2, delta=1)
        r = self.post("my-ratings", token=self.tok.key, question=self.xq.pk)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json(),
            {"ratings": {str(self.a.pk): 1}, "remaining": 2, "budget": 3, "mode": "points"},
        )
        self.assertEqual(
            self.post("my-ratings", token="nope", question=self.xq.pk).status_code, 403
        )
        self.assertEqual(
            self.post("my-ratings", token=self.tok.key, question=self.question.pk).status_code, 404
        )


class MatrixRatingPayloadTests(MatrixTestCase):
    def setUp(self):
        super().setUp()
        from . import matrix_rating as mr

        self.mr = mr
        self.configure(matrix_rating_mode="points", matrix_rating_budget=3)
        self.a = self.add(title="A", zone="q2")
        self.b = self.add(title="B", zone="q1", description="desc B")
        self.c = self.add(title="C", zone="q1", token=self.tok2)
        mxs.move_card(self.run, self.xq, self.c.pk, 0.9, 0.9)
        self.hid = self.add(title="Hid", zone="q3")
        mxs.set_hidden(self.run, self.xq, self.hid.pk, True)
        self.mem = self.add(title="Member", zone="q2")
        self.stacked(self.a, self.mem)

    def rate_stage(self):
        self.mr.set_stage(self.run, self.xq, "rate")

    def part(self):
        return build_payloads(self.room)["participant"].get("matrix_rating")

    def pres(self):
        return build_payloads(self.room)["presenter"]["matrix"].get("rating")

    def test_no_mode_no_keys(self):
        self.configure(matrix_rating_mode="")
        self.assertIsNone(self.part())
        self.assertIsNone(self.pres())

    def test_collect_stage_minimal(self):
        self.assertEqual(self.part(), {"stage": "collect"})
        self.assertEqual(self.pres()["stage"], "collect")

    def test_participant_cards_privacy_and_order(self):
        self.rate_stage()
        rating = self.part()
        self.assertEqual(
            (rating["stage"], rating["mode"], rating["budget"], rating["multi"]),
            ("rate", "points", 3, True),
        )
        # q1 before q2; inside a zone y desc (C was moved up), then x asc.
        self.assertEqual([c["title"] for c in rating["cards"]], ["C", "B", "A"])
        for card in rating["cards"]:
            self.assertEqual(
                set(card), {"id", "title", "description", "category", "zone", "summary"}
            )
        text = json.dumps(build_payloads(self.room)["participant"])
        self.assertNotIn("Hid", text)
        self.assertNotIn("Member", text)
        self.assertNotIn('"x"', text)
        self.assertNotIn("scores", rating)

    def test_participant_no_foreign_ratings_unless_revealed(self):
        self.rate_stage()
        self.mr.rate(self.run, self.xq, self.tok2, self.b.pk, delta=2)
        self.assertNotIn("scores", self.part())
        self.assertNotIn("balance", json.dumps(self.part()))
        # live display on -> scores appear
        self.configure(matrix_rating_live=True)
        self.assertEqual(self.part()["scores"], {str(self.b.pk): {"points": 2}})
        # results phase: only when the set shows results
        self.configure(matrix_rating_live=False)
        self.run.phase = Run.Phase.RESULTS
        self.run.save()
        self.assertIn("scores", self.part())
        self.question_set.show_results_to_participants = False
        self.question_set.save()
        self.assertNotIn("scores", self.part())

    def test_presenter_hidden_vs_live(self):
        self.rate_stage()
        self.mr.rate(self.run, self.xq, self.tok, self.b.pk, delta=1)
        self.mr.rate(self.run, self.xq, self.tok2, self.b.pk, delta=1)
        pres = self.pres()
        self.assertEqual((pres["stage"], pres["raters"]), ("rate", 2))
        self.assertNotIn("scores", pres)
        self.assertNotIn("ranking", pres)
        self.configure(matrix_rating_live=True)
        pres = self.pres()
        self.assertEqual(pres["scores"], {str(self.b.pk): {"points": 2}})
        self.assertEqual([r["title"] for r in pres["ranking"]], ["B"])
        self.assertEqual(pres["ranking"][0]["points"], 2)


class MatrixRatingResultsTests(MatrixTestCase):
    def setUp(self):
        super().setUp()
        from . import matrix_rating as mr

        self.mr = mr
        self.configure(matrix_rating_mode="points", matrix_rating_budget=5)
        self.a = self.add(title="A", zone="q1")
        self.b = self.add(title="B", zone="q2")
        self.mr.set_stage(self.run, self.xq, "rate")
        self.mr.rate(self.run, self.xq, self.tok, self.b.pk, delta=1)
        self.mr.rate(self.run, self.xq, self.tok, self.b.pk, delta=1)
        self.mr.rate(self.run, self.xq, self.tok2, self.a.pk, delta=1)

    def item(self):
        self.client.force_login(self.owner)
        data = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        run = next(r for r in data if any(q["kind"] == "matrix" for q in r["questions"]))
        return next(q for q in run["questions"] if q["kind"] == "matrix")

    def csv_cards(self):
        import csv
        import io

        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(body), delimiter=";"))
        header = rows[0]
        for row in rows[1:]:
            self.assertEqual(len(row), len(header), row)
        return {
            r[header.index("antwort")]: r[header.index("bewertung")]
            for r in rows[1:] if r[3] == "Where?"
        }

    def test_hidden_while_rating(self):
        rating = self.item()["matrix"]["rating"]
        self.assertTrue(rating["rating_in_progress"])
        self.assertEqual(rating["raters"], 2)
        self.assertNotIn("scores", rating)
        self.assertNotIn("ranking", rating)
        self.assertEqual(self.csv_cards(), {"A": "", "B": ""})

    def test_revealed_scores_ranking_csv(self):
        self.run.phase = Run.Phase.RESULTS
        self.run.save()
        rating = self.item()["matrix"]["rating"]
        self.assertNotIn("rating_in_progress", rating)
        self.assertEqual([r["title"] for r in rating["ranking"]], ["B", "A"])
        self.assertEqual(rating["scores"][str(self.b.pk)], {"points": 2})
        self.assertEqual(self.csv_cards(), {"A": "1", "B": "2"})

    def test_finished_run_reveals_and_updown_csv(self):
        self.configure(matrix_rating_mode="updown", matrix_rating_budget=3)
        from .models import MatrixRating

        MatrixRating.objects.all().delete()
        self.mr.rate(self.run, self.xq, self.tok, self.a.pk, value=1)
        self.mr.rate(self.run, self.xq, self.tok2, self.a.pk, value=-1)
        self.mr.rate(self.run, self.xq, self.tok, self.b.pk, value=1)
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        self.assertEqual(self.csv_cards(), {"A": "'+1/−1 (0)", "B": "'+1/−0 (1)"})

    def test_no_mode_no_rating_key_and_empty_column(self):
        self.configure(matrix_rating_mode="")
        self.assertNotIn("rating", self.item()["matrix"])
        self.assertEqual(self.csv_cards(), {"A": "", "B": ""})


class MatrixRatingFixWaveTests(MatrixTestCase):
    def setUp(self):
        super().setUp()
        from . import matrix_rating as mr

        self.mr = mr
        self.configure(matrix_rating_mode="points", matrix_rating_budget=3,
                       matrix_rating_live=True)
        self.t = mxs.add_teacher_card(self.run, self.xq, "q1", "Teacher")
        self.mr.set_stage(self.run, self.xq, "rate")
        self.mr.rate(self.run, self.xq, self.tok, self.t.pk, delta=1)

    def test_rating_only_run_counts_as_answered(self):
        from .mindmap import answered_runs_q, run_has_answers

        self.assertTrue(run_has_answers(self.run))
        self.assertEqual(
            list(self.question_set.runs.filter(answered_runs_q())), [self.run]
        )

    def test_rating_only_run_in_results_with_votes(self):
        self.client.force_login(self.owner)
        data = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results/"
        ).json()["results"]
        item = next(
            q for r in data for q in r["questions"] if q["kind"] == "matrix"
        )
        self.assertEqual(item["votes"], 1)
        self.assertEqual(build_payloads(self.room)["presenter"]["votes"], 1)

    def test_start_run_archive_keeps_rating_only_run(self):
        self.client.force_login(self.owner)
        resp = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"existing": "archive"}, content_type="application/json",
        ).json()
        self.assertNotEqual(resp["run"], self.run.pk)
        self.run.refresh_from_db()
        self.assertEqual(self.run.phase, Run.Phase.FINISHED)

    def test_csv_stack_member_rows_have_empty_rating(self):
        import csv
        import io

        self.mr.set_stage(self.run, self.xq, "collect")
        top = self.add(title="Top")
        member = self.add(title="Member")
        self.stacked(top, member)
        self.mr.set_stage(self.run, self.xq, "rate")
        self.mr.rate(self.run, self.xq, self.tok, top.pk, delta=1)
        self.client.force_login(self.owner)
        body = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/results.csv"
        ).content.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(body), delimiter=";"))
        header = rows[0]
        cells = {
            r[header.index("antwort")]: r[header.index("bewertung")]
            for r in rows[1:] if r[3] == "Where?"
        }
        self.assertEqual(cells["Member"], "")
        self.assertEqual(cells["Top"], "1")
        self.assertEqual(cells["Teacher"], "1")

    def test_set_stage_uses_fresh_run(self):
        stale = Run.objects.get(pk=self.run.pk)
        Run.objects.filter(pk=self.run.pk).update(phase=Run.Phase.FINISHED)
        with self.assertRaises(MatrixError) as cm:
            self.mr.set_stage(stale, self.xq, "collect", open_vote=True)
        self.assertEqual(cm.exception.status, 409)
        self.run.refresh_from_db()
        self.assertEqual(self.run.phase, Run.Phase.FINISHED)

    def test_rate_without_mode_is_409(self):
        self.configure(matrix_rating_mode="")
        r = self.client.post(
            f"/api/live/rooms/{self.room.code}/matrix/rate/",
            {"token": self.tok.key, "question": self.xq.pk, "card": self.t.pk, "delta": 1},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "Rating has not started.")


class MatrixSummaryCardTests(MatrixTestCase):
    """Summary cards (AI grouping): payload flag and auto-delete when their
    stack is dissolved by hand."""

    def summary_on(self, *members, zone="q1"):
        top = mxs.add_teacher_card(self.run, self.xq, zone, "Summary")
        MatrixCard.objects.filter(pk=top.pk).update(summary=True)
        top.refresh_from_db()
        self.stacked(top, *members)
        return top

    def test_default_false_and_in_payloads(self):
        from . import matrix_rating as mr

        a = self.add(title="A")
        top = self.summary_on(self.add(title="B"))
        cards = {c["id"]: c for c in mxs.board_payload(self.run, self.xq, True)["cards"]}
        self.assertFalse(cards[a.pk]["summary"])
        self.assertTrue(cards[top.pk]["summary"])
        self.configure(matrix_rating_mode="points", matrix_rating_budget=3)
        mr.set_stage(self.run, self.xq, "rate")
        rating = {c["id"]: c for c in mr.participant_payload(self.run, self.xq)["cards"]}
        self.assertTrue(rating[top.pk]["summary"])
        self.assertFalse(rating[a.pk]["summary"])

    def test_deleted_when_last_member_unstacked(self):
        a, b = self.add(title="A"), self.add(title="B")
        top = self.summary_on(a, b)
        mxs.unstack_card(self.run, self.xq, a.pk)
        self.assertTrue(MatrixCard.objects.filter(pk=top.pk).exists())
        b.refresh_from_db()
        self.assertEqual(b.stack_id, top.pk)
        mxs.unstack_card(self.run, self.xq, b.pk)
        self.assertFalse(MatrixCard.objects.filter(pk=top.pk).exists())
        self.assertTrue(MatrixCard.objects.filter(pk__in=[a.pk, b.pk]).count() == 2)

    def test_deleted_when_unstacked_itself(self):
        a, b = self.add(title="A"), self.add(title="B")
        top = self.summary_on(a, b)
        mxs.unstack_card(self.run, self.xq, top.pk)
        self.assertFalse(MatrixCard.objects.filter(pk=top.pk).exists())
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertIsNone(a.stack_id)
        self.assertEqual(b.stack_id, a.pk)

    def test_rated_summary_kept_when_last_member_unstacked(self):
        a = self.add(title="A")
        top = self.summary_on(a)
        MatrixRating.objects.create(card=top, token=self.tok2, value=1)
        mxs.unstack_card(self.run, self.xq, a.pk)
        top.refresh_from_db()
        self.assertTrue(top.summary)
        self.assertIsNone(top.stack_id)
        self.assertEqual(top.ratings.count(), 1)

    def test_rated_summary_kept_when_unstacked_itself(self):
        a = self.add(title="A")
        top = self.summary_on(a)
        MatrixRating.objects.create(card=top, token=self.tok2, value=1)
        mxs.unstack_card(self.run, self.xq, top.pk)
        top.refresh_from_db()
        a.refresh_from_db()
        self.assertTrue(top.summary)
        self.assertIsNone(top.stack_id)
        self.assertIsNone(a.stack_id)
        self.assertEqual(top.ratings.count(), 1)

    def test_deleted_when_last_member_removed_by_participant(self):
        a = self.add(title="A")
        top = self.summary_on(a)
        mxs.remove_card(self.run, self.xq, self.tok, a.pk)
        self.assertFalse(MatrixCard.objects.filter(pk=top.pk).exists())

    def test_unrated_summary_dragged_onto_card_loses_flag(self):
        a, b = self.add(title="A"), self.add(title="B")
        top = self.summary_on(a)
        mxs.stack_card(self.run, self.xq, top.pk, b.pk)
        top.refresh_from_db()
        self.assertEqual(top.stack_id, b.pk)
        self.assertFalse(top.summary)

    def test_rated_summary_dragged_onto_card_keeps_flag(self):
        a, b = self.add(title="A"), self.add(title="B")
        top = self.summary_on(a)
        MatrixRating.objects.create(card=top, token=self.tok2, value=1)
        mxs.stack_card(self.run, self.xq, top.pk, b.pk)
        top.refresh_from_db()
        self.assertEqual(top.stack_id, b.pk)
        self.assertTrue(top.summary)

    def test_plain_top_kept(self):
        a, b = self.add(title="A"), self.add(title="B")
        self.stacked(a, b)
        mxs.unstack_card(self.run, self.xq, b.pk)
        self.assertTrue(MatrixCard.objects.filter(pk=a.pk).exists())


class MatrixAiSimulateTests(MatrixTestCase):
    """``simulate_groups``/``simulate_hints`` against the live board and the
    signed proposal."""

    def setUp(self):
        super().setUp()
        self.configure(matrix_edges=True)
        self.a = self.add(title="A")
        self.b = self.add(title="B", token=self.tok2)
        self.c = self.add(title="C")
        self.d = self.add(title="D", zone="q2")
        self.e = self.add(title="E", zone="q2")

    def group(self, *cards, title="Group", description="", reason="why"):
        return {"cards": [getattr(c, "pk", c) for c in cards], "title": title,
                "description": description, "reason": reason}

    def simulate(self, *groups):
        groups = [{**g, "index": i} for i, g in enumerate(groups)]
        return mxs.simulate_groups(self.run, self.xq, groups)

    def test_ok_group(self):
        [g] = self.simulate(self.group(self.b, self.a, title="AB", description="desc"))
        self.assertEqual(g["status"], "ok")
        self.assertEqual(g["index"], 0)
        self.assertEqual(g["zone"], "q1")
        self.assertEqual([c["id"] for c in g["cards"]], [self.b.pk, self.a.pk])
        self.assertEqual(g["cards"][0], {"id": self.b.pk, "title": "B", "category": ""})
        self.assertEqual(g["title"], "AB")
        self.assertEqual(g["description"], "")  # descriptions off
        self.assertEqual(g["category"], "")
        # Position of the oldest card of the group.
        self.assertEqual((g["x"], g["y"]), (self.a.x, self.a.y))
        self.assertNotIn("top_summary_id", g)

    def test_description_kept_when_enabled(self):
        self.configure(matrix_descriptions=True)
        [g] = self.simulate(self.group(self.a, self.b, description="desc"))
        self.assertEqual(g["description"], "desc")

    def test_same_zone_only(self):
        [g] = self.simulate(self.group(self.a, self.d))
        self.assertEqual(g["status"], "skip")
        self.assertEqual(g["skip_reason"], "zones")

    def test_unknown_and_hidden_skipped(self):
        MatrixCard.objects.filter(pk=self.c.pk).update(hidden=True)
        other_q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.MATRIX, text="x", position=3,
        )
        foreign = mxs.add_card(self.run, other_q, self.tok, "q1", "Foreign")
        unknown, hidden, alien, ok = self.simulate(
            self.group(self.a, 999999), self.group(self.a, self.c),
            self.group(self.a, foreign), self.group(self.a, self.b),
        )
        self.assertEqual((unknown["status"], unknown["skip_reason"]), ("skip", "unknown"))
        self.assertEqual((hidden["status"], hidden["skip_reason"]), ("skip", "hidden"))
        self.assertEqual((alien["status"], alien["skip_reason"]), ("skip", "unknown"))
        self.assertEqual(ok["status"], "ok")

    def test_member_of_hidden_top_skipped(self):
        self.stacked(self.c, self.b)
        MatrixCard.objects.filter(pk=self.c.pk).update(hidden=True)
        [g] = self.simulate(self.group(self.a, self.b))
        self.assertEqual(g["skip_reason"], "hidden")

    def test_member_maps_to_top(self):
        self.stacked(self.a, self.b)
        [g] = self.simulate(self.group(self.b, self.c))
        self.assertEqual(g["status"], "ok")
        self.assertEqual([c["id"] for c in g["cards"]], [self.a.pk, self.c.pk])
        # Member and its own top are one top only -> too few.
        [g] = self.simulate(self.group(self.a, self.b))
        self.assertEqual((g["status"], g["skip_reason"]), ("skip", "too_few"))

    def test_card_in_two_groups(self):
        first, second, third = self.simulate(
            self.group(self.a, self.b), self.group(self.b, self.c), self.group(self.d, self.e),
        )
        self.assertEqual(first["status"], "ok")
        self.assertEqual((second["status"], second["skip_reason"]), ("skip", "duplicate"))
        self.assertEqual(third["status"], "ok")

    def test_skipped_group_does_not_reserve_cards(self):
        bad, good = self.simulate(self.group(self.a, self.d), self.group(self.a, self.b))
        self.assertEqual(bad["status"], "skip")
        self.assertEqual(good["status"], "ok")

    def test_category_majority_and_tie(self):
        self.configure(matrix_category_mode="colors", matrix_categories=[
            {"key": "blue", "name": {}}, {"key": "red", "name": {}},
        ])
        MatrixCard.objects.filter(pk=self.a.pk).update(category="red")
        MatrixCard.objects.filter(pk__in=[self.b.pk, self.c.pk]).update(category="blue")
        [g] = self.simulate(self.group(self.a, self.b, self.c))
        self.assertEqual(g["category"], "blue")
        # Tie: the oldest card's category.
        [g] = self.simulate(self.group(self.a, self.b))
        self.assertEqual(g["category"], "red")
        # Stack members count too.
        extra = self.add(title="F", category="red")
        self.stacked(self.b, extra)
        [g] = self.simulate(self.group(self.b, self.c))
        self.assertEqual(g["category"], "blue")  # b, c blue : F red
        [g] = self.simulate(self.group(self.a, self.b))
        self.assertEqual(g["category"], "red")  # a, F red : b blue

    def test_existing_summary_top_kept(self):
        top = mxs.add_teacher_card(self.run, self.xq, "q1", "Old summary")
        MatrixCard.objects.filter(pk=top.pk).update(summary=True)
        top.refresh_from_db()
        self.stacked(top, self.b)
        [g] = self.simulate(self.group(self.a, self.b, title="New"))
        self.assertEqual(g["status"], "ok")
        self.assertEqual(g["top_summary_id"], top.pk)
        self.assertEqual((g["x"], g["y"]), (top.x, top.y))
        self.assertEqual(g["title"], "Old summary")

    def test_hints(self):
        hints = mxs.simulate_hints(self.run, self.xq, [
            {"index": 0, "cards": [self.a.pk, self.d.pk, 999999], "reason": "same"},
            {"index": 1, "cards": [self.a.pk, self.b.pk], "reason": "one zone"},
            {"index": 2, "cards": [self.a.pk, 999999], "reason": "too few"},
        ])
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["index"], 0)
        self.assertEqual([c["id"] for c in hints[0]["cards"]], [self.a.pk, self.d.pk])
        self.assertEqual(hints[0]["cards"][1]["zone"], "q2")
        self.assertEqual(hints[0]["reason"], "same")

    def test_sign_roundtrip_tamper_and_other_run(self):
        groups = [{"index": 0, "cards": [1, 2], "title": "t", "description": "", "reason": ""}]
        hints = [{"index": 0, "cards": [1, 3], "reason": ""}]
        blob = mxs.sign_proposal(self.run, self.xq, groups, hints, 2)
        self.assertEqual(mxs.unsign_proposal(self.run, self.xq, blob), (groups, hints, 2))
        for bad in (blob[:-2] + "xx", "garbage", None, 5):
            with self.assertRaises(MatrixError) as cm:
                mxs.unsign_proposal(self.run, self.xq, bad)
            self.assertEqual(cm.exception.status, 400)
        other = Run(pk=self.run.pk + 1)  # only the id is compared
        with self.assertRaises(MatrixError):
            mxs.unsign_proposal(other, self.xq, blob)
        other_q = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.MATRIX, text="x", position=3,
        )
        with self.assertRaises(MatrixError):
            mxs.unsign_proposal(self.run, other_q, blob)

    def test_expired(self):
        blob = mxs.sign_proposal(self.run, self.xq, [], [], 0)
        later = timezone.now() + timezone.timedelta(hours=25)
        with patch("django.core.signing.time.time", return_value=later.timestamp()), \
                self.assertRaises(MatrixError) as cm:
            mxs.unsign_proposal(self.run, self.xq, blob)
        self.assertEqual(cm.exception.status, 409)
        self.assertIn("expired", cm.exception.detail)


class MatrixAiApplyTests(MatrixTestCase):
    """``apply_groups``/``undo_groups``: one transaction under the run lock,
    exact undo or 409."""

    def setUp(self):
        super().setUp()
        self.a = self.add(title="A")
        self.b = self.add(title="B", token=self.tok2)
        self.c = self.add(title="C")
        self.d = self.add(title="D", zone="q2")
        self.e = self.add(title="E", zone="q2")

    def groups(self, *card_lists, title="Group"):
        return [
            {"index": i, "cards": [c.pk for c in cards], "title": f"{title} {i}",
             "description": "Beschreibung", "reason": "r"}
            for i, cards in enumerate(card_lists)
        ]

    def apply(self, groups, selected=None, edits=None):
        if selected is None:
            selected = [g["index"] for g in groups]
        return mxs.apply_groups(self.run, self.xq, groups, selected, edits or {})

    def summary(self, title="Old", zone="q1"):
        top = mxs.add_teacher_card(self.run, self.xq, zone, title)
        MatrixCard.objects.filter(pk=top.pk).update(summary=True)
        top.refresh_from_db()
        return top

    def snapshot(self):
        return sorted(
            MatrixCard.objects.filter(run=self.run).values_list(
                "pk", "stack_id", "zone", "x", "y", "placed", "hidden", "summary", "title"
            )
        )

    def test_apply_creates_summary_and_stacks(self):
        self.stacked(self.c, self.d)  # D now lives in C's stack (q1)
        before_a = (self.a.x, self.a.y)
        result = self.apply(self.groups([self.b, self.a, self.c]))
        self.assertEqual(result["applied"], [0])
        self.assertEqual(result["skipped"], [])
        self.assertIsInstance(result["undo"], str)
        top = MatrixCard.objects.get(run=self.run, summary=True)
        self.assertEqual(
            (top.title, top.teacher, top.token_id, top.zone, top.stack_id, top.description),
            ("Group 0", True, None, "q1", None, ""),  # descriptions off
        )
        self.assertEqual((top.x, top.y), before_a)
        for card in (self.a, self.b, self.c, self.d):
            card.refresh_from_db()
            self.assertEqual(card.stack_id, top.pk, card.title)
            self.assertEqual((card.zone, card.x, card.y), (top.zone, top.x, top.y))

    def test_description_kept_when_enabled(self):
        self.configure(matrix_descriptions=True)
        self.apply(self.groups([self.a, self.b]))
        top = MatrixCard.objects.get(run=self.run, summary=True)
        self.assertEqual(top.description, "Beschreibung")

    def test_edits(self):
        self.configure(matrix_descriptions=True, matrix_category_mode="colors",
                       matrix_categories=[{"key": "blue", "name": {}}, {"key": "red", "name": {}}])
        MatrixCard.objects.filter(pk__in=[self.a.pk, self.b.pk]).update(category="red")
        self.apply(self.groups([self.a, self.b], [self.d, self.e]), edits={
            0: {"title": "  Edited  ", "description": "Neu", "category": "blue"},
            1: {"category": "nope"},
        })
        first = MatrixCard.objects.get(run=self.run, summary=True, zone="q1")
        self.assertEqual((first.title, first.description, first.category),
                         ("Edited", "Neu", "blue"))
        second = MatrixCard.objects.get(run=self.run, summary=True, zone="q2")
        self.assertEqual(second.title, "Group 1")
        self.assertEqual(second.category, "blue")  # invalid edit -> proposal's (fallback)

    def test_title_too_long_refused_without_change(self):
        before = self.snapshot()
        for edit in ({"title": "x" * 61}, {"title": "  "}):
            with self.assertRaises(MatrixError) as cm:
                self.apply(self.groups([self.a, self.b], [self.d, self.e]), edits={1: edit})
            self.assertEqual(cm.exception.status, 400)
        self.assertEqual(self.snapshot(), before)

    def test_existing_summary_top_kept(self):
        old = self.summary()
        self.stacked(old, self.c)
        result = self.apply(self.groups([self.a, self.c, self.b]))
        self.assertEqual(result["applied"], [0])
        self.assertEqual(MatrixCard.objects.filter(run=self.run, summary=True).count(), 1)
        old.refresh_from_db()
        self.assertEqual(old.title, "Old")
        self.assertIsNone(old.stack_id)
        for card in (self.a, self.b, self.c):
            card.refresh_from_db()
            self.assertEqual(card.stack_id, old.pk)

    def test_two_summaries_unrated_other_deleted(self):
        first = self.summary("First")
        second = self.summary("Second")
        self.stacked(first, self.a)
        self.stacked(second, self.b)
        self.apply(self.groups([self.a, self.b]))
        self.assertFalse(MatrixCard.objects.filter(pk=second.pk).exists())
        self.b.refresh_from_db()
        self.assertEqual(self.b.stack_id, first.pk)

    def test_two_summaries_rated_other_becomes_member(self):
        first = self.summary("First")
        second = self.summary("Second")
        self.stacked(first, self.a)
        self.stacked(second, self.b)
        MatrixRating.objects.create(card=second, token=self.tok, value=1)
        self.apply(self.groups([self.a, self.b]))
        second.refresh_from_db()
        self.b.refresh_from_db()
        self.assertEqual(second.stack_id, first.pk)
        self.assertEqual(self.b.stack_id, first.pk)

    def test_skipped_when_board_changed(self):
        groups = self.groups([self.a, self.b], [self.d, self.e], [self.a, self.c])
        MatrixCard.objects.filter(pk=self.b.pk).update(hidden=True)
        mxs.move_card(self.run, self.xq, self.e.pk, 0.5, 0.5)  # E now in q1
        result = self.apply(groups)
        self.assertEqual(result["applied"], [2])
        self.assertEqual(result["skipped"], [{"index": 0, "reason": "hidden"},
                                             {"index": 1, "reason": "zones"}])

    def test_skipped_when_stacked_elsewhere(self):
        groups = self.groups([self.a, self.b])
        self.stacked(self.b, self.a)
        result = self.apply(groups)
        self.assertEqual(result["applied"], [])
        self.assertEqual(result["skipped"], [{"index": 0, "reason": "too_few"}])

    def test_only_selected(self):
        result = self.apply(self.groups([self.a, self.b], [self.d, self.e]), selected=[1])
        self.assertEqual(result["applied"], [1])
        self.a.refresh_from_db()
        self.assertIsNone(self.a.stack_id)

    def test_rating_refused(self):
        from . import matrix_rating as mr

        self.configure(matrix_rating_mode="points", matrix_rating_budget=3)
        mr.set_stage(self.run, self.xq, "rate")
        with self.assertRaises(MatrixError) as cm:
            self.apply(self.groups([self.a, self.b]))
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(cm.exception.detail, mxs.STACKS_LOCKED)

    def test_undo_restores_exactly(self):
        self.stacked(self.c, self.d)
        first = self.summary("First")
        second = self.summary("Second", zone="q2")
        self.stacked(first, self.a)
        before = self.snapshot()
        undo = self.apply(self.groups([self.a, self.b, self.c], [self.e, second]))["undo"]
        self.assertNotEqual(self.snapshot(), before)
        mxs.undo_groups(self.run, self.xq, undo)
        self.assertEqual(self.snapshot(), before)

    def test_undo_recreates_deleted_summary(self):
        first = self.summary("First")
        second = self.summary("Second")
        self.stacked(first, self.a)
        self.stacked(second, self.b)
        undo = self.apply(self.groups([self.a, self.b]))["undo"]
        mxs.undo_groups(self.run, self.xq, undo)
        restored = MatrixCard.objects.get(run=self.run, title="Second")
        self.assertTrue(restored.summary)
        self.b.refresh_from_db()
        self.assertEqual(self.b.stack_id, restored.pk)
        self.a.refresh_from_db()
        self.assertEqual(self.a.stack_id, first.pk)

    def test_undo_after_change_refused(self):
        undo = self.apply(self.groups([self.a, self.b, self.c]))["undo"]
        mxs.unstack_card(self.run, self.xq, self.c.pk)
        before = self.snapshot()
        with self.assertRaises(MatrixError) as cm:
            mxs.undo_groups(self.run, self.xq, undo)
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(
            cm.exception.detail,
            "Der Stapel wurde inzwischen verändert – Rückgängig ist nicht mehr möglich.",
        )
        self.assertEqual(self.snapshot(), before)

    def test_undo_after_extra_card_stacked_refused(self):
        undo = self.apply(self.groups([self.a, self.b]))["undo"]
        top = MatrixCard.objects.get(run=self.run, summary=True)
        mxs.stack_card(self.run, self.xq, self.c.pk, top.pk)
        with self.assertRaises(MatrixError) as cm:
            mxs.undo_groups(self.run, self.xq, undo)
        self.assertEqual(cm.exception.status, 409)

    def test_new_summary_inherits_placed(self):
        mxs.move_card(self.run, self.xq, self.a.pk, 0.7, 0.7)
        self.a.refresh_from_db()
        self.apply(self.groups([self.a, self.b]))
        top = MatrixCard.objects.get(run=self.run, summary=True)
        self.assertTrue(top.placed)
        self.assertEqual((top.x, top.y), (self.a.x, self.a.y))
        self.apply(self.groups([self.d, self.e]))
        self.assertFalse(MatrixCard.objects.get(run=self.run, summary=True, zone="q2").placed)

    def test_limit_skip(self):
        old = self.summary()
        self.stacked(old, self.c)
        count = MatrixCard.objects.filter(run=self.run).count()
        with patch.object(mxs, "MATRIX_MAX_CARDS", count):
            result = self.apply(self.groups([self.a, self.b]))
            self.assertEqual(result["skipped"], [{"index": 0, "reason": "limit"}])
            # Keeping an existing summary needs no new card.
            [g] = self.groups([self.c, self.a])
            self.assertEqual(self.apply([g])["applied"], [0])

    def test_edits_ignored_when_summary_kept(self):
        old = self.summary()
        self.stacked(old, self.c)
        result = self.apply(self.groups([self.c, self.a]), edits={0: {"title": "x" * 99}})
        self.assertEqual(result["applied"], [0])
        old.refresh_from_db()
        self.assertEqual(old.title, "Old")

    def test_undo_refused_when_created_summary_rated(self):
        undo = self.apply(self.groups([self.a, self.b]))["undo"]
        top = MatrixCard.objects.get(run=self.run, summary=True)
        MatrixRating.objects.create(card=top, token=self.tok, value=1)
        before = self.snapshot()
        with self.assertRaises(MatrixError) as cm:
            mxs.undo_groups(self.run, self.xq, undo)
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(self.snapshot(), before)

    def test_undo_refused_when_recreation_exceeds_limit(self):
        first = self.summary("First")
        second = self.summary("Second")
        self.stacked(first, self.a)
        self.stacked(second, self.b)
        undo = self.apply(self.groups([self.a, self.b]))["undo"]
        self.add(title="Filler")
        before = self.snapshot()
        with patch.object(mxs, "MATRIX_MAX_CARDS", len(before)), \
                self.assertRaises(MatrixError) as cm:
            mxs.undo_groups(self.run, self.xq, undo)
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(self.snapshot(), before)

    def test_skipped_when_tops_changed_since_proposal(self):
        [group] = self.groups([self.a, self.b])
        group["tops"] = [self.a.pk, self.b.pk]
        self.stacked(self.c, self.b)  # B now in C's (unreviewed) stack
        result = self.apply([group])
        self.assertEqual(result["skipped"], [{"index": 0, "reason": "changed"}])
        self.c.refresh_from_db()
        self.assertIsNone(self.c.stack_id)
        self.assertFalse(MatrixCard.objects.filter(summary=True).exists())

    def test_undo_expired(self):
        undo = self.apply(self.groups([self.a, self.b]))["undo"]
        later = timezone.now() + timezone.timedelta(hours=25)
        with patch("django.core.signing.time.time", return_value=later.timestamp()), \
                self.assertRaises(MatrixError) as cm:
            mxs.undo_groups(self.run, self.xq, undo)
        self.assertEqual(cm.exception.status, 409)
        self.assertTrue(MatrixCard.objects.filter(summary=True).exists())

    def test_undo_invalid(self):
        undo = self.apply(self.groups([self.a, self.b]))["undo"]
        for bad in (undo[:-2] + "xx", None, mxs.sign_proposal(self.run, self.xq, [], [], 0)):
            with self.assertRaises(MatrixError) as cm:
                mxs.undo_groups(self.run, self.xq, bad)
            self.assertEqual(cm.exception.status, 400)
        with self.assertRaises(MatrixError):
            mxs.undo_groups(Run(pk=self.run.pk + 1), self.xq, undo)


@override_settings(**AI_ON)
class MatrixAiApiTests(MatrixTestCase):
    CHAT = "basicbar_integrations.ai.chat_json"

    def setUp(self):
        super().setUp()
        self.configure(wordcloud_ai_enabled=True)
        self.a = self.add(title="Wind")
        self.b = self.add(title="wind", token=self.tok2)
        self.c = self.add(title="Sonne")
        self.d = self.add(title="Windkraft", zone="q2")

    def post(self, op, body=None, user=None):
        self.client.force_login(user or self.owner)
        with patch("live.views.broadcast") as broadcast:
            response = self.client.post(
                f"/api/runs/{self.run.pk}/matrix/{self.xq.pk}/{op}", body or {},
                content_type="application/json",
            )
        self.broadcast = broadcast
        return response

    def reply(self):
        return {
            "groups": [
                {"cards": [self.a.pk, self.b.pk], "title": "Wind", "reason": "Schreibweise"},
                {"cards": [self.a.pk, self.d.pk], "title": "Quer", "reason": "x"},
                {"cards": [self.a.pk], "title": "kaputt"},
            ],
            "hints": [{"cards": [self.a.pk, self.d.pk], "reason": "gleich"}],
        }

    def propose(self, level="spelling", reply=None):
        with patch(self.CHAT, return_value=reply or self.reply()) as chat:
            response = self.post("ai-propose", {"level": level})
        self.chat = chat
        return response

    def test_propose_shape_and_privacy(self):
        response = self.propose()
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertEqual(set(data), {"groups", "hints", "dropped", "proposal"})
        self.assertEqual([g["status"] for g in data["groups"]], ["ok", "skip"])
        self.assertEqual(data["dropped"], 2)  # one malformed + one skipped
        self.assertEqual(len(data["hints"]), 1)
        system, user = self.chat.call_args.args
        for token in (self.tok, self.tok2):
            self.assertNotIn(token.key, system + user)
        self.assertIn("Wind", user)
        self.broadcast.assert_not_called()
        self.assertFalse(MatrixCard.objects.filter(summary=True).exists())

    def test_propose_gating(self):
        with override_settings(**AI_OFF), patch(self.CHAT) as chat:
            self.assertEqual(self.post("ai-propose", {"level": "same"}).status_code, 503)
        chat.assert_not_called()
        self.assertEqual(self.propose(level="wild").status_code, 400)
        self.assertEqual(self.propose(level=None).status_code, 400)
        self.configure(wordcloud_ai_enabled=False)
        self.assertEqual(self.propose().status_code, 400)
        self.configure(wordcloud_ai_enabled=True)
        self.stacked(self.a, self.b)  # with C hidden: 2 visible tops
        MatrixCard.objects.filter(pk=self.c.pk).update(hidden=True)
        response = self.propose()
        self.assertEqual(response.status_code, 400)
        self.chat.assert_not_called()

    def test_propose_rating_409(self):
        from . import matrix_rating as mr

        self.configure(matrix_rating_mode="points", matrix_rating_budget=3)
        mr.set_stage(self.run, self.xq, "rate")
        self.assertEqual(self.propose().status_code, 409)
        self.chat.assert_not_called()

    def test_propose_ai_error_502(self):
        from basicbar_integrations import ai as ai_module

        with patch(self.CHAT, side_effect=ai_module.AIError("boom")):
            response = self.post("ai-propose", {"level": "same"})
        self.assertEqual(response.status_code, 502)
        self.assertIn("boom", response.json()["detail"])

    def test_non_owner_404(self):
        eve = User.objects.create_user(username="eve")
        for op in ("ai-propose", "ai-apply", "ai-undo"):
            with patch(self.CHAT) as chat:
                self.assertEqual(self.post(op, {"level": "same"}, user=eve).status_code, 404)
            chat.assert_not_called()

    def test_apply_and_undo(self):
        proposal = self.propose().json()["proposal"]
        response = self.post("ai-apply", {
            "proposal": proposal, "selected": [0, 1], "edits": {"0": {"title": "Windig"}},
        })
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertEqual(data["applied"], [0])
        self.assertEqual(data["skipped"], [{"index": 1, "reason": "zones"}])
        self.assertEqual(self.broadcast.call_count, 1)
        top = MatrixCard.objects.get(summary=True)
        self.assertEqual(top.title, "Windig")
        response = self.post("ai-undo", {"undo": data["undo"]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(self.broadcast.call_count, 1)
        self.assertFalse(MatrixCard.objects.filter(summary=True).exists())
        self.assertEqual(self.post("ai-undo", {"undo": data["undo"]}).status_code, 409)
        self.broadcast.assert_not_called()

    def test_apply_skips_stack_changed_since_proposal(self):
        proposal = self.propose().json()["proposal"]
        mxs.stack_card(self.run, self.xq, self.b.pk, self.c.pk)
        response = self.post("ai-apply", {"proposal": proposal, "selected": [0]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["skipped"], [{"index": 0, "reason": "changed"}])
        self.broadcast.assert_not_called()  # nothing applied
        self.c.refresh_from_db()
        self.assertIsNone(self.c.stack_id)
        self.assertFalse(MatrixCard.objects.filter(summary=True).exists())

    def test_apply_invalid(self):
        proposal = self.propose().json()["proposal"]
        for body in (
            {"proposal": proposal, "selected": [5]},
            {"proposal": proposal, "selected": "0"},
            {"proposal": proposal, "selected": [True]},
            {"proposal": proposal, "selected": [0], "edits": []},
            {"proposal": proposal, "selected": [0], "edits": {"x": {}}},
            {"proposal": proposal, "selected": [0], "edits": {"²": {}}},
            {"proposal": proposal, "selected": [0], "edits": {"0": "t"}},
            {"proposal": proposal, "selected": [0], "edits": {"0": {"title": 5}}},
            {"proposal": proposal, "selected": [0], "edits": {"0": {"title": "x" * 61}}},
            {"proposal": "nope", "selected": [0]},
        ):
            response = self.post("ai-apply", body)
            self.assertEqual(response.status_code, 400, body)
            self.broadcast.assert_not_called()
        self.assertFalse(MatrixCard.objects.filter(summary=True).exists())
