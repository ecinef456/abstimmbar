# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

import io
from typing import ClassVar
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, TransactionTestCase
from django.utils import timezone, translation
from PIL import Image, ImageDraw
from rest_framework import serializers

from common.i18n_fields import TranslatedMapMixin, resolve_translated_text
from live.models import MindmapContribution, MindmapNode, ParticipantToken, Run, Vote

from . import ai_generate, set_types
from .images import InvalidImageError, normalize_image
from .models import AnswerOption, Question, QuestionSet, Room, UploadedImage
from .onboarding import seed_example_room
from .sanitize import clean_html

User = get_user_model()


class SanitizeTests(TestCase):
    def test_allows_editor_subset(self):
        html = "<p>Was ist <strong>richtig</strong>?</p><ul><li>A</li></ul>"
        self.assertEqual(clean_html(html), html)

    def test_strips_scripts_and_handlers(self):
        dirty = '<p onclick="x()">Hi<script>alert(1)</script></p>'
        self.assertEqual(clean_html(dirty), "<p>Hi</p>")

    def test_keeps_relative_media_images_only(self):
        self.assertIn("src", clean_html('<img src="/media/question-images/a.png">'))
        self.assertNotIn("src", clean_html('<img src="https://evil.example/x.png">'))
        self.assertNotIn("src", clean_html('<img src="data:image/png;base64,AAAA">'))


class RoomModelTests(TestCase):
    def test_room_gets_unique_word_code(self):
        room_a = Room.objects.create(title="Bio 101")
        room_b = Room.objects.create(title="Chemie")
        # Three lowercase ASCII words joined by hyphens, e.g. "tiger-komet-radio".
        parts = room_a.code.split("-")
        self.assertEqual(len(parts), 3)
        self.assertTrue(all(p.isascii() and p.isalpha() and p.islower() for p in parts))
        self.assertNotEqual(room_a.code, room_b.code)

    def test_code_survives_updates(self):
        room = Room.objects.create(title="Bio 101")
        code = room.code
        room.title = "Bio 102"
        room.save()
        self.assertEqual(room.code, code)


class QuestionModelTests(TestCase):
    def test_model_solution_and_participant_feedback_defaults(self):
        room = Room.objects.create(title="Bio 101")
        question_set = QuestionSet.objects.create(room=room, title="Set")
        question = Question.objects.create(
            question_set=question_set, kind="open_text", text="Q"
        )
        self.assertEqual(question.model_solution, "")
        self.assertFalse(question.participant_feedback)

    def test_serializer_round_trips_model_solution_and_participant_feedback(self):
        from rooms.serializers import QuestionSerializer

        room = Room.objects.create(title="Bio 101")
        question_set = QuestionSet.objects.create(room=room, title="Set")
        open_text_question = Question.objects.create(
            question_set=question_set,
            kind="open_text",
            text="Q",
            model_solution="Photosynthese wandelt Licht in Energie um.",
            participant_feedback=True,
        )
        data = QuestionSerializer(open_text_question).data
        self.assertIn("model_solution", data)
        self.assertIn("participant_feedback", data)
        self.assertEqual(
            data["model_solution"], "Photosynthese wandelt Licht in Energie um."
        )
        self.assertTrue(data["participant_feedback"])


class ApiTestCase(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="frank")
        self.other = User.objects.create_user(username="eve")
        # Outside a request, the active language is LANGUAGE_CODE ("en"), not
        # the content-canonical MODELTRANSLATION_DEFAULT_LANGUAGE ("de") —
        # override so this fixture's title lands in title_de like real
        # authored content would (#33 MR2; see ModeltranslationTests).
        with translation.override("de"):
            self.room = Room.objects.create(title="Bio 101")
        self.room.owners.add(self.owner)
        self.client.force_login(self.owner)


class RoomApiTests(ApiTestCase):
    def test_list_shows_only_own_rooms(self):
        foreign = Room.objects.create(title="Fremd")
        foreign.owners.add(self.other)
        payload = self.client.get("/api/rooms/").json()
        # title is a {"de","en"} map (#33 MR2); self.room's canonical (de)
        # value was set in ApiTestCase.setUp.
        titles = [room["title"] for room in payload["results"]]
        self.assertEqual(titles, [{"de": "Bio 101", "en": ""}])

    def test_list_reports_set_type_counts(self):
        # #75: the room card shows a per-type breakdown of its sets.
        QuestionSet.objects.create(room=self.room, title="L1", type="live_poll")
        QuestionSet.objects.create(room=self.room, title="L2", type="live_poll")
        QuestionSet.objects.create(room=self.room, title="Q1", type="self_paced")
        QuestionSet.objects.create(room=self.room, title="C1", type="self_check")
        QuestionSet.objects.create(room=self.room, title="C2", type="self_check")
        QuestionSet.objects.create(room=self.room, title="C3", type="self_check")
        room = next(
            r for r in self.client.get("/api/rooms/").json()["results"]
            if r["id"] == self.room.pk
        )
        self.assertEqual(
            room["set_type_counts"],
            {"live_poll": 2, "self_paced": 1, "self_check": 3},
        )
        self.assertEqual(room["question_set_count"], 6)

    def test_create_response_has_zeroed_set_type_counts(self):
        # The create response isn't annotated; the serializer falls back to a
        # grouped count, which is all zeros for a brand-new room.
        response = self.client.post(
            "/api/rooms/", {"title": "Leer"}, content_type="application/json"
        )
        self.assertEqual(
            response.json()["set_type_counts"],
            {"live_poll": 0, "self_paced": 0, "self_check": 0},
        )

    def test_create_room_assigns_owner_and_code(self):
        response = self.client.post(
            "/api/rooms/", {"title": "Neuer Raum"}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        room = Room.objects.get(pk=response.json()["id"])
        self.assertIn(self.owner, room.owners.all())
        self.assertEqual(response.json()["code"].count("-"), 2)  # three words

    def test_create_records_provenance(self):
        response = self.client.post(
            "/api/rooms/", {"title": "Mit Herkunft"}, content_type="application/json"
        )
        room = Room.objects.get(pk=response.json()["id"])
        self.assertEqual(room.created_by, self.owner)
        self.assertEqual(room.updated_by, self.owner)
        self.assertEqual(response.json()["created_by_name"], "frank")

    def test_update_records_editor(self):
        room = Room.objects.create(title="Alt", created_by=self.other)
        room.owners.add(self.owner)
        self.client.patch(
            f"/api/rooms/{room.pk}/", {"title": "Neu"}, content_type="application/json"
        )
        room.refresh_from_db()
        self.assertEqual(room.title, "Neu")
        self.assertEqual(room.updated_by, self.owner)  # editor, not creator
        self.assertEqual(room.created_by, self.other)  # unchanged

    def test_logo_in_presentation_flag(self):
        # Defaults to on; togglable per room.
        self.assertTrue(self.room.show_logo_in_presentation)
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"show_logo_in_presentation": False},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.room.refresh_from_db()
        self.assertFalse(self.room.show_logo_in_presentation)

    def test_favorite_toggle(self):
        listing = self.client.get("/api/rooms/").json()["results"]
        self.assertFalse(listing[0]["is_favorite"])
        marked = self.client.post(f"/api/rooms/{self.room.pk}/favorite/").json()
        self.assertTrue(marked["is_favorite"])
        self.assertIn(self.owner, self.room.favorited_by.all())
        unmarked = self.client.delete(f"/api/rooms/{self.room.pk}/favorite/").json()
        self.assertFalse(unmarked["is_favorite"])

    def test_archive_toggle_and_listing(self):
        # Archiving removes the room from the overview and surfaces it in the
        # archive listing; unarchiving reverses both (#16).
        marked = self.client.post(f"/api/rooms/{self.room.pk}/archive/").json()
        self.assertTrue(marked["is_archived"])
        self.assertIn(self.owner, self.room.archived_by.all())
        overview = self.client.get("/api/rooms/").json()["results"]
        self.assertNotIn(self.room.pk, [r["id"] for r in overview])
        archived = self.client.get("/api/rooms/?archived=1").json()["results"]
        self.assertEqual([r["id"] for r in archived], [self.room.pk])
        unmarked = self.client.delete(f"/api/rooms/{self.room.pk}/archive/").json()
        self.assertFalse(unmarked["is_archived"])
        overview = self.client.get("/api/rooms/").json()["results"]
        self.assertIn(self.room.pk, [r["id"] for r in overview])

    def test_last_used_at_reflects_runs(self):
        from live.models import Run

        self.assertIsNone(self.client.get("/api/rooms/").json()["results"][0]["last_used_at"])
        qs = QuestionSet.objects.create(room=self.room, title="T")
        Run.objects.create(question_set=qs)
        payload = self.client.get("/api/rooms/").json()["results"][0]
        self.assertIsNotNone(payload["last_used_at"])

    def test_page_size_param(self):
        for i in range(3):
            r = Room.objects.create(title=f"R{i}")
            r.owners.add(self.owner)
        page = self.client.get("/api/rooms/?page_size=2").json()
        self.assertEqual(page["count"], 4)  # Bio 101 + 3
        self.assertEqual(len(page["results"]), 2)

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/rooms/").status_code, 403)

    def test_description_html_is_sanitized_on_write(self):
        # The editor now sends HTML (#49/#50); validate_description must run
        # it through the shared allowlist, stripping <script>.
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"description": {"de": '<p>ok <strong>b</strong><script>x()</script></p>', "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.room.refresh_from_db()
        self.assertEqual(self.room.description_de, "<p>ok <strong>b</strong></p>")

    def test_closing_info_html_link_gets_rel_noopener(self):
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"closing_info": {"de": '<a href="https://x.io">l</a>', "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.room.refresh_from_db()
        self.assertIn('rel="noopener"', self.room.closing_info_de)

    def test_room_is_lti_flag(self):
        from lti.models import LtiContextLink, LtiPlatform

        # a fresh non-LTI room the owner owns
        with translation.override("de"):
            plain = Room.objects.create(title="Plain")
        plain.owners.add(self.owner)
        # mark self.room as LTI-created
        platform = LtiPlatform.objects.create(
            name="P", issuer="https://lms.example", client_id="c1",
            auth_login_url="https://lms.example/auth",
            auth_token_url="https://lms.example/tok",
        )
        LtiContextLink.objects.create(platform=platform, context_id="ctx1", room=self.room)
        detail = self.client.get(f"/api/rooms/{self.room.id}/").json()
        self.assertTrue(detail["is_lti"])
        other = self.client.get(f"/api/rooms/{plain.id}/").json()
        self.assertFalse(other["is_lti"])


class QuestionSetApiTests(ApiTestCase):
    def test_create_and_counts(self):
        response = self.client.post(
            "/api/question-sets/",
            {"room": self.room.pk, "title": "Termin 1"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["reveal_answers"], "immediately")
        listing = self.client.get(f"/api/question-sets/?room={self.room.pk}").json()
        self.assertEqual(listing["results"][0]["question_count"], 0)
        self.assertFalse(listing["results"][0]["has_results"])

    def test_has_results_counts_mindmap_contributions(self):
        qs = QuestionSet.objects.create(room=self.room, title="Termin 1")
        question = Question.objects.create(question_set=qs, kind="mindmap", text="Q", position=0)
        run = Run.objects.create(question_set=qs)
        node = MindmapNode.objects.create(run=run, question=question, text="Wind", text_key="wind")
        token = ParticipantToken.objects.create(room=self.room)
        MindmapContribution.objects.create(node=node, token=token)
        listing = self.client.get(f"/api/question-sets/?room={self.room.pk}").json()
        self.assertTrue(listing["results"][0]["has_results"])
        detail = self.client.get(f"/api/question-sets/{qs.pk}/").json()
        self.assertTrue(detail["has_results"])

    def test_description_html_is_sanitized_on_write(self):
        # #49/#50: description is now authored HTML; validate_description
        # must sanitize it, dropping the foreign (non-/media/) image src.
        qs = QuestionSet.objects.create(room=self.room, title="Termin 1")
        response = self.client.patch(
            f"/api/question-sets/{qs.pk}/",
            {"description": {"de": '<p>x</p><img src="https://evil/a.png">', "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        qs.refresh_from_db()
        self.assertNotIn("evil", qs.description_de)

    def test_cannot_create_in_foreign_room(self):
        foreign = Room.objects.create(title="Fremd")
        foreign.owners.add(self.other)
        response = self.client.post(
            "/api/question-sets/",
            {"room": foreign.pk, "title": "Einbruch"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_foreign_sets_are_invisible(self):
        foreign_room = Room.objects.create(title="Fremd")
        foreign_room.owners.add(self.other)
        foreign_set = QuestionSet.objects.create(room=foreign_room, title="Geheim")
        self.assertEqual(
            self.client.get(f"/api/question-sets/{foreign_set.pk}/").status_code, 404
        )

    def test_self_check_token_is_null_by_default_and_read_only(self):
        # #75 Phase 3: self_check_token is only ever set via the (not yet
        # built) publish action, never by a plain write.
        qs = QuestionSet.objects.create(room=self.room, title="Termin 1")
        response = self.client.get(f"/api/question-sets/{qs.pk}/")
        self.assertIsNone(response.json()["self_check_token"])

        response = self.client.patch(
            f"/api/question-sets/{qs.pk}/",
            {"self_check_token": "abc"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["self_check_token"])
        qs.refresh_from_db()
        self.assertIsNone(qs.self_check_token)


class QuestionApiTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(room=self.room, title="Termin 1")

    def _create_question(self, **overrides):
        payload = {
            "question_set": self.question_set.pk,
            "kind": "single_choice",
            "text": "<p>Was ist 2+2?</p>",
            "options": [
                {"text": "4", "is_correct": True},
                {"text": "5", "is_correct": False},
            ],
        }
        payload.update(overrides)
        return self.client.post(
            "/api/questions/", payload, content_type="application/json"
        )

    def test_wordcloud_grouping_capped_at_1000(self):
        ok = self._create_question(
            kind="word_cloud", options=[], wordcloud_grouping="x" * 1000
        )
        self.assertEqual(ok.status_code, 201)
        too_long = self._create_question(
            kind="word_cloud", options=[], wordcloud_grouping="x" * 1001
        )
        self.assertEqual(too_long.status_code, 400)
        self.assertIn("wordcloud_grouping", too_long.json())

    def test_create_with_nested_options(self):
        response = self._create_question()
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data["position"], 0)
        # text is a {"de","en"} map (#33 MR2); a plain-string write (legacy
        # payload, as used by _create_question) lands in the canonical (de)
        # language only.
        self.assertEqual(
            [o["text"] for o in data["options"]],
            [{"de": "4", "en": ""}, {"de": "5", "en": ""}],
        )
        self.assertTrue(data["options"][0]["is_correct"])

    def test_binary_choice_round_trips(self):
        # The Ja/Nein preset persists a marker so the editor shows the
        # template quick-fill again on re-open (#79).
        response = self._create_question(
            binary_choice=True,
            options=[
                {"text": "Ja", "is_correct": True},
                {"text": "Nein", "is_correct": False},
            ],
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["binary_choice"])
        qid = response.json()["id"]
        self.assertTrue(self.client.get(f"/api/questions/{qid}/").json()["binary_choice"])

    def test_binary_choice_defaults_false(self):
        self.assertFalse(self._create_question().json()["binary_choice"])

    def test_text_is_sanitized(self):
        response = self._create_question(text='<p>Hi<script>alert(1)</script></p>')
        # Sanitizing (validate_text) still runs per language inside the mixin.
        self.assertEqual(response.json()["text"], {"de": "<p>Hi</p>", "en": ""})

    def test_nested_update_replaces_options(self):
        question_id = self._create_question().json()["id"]
        keep_id = Question.objects.get(pk=question_id).options.first().pk
        response = self.client.put(
            f"/api/questions/{question_id}/",
            {
                "question_set": self.question_set.pk,
                "kind": "multiple_choice",
                "text": "<p>Neu</p>",
                "options": [
                    {"id": keep_id, "text": "vier", "is_correct": True},
                    {"text": "sechs", "is_correct": False},
                ],
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        options = list(AnswerOption.objects.filter(question_id=question_id))
        self.assertEqual(len(options), 2)
        self.assertEqual(options[0].pk, keep_id)
        self.assertEqual(options[0].text, "vier")

    def test_update_with_ids_preserves_options_and_their_votes(self):
        # Regression (#86): re-saving a question must UPDATE the existing option
        # rows (whose pks the votes point at), not delete+recreate them — else
        # every vote is orphaned. The Likert editor used to rebuild its scale
        # from scratch without ids; it now sends each row's id, exercised here.
        from live.models import ParticipantToken, Run, Vote

        question = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.LIKERT,
            text="<p>Gut?</p>",
        )
        steps = [
            AnswerOption.objects.create(question=question, text_de=t, position=i)
            for i, t in enumerate(["Stimme nicht zu", "", "", "", "Stimme zu"])
        ]
        run = Run.objects.create(question_set=self.question_set)
        for option in (steps[0], steps[3]):
            token = ParticipantToken.objects.create(room=self.room)
            Vote.objects.create(run=run, question=question, token=token).options.add(option)
        original_ids = [s.pk for s in steps]

        response = self.client.put(
            f"/api/questions/{question.pk}/",
            {
                "question_set": self.question_set.pk,
                "kind": "likert",
                "text": "<p>Immer noch gut?</p>",  # edit the question, then re-save
                "options": [
                    {"id": pk, "text": text, "is_correct": False}
                    for pk, text in zip(
                        original_ids,
                        ["Stimme gar nicht zu", "", "", "", "Stimme voll zu"],
                    )
                ],
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        # Same rows, same pks — so the votes still resolve.
        self.assertEqual(
            [o.pk for o in question.options.order_by("position")], original_ids
        )
        self.assertEqual(Vote.objects.filter(run=run, question=question).count(), 2)
        self.assertEqual(steps[0].votes.count(), 1)
        self.assertEqual(steps[3].votes.count(), 1)

    def test_word_cloud_rejects_options(self):
        response = self._create_question(kind="word_cloud")
        self.assertEqual(response.status_code, 400)

    def test_word_cloud_allow_multiple_derived_from_max(self):
        # #88: max==1 -> single (allow_multiple False, batch forced off);
        # max 0/5 -> multiple.
        r1 = self._create_question(
            kind="word_cloud", text="<p>A?</p>", options=[],
            wordcloud_max_answers=1, allow_multiple=True, wordcloud_batch_submit=True,
        )
        self.assertEqual(r1.status_code, 201)
        q1 = Question.objects.get(pk=r1.json()["id"])
        self.assertFalse(q1.allow_multiple)
        self.assertFalse(q1.wordcloud_batch_submit)
        for max_val in (0, 5):
            r = self._create_question(
                kind="word_cloud", text="<p>A?</p>", options=[],
                wordcloud_max_answers=max_val, allow_multiple=False,
            )
            self.assertEqual(r.status_code, 201)
            self.assertTrue(Question.objects.get(pk=r.json()["id"]).allow_multiple)

    def test_positions_append_and_reorder(self):
        first = self._create_question().json()["id"]
        second = self._create_question().json()["id"]
        self.assertEqual(Question.objects.get(pk=second).position, 1)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/reorder/",
            {"question_ids": [second, first]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Question.objects.get(pk=second).position, 0)

    def test_reorder_rejects_incomplete_list(self):
        first = self._create_question().json()["id"]
        self._create_question()
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/reorder/",
            {"question_ids": [first]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_question_changes_touch_the_set(self):
        before = QuestionSet.objects.get(pk=self.question_set.pk).updated_at
        self._create_question()
        after = QuestionSet.objects.get(pk=self.question_set.pk).updated_at
        self.assertGreater(after, before)

    def _scaffold(self, **overrides):
        # Mimic "+ New question": create is exempt from content validation,
        # so this yields a saved question with empty text / blank options.
        payload = {
            "question_set": self.question_set.pk,
            "kind": "single_choice",
            "text": "",
            "options": [{"text": ""}, {"text": ""}],
        }
        payload.update(overrides)
        resp = self.client.post("/api/questions/", payload, content_type="application/json")
        self.assertEqual(resp.status_code, 201)  # create stays permissive
        return resp.json()["id"]

    def _patch(self, qid, **body):
        return self.client.patch(
            f"/api/questions/{qid}/", body, content_type="application/json"
        )

    def test_update_rejects_empty_text(self):
        qid = self._scaffold()
        resp = self._patch(qid, options=[{"text": "A"}, {"text": "B"}])
        self.assertEqual(resp.status_code, 400)
        self.assertIn("text", resp.json())

    def test_update_rejects_fewer_than_two_options(self):
        qid = self._scaffold()
        resp = self._patch(qid, text="<p>Q?</p>", options=[{"text": "only one"}])
        self.assertEqual(resp.status_code, 400)
        self.assertIn("options", resp.json())

    def test_update_rejects_blank_option_text(self):
        qid = self._scaffold()
        resp = self._patch(qid, text="<p>Q?</p>", options=[{"text": "A"}, {"text": "  "}])
        self.assertEqual(resp.status_code, 400)
        self.assertIn("options", resp.json())

    def test_update_accepts_valid_choice(self):
        qid = self._scaffold()
        resp = self._patch(qid, text="<p>Q?</p>", options=[{"text": "A"}, {"text": "B"}])
        self.assertEqual(resp.status_code, 200)

    def test_update_allows_image_only_option(self):
        qid = self._scaffold()
        resp = self._patch(
            qid,
            text="<p>Q?</p>",
            options=[{"text": "A"}, {"text": "", "image": "/media/uploads/x.webp"}],
        )
        self.assertEqual(resp.status_code, 200)

    def test_update_open_text_needs_text_not_options(self):
        qid = self._scaffold(kind="open_text", options=[])
        self.assertEqual(self._patch(qid, text="").status_code, 400)          # empty text
        self.assertEqual(self._patch(qid, text="<p>Prompt</p>").status_code, 200)

    def test_create_scaffold_still_allowed(self):
        # Guards the "+ New question" flow: empty create must NOT 400.
        self._scaffold()

    def test_update_rejects_clearing_canonical_via_map(self):
        qid = self._scaffold()
        # First give the question real canonical text, so the instance
        # fallback (used when the map's canonical key is absent) can't
        # accidentally mask a later explicit clear with old, valid text.
        setup = self._patch(
            qid,
            text="<p>Q?</p>",
            options=[{"text": "A"}, {"text": "B"}],
        )
        self.assertEqual(setup.status_code, 200)
        resp = self._patch(
            qid,
            text={"de": "", "en": "English only"},
            options=[{"text": "A"}, {"text": "B"}],
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("text", resp.json())

    def test_update_accepts_canonical_map_with_blank_secondary(self):
        qid = self._scaffold()
        resp = self._patch(
            qid,
            text={"de": "<p>Frage?</p>", "en": ""},
            options=[{"text": "A"}, {"text": "B"}],
        )
        self.assertEqual(resp.status_code, 200)


class TranslationStaleTests(ApiTestCase):
    """Stale question-text translation reporting (#91,
    basicbar_integrations.translation_sync / common.serializers.TranslationSyncMixin).
    """

    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(room=self.room, title="Termin 1")

    def _create(self, **overrides):
        payload = {
            "question_set": self.question_set.pk,
            "kind": "open_text",
            "text": {"de": "<p>Frage?</p>", "en": "<p>Question?</p>"},
        }
        payload.update(overrides)
        return self.client.post(
            "/api/questions/", payload, content_type="application/json"
        )

    def test_synced_on_create_reports_no_stale(self):
        response = self._create(synced_fields=["text"])
        self.assertEqual(response.status_code, 201)
        qid = response.json()["id"]
        self.assertEqual(
            self.client.get(f"/api/questions/{qid}/").json()["translation_stale"], {}
        )

    def test_editing_one_language_marks_the_other_stale(self):
        qid = self._create(synced_fields=["text"]).json()["id"]
        # Accepting an AI rephrase of the German text only (the realistic
        # trigger, #91), leaving the still-correct-for-the-old-wording
        # English untouched.
        question = Question.objects.get(pk=qid)
        question.text_de = "<p>Neue Frage?</p>"
        question.save()
        data = self.client.get(f"/api/questions/{qid}/").json()
        self.assertEqual(data["translation_stale"], {"text": ["en"]})

    def test_synced_fields_re_baselines(self):
        qid = self._create(synced_fields=["text"]).json()["id"]
        question = Question.objects.get(pk=qid)
        question.text_de = "<p>Neue Frage?</p>"
        question.save()
        resp = self.client.patch(
            f"/api/questions/{qid}/",
            {"synced_fields": ["text"]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        data = self.client.get(f"/api/questions/{qid}/").json()
        self.assertEqual(data["translation_stale"], {})

    def test_question_without_recorded_sync_is_never_stale(self):
        qid = self._create().json()["id"]  # no synced_fields -> no baseline
        data = self.client.get(f"/api/questions/{qid}/").json()
        self.assertEqual(data["translation_stale"], {})

    def test_synced_fields_is_write_only_and_ignores_unknown_names(self):
        response = self._create(synced_fields=["text"])
        self.assertNotIn("synced_fields", response.json())
        qid = response.json()["id"]
        self.assertNotIn(
            "synced_fields", self.client.get(f"/api/questions/{qid}/").json()
        )
        resp = self.client.patch(
            f"/api/questions/{qid}/",
            {"synced_fields": ["not_a_real_field"]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            self.client.get(f"/api/questions/{qid}/").json()["translation_stale"], {}
        )


class BeforeAfterTests(ApiTestCase):
    """Vorher-Nachher-Fragen (#54)."""

    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(room=self.room, title="Termin 1")

    def _create(self, **overrides):
        payload = {
            "question_set": self.question_set.pk,
            "kind": "single_choice",
            "text": "<p>Frage?</p>",
            "options": [
                {"text": "A", "is_correct": True},
                {"text": "B", "is_correct": False},
            ],
        }
        payload.update(overrides)
        return self.client.post(
            "/api/questions/", payload, content_type="application/json"
        ).json()

    def _add_after(self, question_id):
        return self.client.post(f"/api/questions/{question_id}/add-after/")

    def test_add_after_creates_linked_copy_at_end(self):
        before = self._create()
        # A second question so the after-question must land past it.
        self._create()
        response = self._add_after(before["id"])
        self.assertEqual(response.status_code, 201)
        after = response.json()
        self.assertEqual(after["before_question"], before["id"])
        self.assertTrue(after["is_after"])
        after_obj = Question.objects.get(pk=after["id"])
        self.assertEqual(after_obj.position, 2)  # appended at the end
        self.assertEqual(
            [o["text"] for o in after["options"]],
            [{"de": "A", "en": ""}, {"de": "B", "en": ""}],
        )
        # The before-question now reports its after-question.
        before_refetched = self.client.get(f"/api/questions/{before['id']}/").json()
        self.assertEqual(before_refetched["after_question"], after["id"])
        self.assertFalse(before_refetched["is_after"])

    def test_add_after_rejects_text_kind(self):
        wc = self._create(kind="word_cloud", options=[])
        self.assertEqual(self._add_after(wc["id"]).status_code, 400)

    def test_add_after_rejected_when_after_already_exists(self):
        before = self._create()
        self.assertEqual(self._add_after(before["id"]).status_code, 201)
        self.assertEqual(self._add_after(before["id"]).status_code, 400)

    def test_add_after_rejected_on_an_after_question(self):
        before = self._create()
        after_id = self._add_after(before["id"]).json()["id"]
        self.assertEqual(self._add_after(after_id).status_code, 400)

    def test_deleting_before_cascades_to_after(self):
        before = self._create()
        after_id = self._add_after(before["id"]).json()["id"]
        self.client.delete(f"/api/questions/{before['id']}/")
        self.assertFalse(Question.objects.filter(pk=after_id).exists())

    def test_deleting_after_keeps_before(self):
        before = self._create()
        after_id = self._add_after(before["id"]).json()["id"]
        self.client.delete(f"/api/questions/{after_id}/")
        self.assertTrue(Question.objects.filter(pk=before["id"]).exists())

    def test_editing_before_syncs_after_content_and_options(self):
        before = self._create()
        after_id = self._add_after(before["id"]).json()["id"]
        keep_id = Question.objects.get(pk=before["id"]).options.first().pk
        self.client.put(
            f"/api/questions/{before['id']}/",
            {
                "question_set": self.question_set.pk,
                "kind": "single_choice",
                "text": "<p>Neu?</p>",
                "options": [
                    {"id": keep_id, "text": "X", "is_correct": False},
                    {"text": "Y", "is_correct": True},
                    {"text": "Z", "is_correct": False},
                ],
            },
            content_type="application/json",
        )
        after = Question.objects.get(pk=after_id)
        self.assertEqual(after.text_de, "<p>Neu?</p>")
        self.assertEqual(
            [(o.text, o.is_correct) for o in after.options.all()],
            [("X", False), ("Y", True), ("Z", False)],
        )


class ImageUploadTests(ApiTestCase):
    def _png(self):
        buffer = io.BytesIO()
        Image.new("RGB", (4, 4), "green").save(buffer, format="PNG")
        buffer.seek(0)
        buffer.name = "test.png"
        return buffer

    def test_upload_returns_media_url(self):
        response = self.client.post("/api/images/", {"file": self._png()})
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["url"].startswith("/media/question-images/"))

    def test_rejects_non_images(self):
        fake = io.BytesIO(b"not an image")
        fake.name = "evil.png"
        response = self.client.post("/api/images/", {"file": fake})
        self.assertEqual(response.status_code, 400)

    def test_requires_login(self):
        self.client.logout()
        response = self.client.post("/api/images/", {"file": self._png()})
        self.assertEqual(response.status_code, 403)

    def _big_photo(self):
        # sigma=80 (as in the Task-1 unit-test fixture) makes the noise PNG
        # ~7.6 MB, over the endpoint's own 5 MB gate before normalization
        # ever runs; sigma=20 keeps it a genuinely large, incompressible
        # 2000x1500 photo (well above the 1600px downscale threshold) while
        # staying safely under 5 MB (~4.3 MB, consistently across runs).
        buffer = io.BytesIO()
        Image.effect_noise((2000, 1500), 20).convert("RGB").save(
            buffer, format="PNG", optimize=True
        )
        buffer.seek(0)
        buffer.name = "photo.png"
        return buffer

    def test_upload_stores_webp_and_downscales(self):
        response = self.client.post("/api/images/", {"file": self._big_photo()})
        self.assertEqual(response.status_code, 201)
        url = response.json()["url"]
        self.assertTrue(url.startswith("/media/question-images/"))
        self.assertTrue(url.endswith(".webp"))
        stored = UploadedImage.objects.latest("id")
        with Image.open(stored.file.path) as out:
            self.assertEqual(out.format, "WEBP")
            self.assertEqual(max(out.size), 1600)

    def test_animated_gif_kept_as_gif(self):
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
        frames = [Image.new("RGB", (80, 80), color) for color in colors]
        buffer = io.BytesIO()
        frames[0].save(buffer, format="GIF", save_all=True, append_images=frames[1:])
        buffer.seek(0)
        buffer.name = "anim.gif"
        response = self.client.post("/api/images/", {"file": buffer})
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["url"].endswith(".gif"))

    def test_rejects_oversize_before_processing(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        big = SimpleUploadedFile(
            "big.png", b"\0" * (5 * 1024 * 1024 + 1), content_type="image/png"
        )
        response = self.client.post("/api/images/", {"file": big})
        self.assertEqual(response.status_code, 400)


class TransferTests(ApiTestCase):
    """Duplicate/export/import (transfer.py), map-aware (#33 MR2 Task 6).

    Fixtures set the ``_de``/``_en`` columns explicitly rather than the bare
    accessor — the active language while these are created (no request in
    progress) is settings.LANGUAGE_CODE ("en"), not the content-canonical
    "de", so a bare-accessor write would land the fixture's content in the
    wrong column for a meaningful bilingual round-trip test.
    """

    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(
            room=self.room, title_de="Termin 1", title_en="Session 1",
        )
        question = Question.objects.create(
            question_set=self.question_set,
            kind="single_choice",
            text_de="<p>2+2?</p>", text_en="<p>What is 2+2?</p>",
            shuffle_options=True,
        )
        AnswerOption.objects.create(
            question=question, text_de="4", text_en="four", is_correct=True
        )
        AnswerOption.objects.create(
            question=question, text_de="5", text_en="five", position=1
        )
        Question.objects.create(
            question_set=self.question_set, kind="word_cloud",
            text_de="<p>Wort?</p>", text_en="<p>Word?</p>", position=1,
        )

    def test_duplicate_into_same_room(self):
        # Reproduce an English-UI author (active language "en") duplicating
        # a set: the "duplicate" API action must build the "(Kopie)" suffix
        # from the CANONICAL (title_de) column, never the bare accessor
        # (which follows the active UI language) — otherwise the English
        # active-language text would leak into title_de and the correct
        # German canonical title would be lost.
        with translation.override("en"):
            response = self.client.post(
                f"/api/question-sets/{self.question_set.pk}/duplicate/",
                {},
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 201)
        clone = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertEqual(clone.title_de, "Termin 1 (Kopie)")
        self.assertEqual(clone.title_en, "Session 1")
        self.assertEqual(clone.room, self.room)
        self.assertEqual(clone.questions.count(), 2)
        self.assertEqual(clone.questions.first().options.count(), 2)

    def test_duplicate_copies_all_language_columns(self):
        """duplicate_set() itself — not the view's single-string title
        override — copies every translatable field's both language columns
        verbatim (#33 MR2 Task 6)."""
        from .transfer import duplicate_set

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        clone = duplicate_set(self.question_set, target)
        self.assertEqual(clone.title_de, "Termin 1")
        self.assertEqual(clone.title_en, "Session 1")
        question = clone.questions.get(kind="single_choice")
        self.assertEqual(question.text_de, "<p>2+2?</p>")
        self.assertEqual(question.text_en, "<p>What is 2+2?</p>")
        option = question.options.get(text_de="4")
        self.assertEqual(option.text_en, "four")

    def test_duplicate_same_room_suffixes_canonical_title_only(self):
        # Uniqueness dedupes on the canonical column (Task 6 fix); the
        # non-canonical title is copied as-is, never suffixed.
        from .transfer import duplicate_set

        clone = duplicate_set(self.question_set, self.room)
        self.assertEqual(clone.title_de, "Termin 1 (2)")
        self.assertEqual(clone.title_en, "Session 1")

    def test_duplicate_copies_reveal_override(self):
        # #28: the per-question reveal override survives duplication.
        q = self.question_set.questions.first()
        q.reveal_answers = "immediately"
        q.save(update_fields=["reveal_answers"])
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/duplicate/",
            {},
            content_type="application/json",
        )
        clone = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertEqual(
            clone.questions.first().reveal_answers, "immediately"
        )

    def test_duplicate_into_other_own_room(self):
        target = Room.objects.create(title="Neues Semester")
        target.owners.add(self.owner)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/duplicate/",
            {"room": target.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(QuestionSet.objects.filter(room=target).count(), 1)
        # Original bleibt unverändert.
        self.assertEqual(self.question_set.questions.count(), 2)

    def test_duplicate_into_foreign_room_rejected(self):
        foreign = Room.objects.create(title="Fremd")
        foreign.owners.add(self.other)
        response = self.client.post(
            f"/api/question-sets/{self.question_set.pk}/duplicate/",
            {"room": foreign.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_export_import_roundtrip(self):
        """v2 export→import round-trip: both languages of every
        translatable field survive (#33 MR2 Task 6)."""
        export = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/export/"
        )
        self.assertEqual(export.status_code, 200)
        self.assertIn("attachment", export["Content-Disposition"])
        data = export.json()
        self.assertEqual(data["format"], "abstimmbar-set-v2")
        self.assertEqual(data["title"], {"de": "Termin 1", "en": "Session 1"})

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        response = self.client.post(
            f"/api/rooms/{target.pk}/import-set/", data, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        imported = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertEqual(imported.title_de, "Termin 1")
        self.assertEqual(imported.title_en, "Session 1")
        self.assertEqual(imported.questions.count(), 2)
        first = imported.questions.get(kind="single_choice")
        self.assertEqual(first.text_de, "<p>2+2?</p>")
        self.assertEqual(first.text_en, "<p>What is 2+2?</p>")
        self.assertTrue(first.shuffle_options)
        option = first.options.get(text_de="4")
        self.assertTrue(option.is_correct)
        self.assertEqual(option.text_en, "four")

    def test_ordering_option_order_survives_export_import(self):
        """An `ordering` question has no separate "correct order" column —
        the authored solution is AnswerOption.position itself (#72 T1). This
        must survive export -> import unchanged: same option texts at the
        same positions, in a fresh room (#72 T10)."""
        from .transfer import export_set, import_set

        oq = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.ORDERING,
            text_de="<p>Reihenfolge?</p>", text_en="<p>Order?</p>", position=2,
        )
        AnswerOption.objects.create(
            question=oq, text_de="Erst", text_en="First", position=0
        )
        AnswerOption.objects.create(
            question=oq, text_de="Zweitens", text_en="Second", position=1
        )
        AnswerOption.objects.create(
            question=oq, text_de="Drittens", text_en="Third", position=2
        )

        data = export_set(self.question_set)
        exported = next(q for q in data["questions"] if q["kind"] == "ordering")
        self.assertEqual(
            [o["text"]["de"] for o in exported["options"]],
            ["Erst", "Zweitens", "Drittens"],
        )

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        imported = import_set(target, data)
        imported_q = imported.questions.get(kind="ordering")
        self.assertEqual(imported_q.kind, "ordering")
        self.assertEqual(
            list(
                imported_q.options.order_by("position").values_list(
                    "text_de", flat=True
                )
            ),
            ["Erst", "Zweitens", "Drittens"],
        )

    def test_import_sanitizes_and_validates(self):
        """A v1 (legacy plain-string) import file lands every translatable
        value in the canonical (de) column only; en stays empty (#33 MR2
        Task 6)."""
        payload = {
            "format": "abstimmbar-set-v1",
            "title": "Böse",
            "questions": [
                {
                    "kind": "single_choice",
                    "text": '<p>Hi<script>alert(1)</script></p>',
                    "options": [{"text": "a", "is_correct": False}],
                }
            ],
        }
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", payload, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        question_set = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertEqual(question_set.title_de, "Böse")
        self.assertIsNone(question_set.title_en)
        question = question_set.questions.get()
        self.assertEqual(question.text_de, "<p>Hi</p>")
        self.assertIsNone(question.text_en)
        option = question.options.get()
        self.assertEqual(option.text_de, "a")
        self.assertIsNone(option.text_en)

        bad = {"format": "somethingelse"}
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", bad, content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)

    def test_import_v2_sanitizes_non_canonical_language(self):
        """A v2 file's per-language map is sanitized in EVERY language, not
        just the canonical one — a <script> hidden in the "en" entry must
        not survive import."""
        payload = {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Hi", "en": "Hi"},
            "questions": [
                {
                    "kind": "single_choice",
                    "text": {
                        "de": "<p>Hi</p>",
                        "en": "<p>x<script>alert(1)</script></p>",
                    },
                    "options": [{"text": {"de": "a", "en": "a"}, "is_correct": False}],
                }
            ],
        }
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", payload, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        question_set = QuestionSet.objects.get(pk=response.json()["id"])
        question = question_set.questions.get()
        self.assertEqual(question.text_de, "<p>Hi</p>")
        self.assertNotIn("<script", question.text_en)
        self.assertEqual(question.text_en, "<p>x</p>")

    def test_import_sanitizes_set_description(self):
        """The set-level ``description`` is sanitized per language on import
        too, not just question ``text`` (#49) — a <script> tag is stripped
        and an external <img> src is dropped, in every language."""
        payload = {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Hi", "en": "Hi"},
            "description": {
                "de": (
                    '<p>Hallo<script>alert(1)</script>'
                    '<img src="https://evil.example/x.png"></p>'
                ),
                "en": (
                    '<p>Hi<script>alert(2)</script>'
                    '<img src="https://evil.example/y.png"></p>'
                ),
            },
            "questions": [
                {
                    "kind": "single_choice",
                    "text": {"de": "<p>Hi</p>", "en": "<p>Hi</p>"},
                    "options": [{"text": {"de": "a", "en": "a"}, "is_correct": False}],
                }
            ],
        }
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", payload, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        question_set = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertNotIn("<script", question_set.description_de)
        self.assertNotIn("evil.example", question_set.description_de)
        self.assertEqual(question_set.description_de, "<p>Hallo<img></p>")
        self.assertNotIn("<script", question_set.description_en)
        self.assertNotIn("evil.example", question_set.description_en)
        self.assertEqual(question_set.description_en, "<p>Hi<img></p>")

    def test_import_v2_blank_non_canonical_language(self):
        """A v2 file may explicitly leave a non-canonical language blank;
        the column ends up empty, not the placeholder string "None" or
        similar."""
        payload = {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Hi", "en": ""},
            "questions": [
                {
                    "kind": "single_choice",
                    "text": {"de": "<p>Hi</p>", "en": ""},
                    "options": [{"text": {"de": "a", "en": ""}, "is_correct": False}],
                }
            ],
        }
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", payload, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        question_set = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertEqual(question_set.title_de, "Hi")
        self.assertFalse(question_set.title_en)
        question = question_set.questions.get()
        self.assertFalse(question.text_en)

    def test_import_requires_room_owner(self):
        foreign = Room.objects.create(title="Fremd")
        foreign.owners.add(self.other)
        response = self.client.post(
            f"/api/rooms/{foreign.pk}/import-set/",
            {"format": "abstimmbar-set-v1", "title": "x", "questions": []},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_duplicate_preserves_set_type(self):
        """#75 final review: duplicate_set() must carry the set's ``type``
        onto the clone — before this fix it silently fell back to the
        model's default (live_poll), turning a duplicated Quiz-Block into a
        Live poll."""
        from .transfer import duplicate_set

        self.question_set.type = QuestionSet.SetType.SELF_PACED
        self.question_set.save(update_fields=["type"])
        clone = duplicate_set(self.question_set, self.room)
        self.assertEqual(clone.type, QuestionSet.SetType.SELF_PACED)

    def test_export_import_roundtrip_preserves_set_type(self):
        """export_set() includes ``type``, and import_set() applies it —
        a self_paced set survives an export/import round-trip as
        self_paced, not the default live_poll."""
        from .transfer import export_set, import_set

        self.question_set.type = QuestionSet.SetType.SELF_PACED
        self.question_set.save(update_fields=["type"])
        data = export_set(self.question_set)
        self.assertEqual(data["type"], QuestionSet.SetType.SELF_PACED)

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        imported = import_set(target, data)
        self.assertEqual(imported.type, QuestionSet.SetType.SELF_PACED)

    def test_import_defaults_type_when_missing_or_invalid(self):
        """A foreign/legacy file without a ``type`` key, or with an invalid
        one, imports as live_poll rather than erroring out."""
        from .transfer import import_set

        base_payload = {
            "format": "abstimmbar-set-v1",
            "title": "x",
            "questions": [],
        }
        imported = import_set(self.room, dict(base_payload))
        self.assertEqual(imported.type, QuestionSet.SetType.LIVE_POLL)

        imported_invalid = import_set(
            self.room, {**base_payload, "title": "y", "type": "not-a-type"}
        )
        self.assertEqual(imported_invalid.type, QuestionSet.SetType.LIVE_POLL)

    def test_import_drops_traversal_option_images(self):
        """Option images from a foreign file keep only genuine /media/ paths;
        encoded dot segments, control characters, query strings and
        over-long URLs are dropped (basicbar-integrations 0.2.1)."""
        from .transfer import import_set

        images = [
            "/media/questions/ok.png",
            "/media/%2e%2e/%2e%2e/etc/passwd",
            "/media/a%252e%252e/x.png",
            "/media/a\t/../../secret.png",
            "/media/x.png?..",
            "/media/" + "a" * 300 + ".png",
        ]
        imported = import_set(self.room, {
            "format": "abstimmbar-set-v1",
            "title": "images",
            "questions": [{
                "kind": "single_choice",
                "text": "<p>Q</p>",
                "options": [{"text": str(i), "image": url} for i, url in enumerate(images)],
            }],
        })
        stored = list(
            AnswerOption.objects.filter(question__question_set=imported)
            .order_by("position").values_list("image", flat=True)
        )
        self.assertEqual(stored, ["/media/questions/ok.png", "", "", "", "", ""])

    def test_duplicate_preserves_quiz_time_limit(self):
        """#75 final review: duplicate_set() must carry ``quiz_time_limit``
        onto the clone, like it already does for ``type``."""
        from .transfer import duplicate_set

        self.question_set.type = QuestionSet.SetType.SELF_PACED
        self.question_set.quiz_time_limit = 300
        self.question_set.save(update_fields=["type", "quiz_time_limit"])
        clone = duplicate_set(self.question_set, self.room)
        self.assertEqual(clone.quiz_time_limit, 300)

    def test_export_import_roundtrip_preserves_quiz_time_limit(self):
        """export_set() includes ``quiz_time_limit``, and import_set()
        applies it for a self_paced set."""
        from .transfer import export_set, import_set

        self.question_set.type = QuestionSet.SetType.SELF_PACED
        self.question_set.quiz_time_limit = 300
        self.question_set.save(update_fields=["type", "quiz_time_limit"])
        data = export_set(self.question_set)
        self.assertEqual(data["quiz_time_limit"], 300)

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        imported = import_set(target, data)
        self.assertEqual(imported.quiz_time_limit, 300)

    def test_export_import_roundtrip_preserves_model_solution_and_feedback(self):
        """A free-text question's model solution and participant-feedback
        switch survive export/import (they were silently dropped before)."""
        from .transfer import export_set, import_set

        Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.OPEN_TEXT,
            text_de="Was zeichnet eine anonyme Umfrage aus?",
            model_solution="Keine Rückschlüsse auf die antwortende Person.",
            participant_feedback=True,
            ai_evaluate=True,
            position=99,
        )
        data = export_set(self.question_set)
        item = next(q for q in data["questions"] if q["kind"] == Question.Kind.OPEN_TEXT)
        self.assertEqual(item["model_solution"], "Keine Rückschlüsse auf die antwortende Person.")
        self.assertTrue(item["participant_feedback"])

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        imported = import_set(target, data)
        q = imported.questions.get(kind=Question.Kind.OPEN_TEXT)
        self.assertEqual(q.model_solution, "Keine Rückschlüsse auf die antwortende Person.")
        self.assertTrue(q.participant_feedback)

    def test_import_without_model_solution_keys_uses_defaults(self):
        """Older export files lack the keys → empty solution, feedback off."""
        from .transfer import import_set

        imported = import_set(
            self.room,
            {
                "format": "abstimmbar-set-v1",
                "title": "x",
                "questions": [{"kind": "open_text", "text": {"de": "Frage"}, "options": []}],
            },
        )
        q = imported.questions.get()
        self.assertEqual(q.model_solution, "")
        self.assertFalse(q.participant_feedback)

    def test_import_rejects_invalid_quiz_time_limit(self):
        """A foreign/legacy file with an implausible ``quiz_time_limit``
        (negative, non-int, or out of range) imports as None rather than
        erroring out or storing garbage."""
        from .transfer import import_set

        base_payload = {
            "format": "abstimmbar-set-v1",
            "title": "x",
            "type": QuestionSet.SetType.SELF_PACED,
            "questions": [],
        }
        for bad in (-1, "x", 0, 24 * 3600 + 1):
            imported = import_set(self.room, {**base_payload, "quiz_time_limit": bad})
            self.assertIsNone(imported.quiz_time_limit)

    def test_import_ignores_quiz_time_limit_for_non_self_paced_type(self):
        """A ``quiz_time_limit`` carried on a non-self_paced payload (e.g. a
        hand-edited or legacy file) is dropped — the field is only
        meaningful for self_paced sets."""
        from .transfer import import_set

        imported = import_set(
            self.room,
            {
                "format": "abstimmbar-set-v1",
                "title": "x",
                "type": QuestionSet.SetType.LIVE_POLL,
                "quiz_time_limit": 300,
                "questions": [],
            },
        )
        self.assertIsNone(imported.quiz_time_limit)

    def test_duplicate_preserves_present_results_after(self):
        # #75: duplicate_set() must carry present_results_after onto the
        # clone, including a non-default (False) value.
        from .transfer import duplicate_set

        self.question_set.present_results_after = False
        self.question_set.save(update_fields=["present_results_after"])
        clone = duplicate_set(self.question_set, self.room)
        self.assertFalse(clone.present_results_after)

    def test_export_import_roundtrip_preserves_present_results_after(self):
        """export_set() includes ``present_results_after``, and
        import_set() applies a False value rather than silently reverting
        to the field's True default."""
        from .transfer import export_set, import_set

        self.question_set.present_results_after = False
        self.question_set.save(update_fields=["present_results_after"])
        data = export_set(self.question_set)
        self.assertFalse(data["present_results_after"])

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        imported = import_set(target, data)
        self.assertFalse(imported.present_results_after)

    def test_import_defaults_present_results_after_when_missing(self):
        """A foreign/legacy file without ``present_results_after`` imports
        as True (the field's default), not False."""
        from .transfer import import_set

        imported = import_set(
            self.room,
            {
                "format": "abstimmbar-set-v1",
                "title": "y",
                "type": QuestionSet.SetType.SELF_PACED,
                "questions": [],
            },
        )
        self.assertTrue(imported.present_results_after)

    def test_duplicate_preserves_allow_back_navigation_and_shuffle_questions(self):
        # #75 (Quiz-Block Phase 2): duplicate_set() must carry both new
        # fields onto the clone, including non-default values.
        from .transfer import duplicate_set

        self.question_set.allow_back_navigation = False
        self.question_set.shuffle_questions = True
        self.question_set.save(update_fields=["allow_back_navigation", "shuffle_questions"])
        clone = duplicate_set(self.question_set, self.room)
        self.assertFalse(clone.allow_back_navigation)
        self.assertTrue(clone.shuffle_questions)

    def test_export_import_roundtrip_preserves_allow_back_navigation_and_shuffle_questions(self):
        """export_set() includes both fields, and import_set() applies
        non-default values rather than silently reverting to the field
        defaults."""
        from .transfer import export_set, import_set

        self.question_set.allow_back_navigation = False
        self.question_set.shuffle_questions = True
        self.question_set.save(update_fields=["allow_back_navigation", "shuffle_questions"])
        data = export_set(self.question_set)
        self.assertFalse(data["allow_back_navigation"])
        self.assertTrue(data["shuffle_questions"])

        target = Room.objects.create(title="Anderer Raum")
        target.owners.add(self.owner)
        imported = import_set(target, data)
        self.assertFalse(imported.allow_back_navigation)
        self.assertTrue(imported.shuffle_questions)

    def test_import_defaults_allow_back_navigation_and_shuffle_questions_when_missing(self):
        """A foreign/legacy file without these keys imports with the
        field defaults (True / False), not their opposite."""
        from .transfer import import_set

        imported = import_set(
            self.room,
            {
                "format": "abstimmbar-set-v1",
                "title": "z",
                "type": QuestionSet.SetType.SELF_PACED,
                "questions": [],
            },
        )
        self.assertTrue(imported.allow_back_navigation)
        self.assertFalse(imported.shuffle_questions)


class CopyQuestionsTests(ApiTestCase):
    """QuestionSetViewSet.copy_questions (#87): deep-copy questions from any
    of the user's sets into a target set, no results, appended in order."""

    def setUp(self):
        super().setUp()
        self.source = QuestionSet.objects.create(room=self.room, title="Quelle")
        self.q1 = Question.objects.create(
            question_set=self.source, kind="single_choice", text="Frage 1",
        )
        AnswerOption.objects.create(question=self.q1, text="A", is_correct=True)
        AnswerOption.objects.create(question=self.q1, text="B", position=1)
        self.q2 = Question.objects.create(
            question_set=self.source, kind="word_cloud", text="Frage 2", position=1,
        )
        self.target = QuestionSet.objects.create(room=self.room, title="Ziel")
        self.existing = Question.objects.create(
            question_set=self.target, kind="open_text", text="Bestehende Frage",
        )

    def copy(self, question_ids, target=None):
        return self.client.post(
            f"/api/question-sets/{(target or self.target).pk}/copy-questions/",
            {"question_ids": question_ids},
            content_type="application/json",
        )

    def test_copy_two_questions_appends_in_order(self):
        response = self.copy([self.q1.pk, self.q2.pk])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json(), {"copied": 2})

        self.target.refresh_from_db()
        self.assertEqual(self.target.questions.count(), 3)
        copies = list(self.target.questions.order_by("position"))
        self.assertEqual(copies[0].pk, self.existing.pk)
        self.assertEqual(copies[1].text, "Frage 1")
        self.assertEqual(copies[1].position, 1)
        self.assertEqual(copies[2].text, "Frage 2")
        self.assertEqual(copies[2].position, 2)

        # Originals in the source set are untouched.
        self.assertEqual(self.source.questions.count(), 2)
        self.assertEqual(Question.objects.get(pk=self.q1.pk).text, "Frage 1")

        # Options were deep-copied: same texts/count, distinct objects.
        copied_q1 = copies[1]
        self.assertEqual(copied_q1.options.count(), 2)
        self.assertNotEqual(
            set(copied_q1.options.values_list("pk", flat=True)),
            set(self.q1.options.values_list("pk", flat=True)),
        )
        self.assertEqual(
            list(copied_q1.options.order_by("position").values_list("text", flat=True)),
            ["A", "B"],
        )

    def test_copy_does_not_bring_votes(self):
        from live.models import ParticipantToken, Run, Vote

        run = Run.objects.create(question_set=self.source)
        token = ParticipantToken.objects.create(room=self.room)
        Vote.objects.create(run=run, question=self.q1, token=token, text="x")

        response = self.copy([self.q1.pk])
        self.assertEqual(response.status_code, 201)
        copy = self.target.questions.order_by("position").last()
        self.assertFalse(copy.votes.exists())
        self.assertTrue(self.q1.votes.exists())

    def test_cannot_copy_from_a_set_one_does_not_own(self):
        foreign_room = Room.objects.create(title="Fremd")
        foreign_room.owners.add(self.other)
        foreign_set = QuestionSet.objects.create(room=foreign_room, title="Fremd")
        foreign_question = Question.objects.create(
            question_set=foreign_set, kind="open_text", text="Geheim",
        )
        response = self.copy([foreign_question.pk])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.target.questions.count(), 1)

    def test_invalid_or_missing_ids_rejected(self):
        response = self.copy([self.q1.pk, 999999])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.target.questions.count(), 1)

    def test_empty_or_non_list_question_ids_rejected(self):
        self.assertEqual(self.copy([]).status_code, 400)
        response = self.client.post(
            f"/api/question-sets/{self.target.pk}/copy-questions/",
            {"question_ids": self.q1.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.target.questions.count(), 1)

    def test_non_integer_ids_rejected(self):
        # A stray string must yield a clean 400, not a 500 from pk__in.
        response = self.copy(["abc"])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.target.questions.count(), 1)

    def test_copy_into_live_poll_set_allows_any_kind(self):
        # Regression: a live_poll target (the default type) is unrestricted.
        likert = Question.objects.create(
            question_set=self.source, kind="likert", text="Wie zufrieden?",
        )
        response = self.copy([likert.pk])
        self.assertEqual(response.status_code, 201)
        self.assertTrue(self.target.questions.filter(text="Wie zufrieden?").exists())

    def test_copy_kind_not_allowed_in_self_check_set(self):
        check_set = QuestionSet.objects.create(
            room=self.room, title="Kontrolle", type=QuestionSet.SetType.SELF_CHECK
        )
        likert = Question.objects.create(
            question_set=self.source, kind="likert", text="Wie zufrieden?",
        )
        response = self.copy([likert.pk], target=check_set)
        self.assertEqual(response.status_code, 400)
        self.assertIn("not allowed", response.json()["detail"])
        self.assertEqual(check_set.questions.count(), 0)

    def test_copy_open_text_without_model_solution_into_self_check_set(self):
        # Allowed — the editor warns, it does not block (#75).
        check_set = QuestionSet.objects.create(
            room=self.room, title="Kontrolle", type=QuestionSet.SetType.SELF_CHECK
        )
        open_text = Question.objects.create(
            question_set=self.source, kind="open_text", text="Erkläre X.",
        )
        response = self.copy([open_text.pk], target=check_set)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(check_set.questions.count(), 1)

    def test_copy_open_text_with_model_solution_into_self_check_set(self):
        check_set = QuestionSet.objects.create(
            room=self.room, title="Kontrolle", type=QuestionSet.SetType.SELF_CHECK
        )
        open_text = Question.objects.create(
            question_set=self.source, kind="open_text", text="Erkläre X.",
            model_solution="Weil Y.",
        )
        response = self.copy([open_text.pk], target=check_set)
        self.assertEqual(response.status_code, 201)
        self.assertTrue(check_set.questions.filter(text="Erkläre X.").exists())

    def test_duplicate_carries_model_solution_and_feedback(self):
        from rooms.transfer import duplicate_question
        src = Question.objects.create(
            question_set=self.source, kind="open_text", text="Q",
            model_solution="Paris", participant_feedback=True,
        )
        clone = duplicate_question(src, question_set=self.target, section=None, position=5)
        self.assertEqual(clone.model_solution, "Paris")
        self.assertTrue(clone.participant_feedback)

    @patch("rooms.views.ai.is_enabled", return_value=True)
    def test_copy_open_text_into_self_check_activates_ai(self, _m):
        check_set = QuestionSet.objects.create(
            room=self.room, title="K", type=QuestionSet.SetType.SELF_CHECK
        )
        src = Question.objects.create(
            question_set=self.source, kind="open_text", text="Q", model_solution="Paris",
        )
        resp = self.copy([src.pk], target=check_set)
        self.assertEqual(resp.status_code, 201)
        clone = check_set.questions.get()
        self.assertTrue(clone.ai_evaluate)
        self.assertTrue(clone.participant_feedback)
        self.assertEqual(clone.model_solution, "Paris")

    @patch("rooms.views.ai.is_enabled", return_value=False)
    def test_copy_into_self_check_without_ai_still_sets_feedback(self, _m):
        check_set = QuestionSet.objects.create(
            room=self.room, title="K2", type=QuestionSet.SetType.SELF_CHECK
        )
        src = Question.objects.create(
            question_set=self.source, kind="open_text", text="Q",
        )
        self.copy([src.pk], target=check_set)
        clone = check_set.questions.get()
        self.assertFalse(clone.ai_evaluate)      # no provider → don't enable AI
        self.assertTrue(clone.participant_feedback)


class SearchTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.set_a = QuestionSet.objects.create(room=self.room, title="Photosynthese")
        question = Question.objects.create(
            question_set=self.set_a, kind="single_choice", text="<p>Was ist Chlorophyll?</p>"
        )
        AnswerOption.objects.create(question=question, text="Blattgrün")
        self.set_b = QuestionSet.objects.create(room=self.room, title="Zellbiologie")

    def _search(self, term):
        # These sets are created via bare ORM (setUp, no override, active
        # language "en"), so their content lands in title_en; resolve_
        # translated_text picks whichever language actually holds it rather
        # than hard-coding "en" here.
        payload = self.client.get(f"/api/question-sets/?search={term}").json()
        return [resolve_translated_text(row["title"]) for row in payload["results"]]

    def test_search_title_question_and_answer(self):
        self.assertEqual(self._search("photo"), ["Photosynthese"])
        self.assertEqual(self._search("chlorophyll"), ["Photosynthese"])
        self.assertEqual(self._search("blattgr"), ["Photosynthese"])
        self.assertEqual(self._search("zell"), ["Zellbiologie"])
        self.assertEqual(self._search("gibtesnicht"), [])

    def test_search_no_duplicates(self):
        # Term matches title AND question AND option → still one row.
        question = self.set_a.questions.get()
        question.text = "<p>Photosynthese?</p>"
        question.save()
        AnswerOption.objects.create(question=question, text="Photosynthese")
        self.assertEqual(self._search("photosynthese"), ["Photosynthese"])

    def test_search_finds_content_regardless_of_active_ui_language(self):
        # Regression: Q(title__icontains=q) is rewritten by
        # django-modeltranslation to the *active UI language* column
        # (title_en/title_de). A search request made under an active
        # English UI used to silently search only title_en — missing
        # German-authored content (and vice versa) — even though display
        # of the very same row already falls back to the other language
        # (#33 MR2 follow-up).
        with translation.override("de"):
            QuestionSet.objects.create(room=self.room, title="Deutschlandkunde")
        response = self.client.get(
            "/api/question-sets/?search=deutschland", HTTP_ACCEPT_LANGUAGE="en"
        )
        titles = [
            resolve_translated_text(row["title"]) for row in response.json()["results"]
        ]
        self.assertIn("Deutschlandkunde", titles)

        # Symmetric case: English-authored content (active language is
        # "en" by default outside a request/override, see ApiTestCase)
        # found while searching under an active German UI.
        QuestionSet.objects.create(room=self.room, title="World History")
        response = self.client.get(
            "/api/question-sets/?search=history", HTTP_ACCEPT_LANGUAGE="de"
        )
        titles = [
            resolve_translated_text(row["title"]) for row in response.json()["results"]
        ]
        self.assertIn("World History", titles)


class GlobalSearchTests(ApiTestCase):
    """Start-page search across rooms, sets and questions (/api/search/)."""

    def setUp(self):
        super().setUp()
        self.room.title = "Photosynthese-Vorlesung"
        self.room.save()
        self.set_a = QuestionSet.objects.create(room=self.room, title="Grundlagen")
        question = Question.objects.create(
            question_set=self.set_a, kind="single_choice",
            text="<p>Was ist <strong>Chlorophyll</strong>?</p>",
        )
        AnswerOption.objects.create(question=question, text="Blattgrün")

    def _search(self, term):
        return self.client.get(f"/api/search/?q={term}").json()

    def test_matches_room_set_and_question(self):
        rooms = self._search("photosynth")
        self.assertEqual([r["title"] for r in rooms["rooms"]],
                         ["Photosynthese-Vorlesung"])
        self.assertEqual([s["title"] for s in self._search("grundlagen")["sets"]],
                         ["Grundlagen"])
        # Question text is matched and returned as plain text with context.
        questions = self._search("chlorophyll")["questions"]
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["text"], "Was ist Chlorophyll?")
        self.assertEqual(questions[0]["set_title"], "Grundlagen")
        self.assertEqual(questions[0]["room_title"], "Photosynthese-Vorlesung")
        # Answer-option text matches too.
        self.assertEqual(len(self._search("blattgr")["questions"]), 1)

    def test_short_query_returns_nothing(self):
        self.assertEqual(
            self._search("c"), {"rooms": [], "sets": [], "questions": []}
        )

    def test_scoped_to_owned_rooms(self):
        foreign = Room.objects.create(title="Photosynthese-Fremdraum")
        foreign.owners.add(self.other)
        QuestionSet.objects.create(room=foreign, title="Photo-Fremdset")
        result = self._search("photo")
        self.assertNotIn(
            "Photosynthese-Fremdraum", [r["title"] for r in result["rooms"]]
        )
        self.assertNotIn("Photo-Fremdset", [s["title"] for s in result["sets"]])

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/search/?q=photo").status_code, 403)

    def test_search_finds_content_regardless_of_active_ui_language(self):
        # Same regression as QuestionSetViewSet's search (#33 MR2
        # follow-up): a German-authored room/set must be found by a
        # search request under an active English UI, not just under
        # German.
        with translation.override("de"):
            Room.objects.create(title="Deutschlandkunde-Vorlesung").owners.add(
                self.owner
            )
            QuestionSet.objects.create(
                room=self.room, title="Nur auf Deutsch verfasst"
            )
        response = self.client.get(
            "/api/search/?q=deutschlandkunde", HTTP_ACCEPT_LANGUAGE="en"
        )
        self.assertEqual(
            [r["title"] for r in response.json()["rooms"]],
            ["Deutschlandkunde-Vorlesung"],
        )
        response = self.client.get(
            "/api/search/?q=verfasst", HTTP_ACCEPT_LANGUAGE="en"
        )
        self.assertEqual(
            [s["title"] for s in response.json()["sets"]],
            ["Nur auf Deutsch verfasst"],
        )


AI_ON = {
    "AI_PROVIDER": "litellm", "AI_BASE_URL": "https://llm.test/v1",
    "AI_API_KEY": "k", "AI_MODEL": "m",
}


class AiEditorTests(ApiTestCase):
    """AI distractor/rephrase actions on a question (chat_json mocked)."""

    def setUp(self):
        super().setUp()
        from unittest import mock

        from django.test import override_settings
        self.mock = mock
        self.override_settings = override_settings
        qs = QuestionSet.objects.create(room=self.room, title="T")
        self.question = Question.objects.create(
            question_set=qs, kind="single_choice", text="<p>Was ist 2+2?</p>"
        )
        AnswerOption.objects.create(question=self.question, text="4", is_correct=True)
        AnswerOption.objects.create(question=self.question, text="5")

    def test_distractors_disabled_returns_503(self):
        # Force AI off (the dev container may have a real .env configured).
        with self.override_settings(AI_PROVIDER="none", AI_BASE_URL="", AI_API_KEY="", AI_MODEL=""):
            r = self.client.post(f"/api/questions/{self.question.pk}/ai-distractors/")
        self.assertEqual(r.status_code, 503)

    def test_distractors_validates_and_dedupes(self):
        reply = {"distractors": ["4", "6", "6", "sieben", ""]}  # 4 exists, 6 dup, "" empty
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.ai.chat_json", return_value=reply
        ):
            r = self.client.post(
                f"/api/questions/{self.question.pk}/ai-distractors/",
                {
                    "count": 3,
                    "text": "Was ist 2+2?",  # live editor text (may be unsaved)
                    "options": [
                        {"text": "4", "is_correct": True},
                        {"text": "5", "is_correct": False},
                    ],
                },
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["distractors"], ["6", "sieben"])

    def test_rephrase_returns_variants(self):
        reply = {"variants": ["Wie viel ist 2+2?", "2 plus 2 ergibt?"]}
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.ai.chat_json", return_value=reply
        ):
            r = self.client.post(f"/api/questions/{self.question.pk}/ai-rephrase/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["variants"]), 2)

    def test_ai_error_returns_502(self):
        from basicbar_integrations.ai import AIError

        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.ai.chat_json", side_effect=AIError("boom")
        ):
            r = self.client.post(f"/api/questions/{self.question.pk}/ai-rephrase/")
        self.assertEqual(r.status_code, 502)


class AiEditorSetScopedTests(ApiTestCase):
    """Set-scoped AI distractor/rephrase actions for a question that hasn't
    been saved yet (still being created in the editor, no question id)."""

    def setUp(self):
        super().setUp()
        from unittest import mock

        from django.test import override_settings
        self.mock = mock
        self.override_settings = override_settings
        self.question_set = QuestionSet.objects.create(room=self.room, title="T")

    def test_distractors_disabled_returns_503(self):
        with self.override_settings(AI_PROVIDER="none", AI_BASE_URL="", AI_API_KEY="", AI_MODEL=""):
            r = self.client.post(
                f"/api/question-sets/{self.question_set.pk}/ai-distractors/"
            )
        self.assertEqual(r.status_code, 503)

    def test_distractors_uses_draft_body(self):
        reply = {"distractors": ["4", "6", "6", "sieben", ""]}
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.ai.chat_json", return_value=reply
        ):
            r = self.client.post(
                f"/api/question-sets/{self.question_set.pk}/ai-distractors/",
                {
                    "count": 3,
                    "text": "Was ist 2+2?",
                    "options": [
                        {"text": "4", "is_correct": True},
                        {"text": "5", "is_correct": False},
                    ],
                },
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["distractors"], ["6", "sieben"])

    def test_rephrase_uses_draft_body(self):
        reply = {"variants": ["Wie viel ist 2+2?", "2 plus 2 ergibt?"]}
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.ai.chat_json", return_value=reply
        ):
            r = self.client.post(
                f"/api/question-sets/{self.question_set.pk}/ai-rephrase/",
                {"text": "Was ist 2+2?"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["variants"]), 2)

    def test_rephrase_without_text_returns_400(self):
        with self.override_settings(**AI_ON):
            r = self.client.post(
                f"/api/question-sets/{self.question_set.pk}/ai-rephrase/",
                {"text": ""},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 400)

    def test_non_owner_cannot_use_set_scoped_actions(self):
        self.client.force_login(self.other)
        with self.override_settings(**AI_ON):
            r = self.client.post(
                f"/api/question-sets/{self.question_set.pk}/ai-distractors/",
                {"text": "Was ist 2+2?"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 404)


class V21TransferTests(ApiTestCase):
    def test_export_import_keeps_v21_fields(self):
        question_set = QuestionSet.objects.create(
            room=self.room, title_de="V2", open_on_show=True,
            show_results_to_participants=True,
            license="copyright", license_holder="Dr. Muster",
        )
        Question.objects.create(
            question_set=question_set, kind="open_text",
            text_de="<p>Feedback?</p>", time_limit=90,
        )
        export = self.client.get(
            f"/api/question-sets/{question_set.pk}/export/"
        ).json()
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", export,
            content_type="application/json",
        )
        imported = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertTrue(imported.open_on_show)
        self.assertTrue(imported.show_results_to_participants)
        self.assertEqual(imported.license, "copyright")
        self.assertEqual(imported.license_holder, "Dr. Muster")
        question = imported.questions.get()
        self.assertEqual(question.kind, "open_text")
        self.assertEqual(question.time_limit, 90)

    def test_export_import_keeps_wordcloud_max_answers(self):
        # #76: the per-participant word-cloud cap survives export → import.
        question_set = QuestionSet.objects.create(room=self.room, title_de="WC")
        Question.objects.create(
            question_set=question_set, kind="word_cloud",
            text_de="<p>Stichwort?</p>", allow_multiple=True,
            wordcloud_max_answers=3,
        )
        export = self.client.get(
            f"/api/question-sets/{question_set.pk}/export/"
        ).json()
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", export,
            content_type="application/json",
        )
        imported = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertEqual(imported.questions.get().wordcloud_max_answers, 3)

    def test_wordcloud_merge_settings_roundtrip(self):
        # Consolidation switches survive the serializer, export → import
        # and duplication.
        question_set = QuestionSet.objects.create(room=self.room, title_de="WC")
        created = self.client.post(
            "/api/questions/",
            {
                "question_set": question_set.pk, "kind": "word_cloud",
                "text": "<p>Stichwort?</p>", "options": [],
                "wordcloud_merge_variants": False,
                "wordcloud_merge_synonyms": False,
                "wordcloud_merge_concepts": True,
            },
            content_type="application/json",
        )
        self.assertEqual(created.status_code, 201)
        body = created.json()
        self.assertFalse(body["wordcloud_merge_variants"])
        self.assertFalse(body["wordcloud_merge_synonyms"])
        self.assertTrue(body["wordcloud_merge_concepts"])
        source = Question.objects.get(pk=body["id"])

        export = self.client.get(
            f"/api/question-sets/{question_set.pk}/export/"
        ).json()
        self.assertFalse(export["questions"][0]["wordcloud_merge_variants"])
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", export,
            content_type="application/json",
        )
        imported = QuestionSet.objects.get(pk=response.json()["id"]).questions.get()
        self.assertFalse(imported.wordcloud_merge_variants)
        self.assertFalse(imported.wordcloud_merge_synonyms)
        self.assertTrue(imported.wordcloud_merge_concepts)

        from rooms.transfer import duplicate_question
        clone = duplicate_question(
            source, question_set=question_set, section=None, position=9
        )
        self.assertFalse(clone.wordcloud_merge_variants)
        self.assertFalse(clone.wordcloud_merge_synonyms)
        self.assertTrue(clone.wordcloud_merge_concepts)

    def test_grouping_use_solution_roundtrip(self):
        # Serializer, export → import (missing → default on) and duplication.
        question_set = QuestionSet.objects.create(room=self.room, title_de="FT")
        created = self.client.post(
            "/api/questions/",
            {
                "question_set": question_set.pk, "kind": "open_text",
                "text": "<p>Warum?</p>", "options": [],
                "model_solution": "Darum",
                "wordcloud_grouping_use_solution": False,
            },
            content_type="application/json",
        )
        self.assertEqual(created.status_code, 201)
        self.assertFalse(created.json()["wordcloud_grouping_use_solution"])
        source = Question.objects.get(pk=created.json()["id"])
        self.assertFalse(source.wordcloud_grouping_use_solution)

        export = self.client.get(
            f"/api/question-sets/{question_set.pk}/export/"
        ).json()
        self.assertFalse(export["questions"][0]["wordcloud_grouping_use_solution"])
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", export,
            content_type="application/json",
        )
        imported = QuestionSet.objects.get(pk=response.json()["id"]).questions.get()
        self.assertFalse(imported.wordcloud_grouping_use_solution)

        export["questions"][0].pop("wordcloud_grouping_use_solution")
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", export,
            content_type="application/json",
        )
        imported = QuestionSet.objects.get(pk=response.json()["id"]).questions.get()
        self.assertTrue(imported.wordcloud_grouping_use_solution)

        from rooms.transfer import duplicate_question
        clone = duplicate_question(
            source, question_set=question_set, section=None, position=9
        )
        self.assertFalse(clone.wordcloud_grouping_use_solution)

    def test_import_defaults_wordcloud_merge_settings_when_missing(self):
        question_set = QuestionSet.objects.create(room=self.room, title_de="WC")
        Question.objects.create(
            question_set=question_set, kind="word_cloud", text_de="<p>W?</p>",
        )
        export = self.client.get(
            f"/api/question-sets/{question_set.pk}/export/"
        ).json()
        for key in (
            "wordcloud_merge_variants", "wordcloud_merge_synonyms",
            "wordcloud_merge_concepts",
        ):
            export["questions"][0].pop(key, None)
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", export,
            content_type="application/json",
        )
        imported = QuestionSet.objects.get(pk=response.json()["id"]).questions.get()
        self.assertTrue(imported.wordcloud_merge_variants)
        self.assertTrue(imported.wordcloud_merge_synonyms)
        self.assertFalse(imported.wordcloud_merge_concepts)

    def test_likert_question_with_options_is_valid(self):
        question_set = QuestionSet.objects.create(room=self.room, title="L")
        response = self.client.post(
            "/api/questions/",
            {
                "question_set": question_set.pk,
                "kind": "likert",
                "text": "<p>Das Tempo passt.</p>",
                "time_limit": 60,
                "options": [{"text": "Stimme zu", "is_correct": False}],
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["time_limit"], 60)

    def test_likert_endpoints_are_bilingual_and_blank_middles_ok(self):
        qs = QuestionSet.objects.create(room=self.room, title="L")
        resp = self.client.post(
            "/api/questions/",
            {
                "question_set": qs.pk,
                "kind": "likert",
                "text": {"de": "Wie geht es dir?", "en": "How are you?"},
                "options": [
                    {"text": {"de": "Schlecht", "en": "Bad"}},
                    {"text": {"de": "", "en": ""}},
                    {"text": {"de": "", "en": ""}},
                    {"text": {"de": "", "en": ""}},
                    {"text": {"de": "Gut", "en": "Good"}},
                ],
            },
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        opts = list(
            AnswerOption.objects.filter(question_id=resp.json()["id"]).order_by("position")
        )
        self.assertEqual(len(opts), 5)
        self.assertEqual(opts[0].text_de, "Schlecht")
        self.assertEqual(opts[0].text_en, "Bad")
        self.assertEqual(opts[4].text_en, "Good")
        # A blank map entry is normalized to None at the model level (shared
        # TranslatedMapMixin behavior, common/i18n_fields.py); the API read
        # path (translated_map) still exposes it as "" to clients.
        self.assertIsNone(opts[2].text_de)

    def test_open_text_rejects_options(self):
        question_set = QuestionSet.objects.create(room=self.room, title="T")
        response = self.client.post(
            "/api/questions/",
            {
                "question_set": question_set.pk,
                "kind": "open_text",
                "text": "<p>Feedback?</p>",
                "options": [{"text": "x", "is_correct": False}],
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)


class SharingTests(ApiTestCase):
    """v2 "Teilen & Zusammenarbeit": co-owners, copy link, license."""

    def setUp(self):
        super().setUp()
        self.other.email = "eve@uni.example"
        self.other.first_name = "Eve"
        self.other.save()
        self.question_set = QuestionSet.objects.create(
            room=self.room, title_de="Termin 1", license="cc-by"
        )
        question = Question.objects.create(
            question_set=self.question_set,
            kind=Question.Kind.SINGLE_CHOICE,
            text="<p>2+2?</p>",
        )
        AnswerOption.objects.create(question=question, text="4", is_correct=True)

    # -- co-owners ----------------------------------------------------------

    def test_add_owner_by_username_and_email(self):
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/owners/", {"user": "eve"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn(self.other, self.room.owners.all())
        # Adding again (now by e-mail) stays idempotent.
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/owners/", {"user": "EVE@uni.example"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.room.owners.count(), 2)
        names = {o["username"] for o in response.json()["owners"]}
        self.assertEqual(names, {"frank", "eve"})

    def test_add_unknown_user_404(self):
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/owners/", {"user": "unknown"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_co_owner_gets_full_access(self):
        self.room.owners.add(self.other)
        self.client.force_login(self.other)
        response = self.client.get(f"/api/rooms/{self.room.pk}/")
        self.assertEqual(response.status_code, 200)
        response = self.client.get(f"/api/question-sets/{self.question_set.pk}/")
        self.assertEqual(response.status_code, 200)

    def test_remove_owner_and_last_owner_guard(self):
        self.room.owners.add(self.other)
        response = self.client.delete(
            f"/api/rooms/{self.room.pk}/owners/{self.other.pk}/"
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(self.other, self.room.owners.all())
        response = self.client.delete(
            f"/api/rooms/{self.room.pk}/owners/{self.owner.pk}/"
        )
        self.assertEqual(response.status_code, 409)
        self.assertIn(self.owner, self.room.owners.all())

    def test_non_owner_cannot_manage_owners(self):
        self.client.force_login(self.other)
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/owners/", {"user": "eve"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    # -- copy link ----------------------------------------------------------

    def share(self, enabled=True):
        return self.client.post(
            f"/api/question-sets/{self.question_set.pk}/share/",
            {"enabled": enabled},
            content_type="application/json",
        )

    def test_share_toggle(self):
        token = self.share().json()["share_token"]
        self.assertTrue(token)
        # Enabling again keeps the same token (links stay stable).
        self.assertEqual(self.share().json()["share_token"], token)
        self.assertIsNone(self.share(enabled=False).json()["share_token"])

    def test_shared_preview_for_any_logged_in_user(self):
        token = self.share().json()["share_token"]
        self.client.force_login(self.other)
        response = self.client.get(f"/api/shared/{token}/")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["title"], "Termin 1")
        self.assertEqual(payload["license"], "cc-by")
        self.assertEqual(payload["question_count"], 1)
        self.assertEqual(payload["questions"][0]["text"], "2+2?")

    def test_shared_preview_requires_login(self):
        token = self.share().json()["share_token"]
        self.client.logout()
        response = self.client.get(f"/api/shared/{token}/")
        self.assertEqual(response.status_code, 403)

    def test_disabled_link_is_gone(self):
        token = self.share().json()["share_token"]
        self.share(enabled=False)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(f"/api/shared/{token}/").status_code, 404)

    def test_copy_into_own_room(self):
        token = self.share().json()["share_token"]
        self.client.force_login(self.other)
        their_room = Room.objects.create(title="Eves Raum")
        their_room.owners.add(self.other)
        response = self.client.post(
            f"/api/shared/{token}/copy/", {"room": their_room.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        clone = QuestionSet.objects.get(pk=response.json()["id"])
        self.assertEqual(clone.room, their_room)
        self.assertEqual(clone.license, "cc-by")   # license travels with the copy
        self.assertIsNone(clone.share_token)       # the link does not
        self.assertEqual(clone.questions.count(), 1)

    def test_copy_requires_own_target_room(self):
        token = self.share().json()["share_token"]
        self.client.force_login(self.other)
        response = self.client.post(
            f"/api/shared/{token}/copy/", {"room": self.room.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_export_includes_license(self):
        response = self.client.get(
            f"/api/question-sets/{self.question_set.pk}/export/"
        )
        self.assertEqual(response.json()["license"], "cc-by")
        # …and import restores it (invalid values are dropped).
        data = response.json()
        imported = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", data,
            content_type="application/json",
        )
        self.assertEqual(
            QuestionSet.objects.get(pk=imported.json()["id"]).license, "cc-by"
        )


class MoveQuestionTests(ApiTestCase):
    """v2: move a question into another of the user's sets."""

    def setUp(self):
        super().setUp()
        self.source = QuestionSet.objects.create(room=self.room, title="Quelle")
        self.target = QuestionSet.objects.create(room=self.room, title="Ziel")
        self.existing = Question.objects.create(
            question_set=self.target, kind=Question.Kind.SINGLE_CHOICE, position=0
        )
        self.question = Question.objects.create(
            question_set=self.source, kind=Question.Kind.SINGLE_CHOICE, position=0
        )

    def move(self, target_id):
        return self.client.post(
            f"/api/questions/{self.question.pk}/move/",
            {"question_set": target_id},
            content_type="application/json",
        )

    def test_move_appends_to_target(self):
        response = self.move(self.target.pk)
        self.assertEqual(response.status_code, 200)
        self.question.refresh_from_db()
        self.assertEqual(self.question.question_set, self.target)
        self.assertEqual(self.question.position, 1)  # after the existing question
        self.assertEqual(self.source.questions.count(), 0)

    def test_move_to_foreign_set_rejected(self):
        foreign_room = Room.objects.create(title="Fremd")
        foreign_room.owners.add(self.other)
        foreign_set = QuestionSet.objects.create(room=foreign_room, title="Fremd")
        self.assertEqual(self.move(foreign_set.pk).status_code, 400)
        self.question.refresh_from_db()
        self.assertEqual(self.question.question_set, self.source)

    def test_move_with_votes_blocked(self):
        from live.models import ParticipantToken, Run, Vote

        run = Run.objects.create(question_set=self.source)
        token = ParticipantToken.objects.create(room=self.room)
        Vote.objects.create(run=run, question=self.question, token=token, text="x")
        response = self.move(self.target.pk)
        self.assertEqual(response.status_code, 409)
        self.question.refresh_from_db()
        self.assertEqual(self.question.question_set, self.source)

    def test_move_to_same_set_is_noop(self):
        response = self.move(self.source.pk)
        self.assertEqual(response.status_code, 200)
        self.question.refresh_from_db()
        self.assertEqual(self.question.position, 0)


class UniqueTitleTests(ApiTestCase):
    """Review feedback: unique names per scope, dated defaults for blanks."""

    def create_room(self, title=""):
        return self.client.post(
            "/api/rooms/", {"title": title}, content_type="application/json"
        )

    def create_set(self, title="", room=None):
        return self.client.post(
            "/api/question-sets/",
            {"room": (room or self.room).pk, "title": title},
            content_type="application/json",
        )

    def test_blank_room_title_gets_dated_default(self):
        response = self.create_room()
        self.assertEqual(response.status_code, 201)
        # title is a {"de","en"} map (#33 MR2); the default is generated in
        # BOTH languages (#19) so it reads naturally whatever the UI language.
        title = response.json()["title"]
        self.assertTrue(title["de"].startswith("Unbenannter Raum vom "))
        self.assertTrue(title["en"].startswith("Unnamed room from "))
        # A second untitled room in the same minute gets a suffix, mirrored
        # across both languages.
        second = self.create_room().json()["title"]
        self.assertNotEqual(second["de"], title["de"])
        self.assertNotEqual(second["en"], title["en"])
        self.assertTrue(second["de"].startswith("Unbenannter Raum vom "))
        self.assertTrue(second["en"].startswith("Unnamed room from "))

    def test_duplicate_room_title_rejected_per_user(self):
        self.assertEqual(self.create_room("Bio 101").status_code, 400)  # exists
        # Another user may use the same room name.
        self.client.force_login(self.other)
        self.assertEqual(self.create_room("Bio 101").status_code, 201)

    def test_room_rename_conflict_rejected_but_self_ok(self):
        other_room = Room.objects.create(title="Chemie")
        other_room.owners.add(self.owner)
        response = self.client.patch(
            f"/api/rooms/{other_room.pk}/", {"title": "bio 101"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)  # case-insensitive clash
        response = self.client.patch(
            f"/api/rooms/{other_room.pk}/", {"title": "Chemie"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)  # own name is fine

    def test_blank_set_title_gets_dated_default(self):
        response = self.create_set()
        self.assertEqual(response.status_code, 201)
        title = response.json()["title"]
        self.assertTrue(title["de"].startswith("Unbenanntes Fragenset vom "))
        self.assertTrue(title["en"].startswith("Unnamed question set from "))

    def test_duplicate_set_title_rejected_within_room_only(self):
        self.assertEqual(self.create_set("Termin 1").status_code, 201)
        self.assertEqual(self.create_set("termin 1").status_code, 400)
        other_room = Room.objects.create(title="Chemie")
        other_room.owners.add(self.owner)
        # Same set name in a different room is fine.
        self.assertEqual(self.create_set("Termin 1", room=other_room).status_code, 201)

    def test_duplicate_copies_get_numbered_suffix(self):
        self.create_set("Termin 1")  # legacy string -> title_de (canonical)
        original = QuestionSet.objects.get(title_de="Termin 1")
        # The "duplicate" API action derives the "(Kopie)" suffix from the
        # bare accessor (active UI language "en" during the request,
        # falling back to the canonical "de" since title_en is blank here)
        # and duplicate_set() applies it to the canonical column only (#33
        # MR2 Task 6) — resolve the response map rather than assuming a
        # language, since the (blank) English side never gets the suffix.
        first = self.client.post(
            f"/api/question-sets/{original.pk}/duplicate/", {},
            content_type="application/json",
        ).json()["title"]
        second = self.client.post(
            f"/api/question-sets/{original.pk}/duplicate/", {},
            content_type="application/json",
        ).json()["title"]
        self.assertEqual(resolve_translated_text(first), "Termin 1 (Kopie)")
        self.assertEqual(resolve_translated_text(second), "Termin 1 (Kopie) (2)")

    def test_import_collision_gets_suffix(self):
        self.create_set("Termin 1")  # legacy string -> title_de (canonical)
        original = QuestionSet.objects.get(title_de="Termin 1")
        export = self.client.get(
            f"/api/question-sets/{original.pk}/export/"
        ).json()
        imported = self.client.post(
            f"/api/rooms/{self.room.pk}/import-set/", export,
            content_type="application/json",
        ).json()
        # Fixed in #33 MR2 Task 6: _unique_in_room() now dedupes on the
        # canonical (title_de) column instead of the bare, active-language
        # accessor, so importing the same set's export back into the same
        # room is correctly recognized as a collision and gets a numbered
        # suffix — like same-language collisions, which the serializers'
        # own uniqueness checks (validate()) already caught (see
        # test_duplicate_set_title_rejected_within_room_only).
        self.assertEqual(resolve_translated_text(imported["title"]), "Termin 1 (2)")


class OptionImageTests(ApiTestCase):
    """v2: optional image per answer option (relative /media/ URL only)."""

    def setUp(self):
        super().setUp()
        # Canonical (de) explicitly, not the bare accessor: this fixture is
        # used with import_set() directly below, which requires a canonical
        # title (#33 MR2 Task 6).
        self.question_set = QuestionSet.objects.create(room=self.room, title_de="T")

    def create_question(self, image):
        return self.client.post(
            "/api/questions/",
            {
                "question_set": self.question_set.pk,
                "kind": "single_choice",
                "text": "<p>Bild?</p>",
                "options": [
                    {"text": "A", "image": image, "is_correct": True},
                    {"text": "B", "is_correct": False},
                ],
            },
            content_type="application/json",
        )

    def test_media_url_is_stored(self):
        response = self.create_question("/media/question-images/2026/07/a.png")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.json()["options"][0]["image"],
            "/media/question-images/2026/07/a.png",
        )

    def test_foreign_urls_are_dropped(self):
        for bad in [
            "https://evil.example/x.png",
            "//evil.example/x.png",
            "/media/../secret.txt",
            "data:image/png;base64,AAAA",
        ]:
            response = self.create_question(bad)
            self.assertEqual(response.status_code, 201, bad)
            self.assertEqual(response.json()["options"][0]["image"], "", bad)

    def test_image_travels_with_duplicate_and_export(self):
        self.create_question("/media/question-images/2026/07/a.png")
        from .transfer import duplicate_set, export_set, import_set

        clone = duplicate_set(self.question_set, self.room)
        self.assertEqual(
            clone.questions.first().options.first().image,
            "/media/question-images/2026/07/a.png",
        )
        data = export_set(self.question_set)
        self.assertEqual(
            data["questions"][0]["options"][0]["image"],
            "/media/question-images/2026/07/a.png",
        )
        data["questions"][0]["options"][0]["image"] = "https://evil.example/x.png"
        imported = import_set(self.room, data)
        self.assertEqual(imported.questions.first().options.first().image, "")

    def test_live_payload_includes_image(self):
        self.create_question("/media/question-images/2026/07/a.png")
        from live.models import Run

        question = self.question_set.questions.first()
        Run.objects.create(
            question_set=self.question_set,
            phase=Run.Phase.OPEN,
            active_question=question,
        )
        from live.state import build_payloads

        payload = build_payloads(self.room)
        options = payload["participant"]["question"]["options"]
        self.assertEqual(options[0]["image"], "/media/question-images/2026/07/a.png")
        self.assertNotIn("image", options[1])  # empty images stay out


class SectionTests(ApiTestCase):
    """v2: named question groups (Abschnitte) inside a set."""

    def setUp(self):
        super().setUp()
        # Canonical (de) explicitly: used with import_set() below, which
        # requires a canonical title (#33 MR2 Task 6).
        self.qset = QuestionSet.objects.create(room=self.room, title_de="Abschnitt-Set")

    def create_section(self, title="", qset=None):
        return self.client.post(
            "/api/sections/",
            {"question_set": (qset or self.qset).pk, "title": title},
            content_type="application/json",
        )

    def test_create_blank_gets_numbered_default(self):
        first = self.create_section()
        self.assertEqual(first.status_code, 201)
        # title is a {"de","en"} map (#33 MR2); the numbered default is
        # generated for the canonical (de) language.
        self.assertEqual(first.json()["title"], {"de": "Abschnitt 1", "en": ""})
        self.assertEqual(
            self.create_section().json()["title"], {"de": "Abschnitt 2", "en": ""}
        )

    def test_positions_increment(self):
        a = self.create_section("Begrüßung").json()
        b = self.create_section("Ende").json()
        self.assertEqual((a["position"], b["position"]), (0, 1))

    def test_assign_question_to_section(self):
        section = self.create_section("Begrüßung").json()
        # Content validation (#32/#23) resolves canonical text from the
        # instance on update, so a directly-ORM-created question needs real
        # text here or this unrelated section-only PATCH would 400.
        question = Question.objects.create(
            question_set=self.qset, kind=Question.Kind.SINGLE_CHOICE, text_de="<p>Q?</p>"
        )
        response = self.client.patch(
            f"/api/questions/{question.pk}/",
            {"section": section["id"]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["section"], section["id"])

    def test_section_of_other_set_rejected(self):
        other = QuestionSet.objects.create(room=self.room, title="Anderes")
        foreign = self.create_section("X", qset=other).json()
        question = Question.objects.create(
            question_set=self.qset, kind=Question.Kind.SINGLE_CHOICE
        )
        response = self.client.patch(
            f"/api/questions/{question.pk}/",
            {"section": foreign["id"]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_deleting_section_keeps_questions_unsectioned(self):
        section = self.create_section().json()
        question = Question.objects.create(
            question_set=self.qset, kind=Question.Kind.SINGLE_CHOICE,
            section_id=section["id"],
        )
        self.assertEqual(
            self.client.delete(f"/api/sections/{section['id']}/").status_code, 204
        )
        question.refresh_from_db()
        self.assertIsNone(question.section_id)

    def test_reorder_sections(self):
        a = self.create_section("A").json()
        b = self.create_section("B").json()
        response = self.client.post(
            f"/api/question-sets/{self.qset.pk}/reorder-sections/",
            {"section_ids": [b["id"], a["id"]]},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        from rooms.models import Section

        self.assertEqual(Section.objects.get(pk=b["id"]).position, 0)
        self.assertEqual(Section.objects.get(pk=a["id"]).position, 1)

    def test_non_owner_cannot_create_section(self):
        self.client.force_login(self.other)
        self.assertEqual(self.create_section("X").status_code, 400)

    def test_move_question_clears_section(self):
        section = self.create_section().json()
        target = QuestionSet.objects.create(room=self.room, title="Ziel")
        question = Question.objects.create(
            question_set=self.qset, kind=Question.Kind.SINGLE_CHOICE,
            section_id=section["id"],
        )
        response = self.client.post(
            f"/api/questions/{question.pk}/move/",
            {"question_set": target.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        question.refresh_from_db()
        self.assertEqual(question.question_set, target)
        self.assertIsNone(question.section_id)

    def test_sections_travel_with_duplicate_and_export(self):
        from rooms.models import Section
        from rooms.transfer import duplicate_set, export_set, import_set

        section = Section.objects.create(question_set=self.qset, title_de="Begrüßung")
        Question.objects.create(
            question_set=self.qset, kind=Question.Kind.SINGLE_CHOICE,
            section=section, position=0,
        )
        Question.objects.create(
            question_set=self.qset, kind=Question.Kind.WORD_CLOUD, position=1
        )

        clone = duplicate_set(self.qset, self.room)
        self.assertEqual(clone.sections.count(), 1)
        clone_q0 = clone.questions.get(position=0)
        self.assertEqual(clone_q0.section.title, "Begrüßung")
        self.assertIsNone(clone.questions.get(position=1).section)

        data = export_set(self.qset)
        # Section.title is a {"de","en"} map like every other translatable
        # field (#33 MR2 Task 6).
        self.assertEqual(data["sections"], [{"title": {"de": "Begrüßung", "en": ""}}])
        self.assertEqual(data["questions"][0]["section"], 0)
        self.assertIsNone(data["questions"][1]["section"])

        imported = import_set(self.room, data)
        self.assertEqual(imported.sections.count(), 1)
        self.assertEqual(
            imported.questions.get(position=0).section.title, "Begrüßung"
        )


class OutlineReorderTests(ApiTestCase):
    """Inline outline: sections and questions in one shared sequence,
    section membership derived from the nearest header above (v2 rework)."""

    def setUp(self):
        super().setUp()
        self.qset = QuestionSet.objects.create(room=self.room, title="Outline")
        from rooms.models import Section

        self.q1 = Question.objects.create(
            question_set=self.qset, kind=Question.Kind.SINGLE_CHOICE, position=0
        )
        self.q2 = Question.objects.create(
            question_set=self.qset, kind=Question.Kind.SINGLE_CHOICE, position=1
        )
        self.sec = Section.objects.create(
            question_set=self.qset, title="Teil B", position=2
        )

    def outline(self, items):
        return self.client.post(
            f"/api/question-sets/{self.qset.pk}/reorder-outline/",
            {"items": items},
            content_type="application/json",
        )

    def test_membership_follows_position(self):
        # Order: q1, [Teil B], q2  → q1 unsectioned, q2 in Teil B.
        response = self.outline([
            {"type": "question", "id": self.q1.pk},
            {"type": "section", "id": self.sec.pk},
            {"type": "question", "id": self.q2.pk},
        ])
        self.assertEqual(response.status_code, 200)
        self.q1.refresh_from_db()
        self.q2.refresh_from_db()
        self.sec.refresh_from_db()
        self.assertIsNone(self.q1.section_id)
        self.assertEqual(self.q2.section_id, self.sec.pk)
        # Positions form the shared sequence in listed order.
        self.assertEqual(
            (self.q1.position, self.sec.position, self.q2.position), (0, 1, 2)
        )

    def test_dragging_question_above_header_unsections_it(self):
        # Start: [Teil B], q1, q2  → both in Teil B.
        self.outline([
            {"type": "section", "id": self.sec.pk},
            {"type": "question", "id": self.q1.pk},
            {"type": "question", "id": self.q2.pk},
        ])
        self.q1.refresh_from_db()
        self.assertEqual(self.q1.section_id, self.sec.pk)
        # Move q1 above the header → unsectioned.
        self.outline([
            {"type": "question", "id": self.q1.pk},
            {"type": "section", "id": self.sec.pk},
            {"type": "question", "id": self.q2.pk},
        ])
        self.q1.refresh_from_db()
        self.assertIsNone(self.q1.section_id)

    def test_incomplete_outline_rejected(self):
        response = self.outline([{"type": "question", "id": self.q1.pk}])
        self.assertEqual(response.status_code, 400)

    def test_new_question_inherits_last_section(self):
        # After placing q2 in the section, a freshly created question joins it.
        self.outline([
            {"type": "question", "id": self.q1.pk},
            {"type": "section", "id": self.sec.pk},
            {"type": "question", "id": self.q2.pk},
        ])
        response = self.client.post(
            "/api/questions/",
            {"question_set": self.qset.pk, "kind": "single_choice"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["section"], self.sec.pk)


class AiGenerateDraftTests(TestCase):
    """Validation of model output into draft questions (Paket 5)."""

    def test_validates_and_repairs_answer_key(self):
        from .ai_generate import ALLOWED_KINDS, build_drafts

        data = {"questions": [
            {"kind": "single_choice", "text": "Q1", "options": [
                {"text": "A", "is_correct": False},
                {"text": "B", "is_correct": True},
                {"text": "C"}]},
            {"kind": "single_choice", "text": "Qm", "options": [
                {"text": "a", "is_correct": True},
                {"text": "b", "is_correct": True}]},  # two correct → forced to one
            {"kind": "multiple_choice", "text": "Q2", "options": [
                {"text": "X"}, {"text": "Y"}]},  # none correct → first forced
            {"kind": "single_choice", "text": "Q3", "options": [{"text": "only"}]},  # <2 → drop
            {"kind": "open_text", "text": "Q4", "options": [{"text": "ignored"}]},
            {"kind": "foo", "text": "Q5"},  # unknown kind → drop
            {"kind": "single_choice", "text": "", "options": [
                {"text": "a"}, {"text": "b"}]},  # empty text → drop
        ]}
        drafts = build_drafts(data, ALLOWED_KINDS, count=10)
        self.assertEqual(
            [(d["kind"], d["text"]) for d in drafts],
            [("single_choice", "Q1"), ("single_choice", "Qm"),
             ("multiple_choice", "Q2"), ("open_text", "Q4")],
        )
        self.assertEqual([o["is_correct"] for o in drafts[0]["options"]], [False, True, False])
        self.assertEqual([o["is_correct"] for o in drafts[1]["options"]], [True, False])
        self.assertTrue(drafts[2]["options"][0]["is_correct"])
        self.assertEqual(drafts[3]["options"], [])

    def test_respects_count_and_kind_filter(self):
        from .ai_generate import build_drafts

        data = {"questions": [{"kind": "open_text", "text": f"Q{i}"} for i in range(10)]}
        self.assertEqual(len(build_drafts(data, ["open_text"], count=3)), 3)
        # a single_choice draft is dropped when only open_text is allowed
        data2 = {"questions": [
            {"kind": "single_choice", "text": "S", "options": [
                {"text": "a", "is_correct": True}, {"text": "b"}]},
            {"kind": "open_text", "text": "O"},
        ]}
        self.assertEqual(
            [d["kind"] for d in build_drafts(data2, ["open_text"], count=10)],
            ["open_text"],
        )

    def test_open_text_draft_carries_model_solution(self):
        from .ai_generate import build_drafts

        data = {"questions": [
            {"kind": "open_text", "text": "Was ist Photosynthese?",
             "model_solution": "  Umwandlung von Licht in chemische Energie.  "},
            {"kind": "open_text", "text": "Nenne ein Beispiel."},
        ]}
        drafts = build_drafts(data, ["open_text"], 5)
        self.assertEqual(drafts[0]["model_solution"], "Umwandlung von Licht in chemische Energie.")
        self.assertEqual(drafts[1]["model_solution"], "")


class AiGenerateEndpointTests(ApiTestCase):
    """The set-level ai-generate action (chat_json + extraction mocked)."""

    def setUp(self):
        super().setUp()
        from unittest import mock

        from django.test import override_settings
        self.mock = mock
        self.override_settings = override_settings
        self.qs = QuestionSet.objects.create(room=self.room, title="T")
        self.url = f"/api/question-sets/{self.qs.pk}/ai-generate/"

    def test_disabled_returns_503(self):
        with self.override_settings(
            AI_PROVIDER="none", AI_BASE_URL="", AI_API_KEY="", AI_MODEL=""
        ):
            r = self.client.post(self.url, {"text": "Material"})
        self.assertEqual(r.status_code, 503)

    def test_generates_from_pasted_text(self):
        from .models import GenerationJob
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.generation.start_job"
        ) as start:
            r = self.client.post(
                self.url,
                {"text": "Ein längerer Materialtext.", "kinds": "open_text"},
            )
        self.assertEqual(r.status_code, 201)
        job = GenerationJob.objects.get(pk=r.json()["job_id"])
        self.assertEqual(job.source_text, "Ein längerer Materialtext.")
        self.assertEqual(job.kinds, ["open_text"])
        start.assert_called_once()

    def test_guidance_is_stored_on_the_job(self):
        from .models import GenerationJob
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.generation.start_job"
        ):
            r = self.client.post(
                self.url,
                {"text": "Ein längerer Materialtext.", "guidance": "Nur Alltagsbeispiele"},
            )
        job = GenerationJob.objects.get(pk=r.json()["job_id"])
        self.assertEqual(job.guidance, "Nur Alltagsbeispiele")

    def test_no_text_returns_400(self):
        with self.override_settings(**AI_ON):
            r = self.client.post(self.url, {})
        self.assertEqual(r.status_code, 400)

    def test_requires_owner(self):
        self.client.force_login(self.other)  # not an owner of the room
        with self.override_settings(**AI_ON):
            r = self.client.post(self.url, {"text": "x"})
        self.assertEqual(r.status_code, 404)

    def test_unsupported_file_returns_400_without_model_call(self):
        import io

        upload = io.BytesIO(b"plain notes")
        upload.name = "notes.txt"
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.generation.start_job"
        ) as start:
            r = self.client.post(self.url, {"file": upload})
        self.assertEqual(r.status_code, 400)
        start.assert_not_called()

    def test_level_is_stored_on_the_job(self):
        from .models import GenerationJob
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.generation.start_job"
        ):
            r = self.client.post(
                self.url,
                {"text": "asdfghjkl", "kinds": "single_choice", "level": "deep"},
            )
        job = GenerationJob.objects.get(pk=r.json()["job_id"])
        self.assertEqual(job.level, "deep")

    def test_unknown_level_falls_back_to_mixed(self):
        from .models import GenerationJob
        with self.override_settings(**AI_ON), self.mock.patch(
            "rooms.views.generation.start_job"
        ):
            r = self.client.post(
                self.url,
                {"text": "x", "kinds": "single_choice", "level": "bogus"},
            )
        job = GenerationJob.objects.get(pk=r.json()["job_id"])
        self.assertEqual(job.level, "mixed")


class GenerationEndpointTests(ApiTestCase):
    """Job create / status / active / cancel actions (worker itself mocked out)."""

    def setUp(self):
        super().setUp()
        from unittest import mock

        from django.test import override_settings
        self.mock, self.override_settings = mock, override_settings
        self.qs = QuestionSet.objects.create(room=self.room, title="T")
        self.url = f"/api/question-sets/{self.qs.pk}/ai-generate/"

    def test_post_creates_job_and_returns_id(self):
        from .models import GenerationJob
        with self.override_settings(**AI_ON), \
             self.mock.patch("rooms.views.generation.start_job") as start:
            r = self.client.post(self.url, {"text": "Ein Materialtext.", "kinds": "open_text"})
        self.assertEqual(r.status_code, 201)
        job = GenerationJob.objects.get(pk=r.json()["job_id"])
        self.assertEqual(job.source_text, "Ein Materialtext.")
        start.assert_called_once()

    def test_new_job_cancels_previous_active(self):
        from .models import GenerationJob
        old = GenerationJob.objects.create(
            question_set=self.qs, created_by=self.owner, source_text="x",
            status=GenerationJob.Status.RUNNING,
        )
        with self.override_settings(**AI_ON), self.mock.patch("rooms.views.generation.start_job"):
            self.client.post(self.url, {"text": "neu"})
        old.refresh_from_db()
        self.assertEqual(old.status, GenerationJob.Status.CANCELLED)

    def test_status_and_active_and_cancel(self):
        from .models import GenerationJob
        job = GenerationJob.objects.create(
            question_set=self.qs, created_by=self.owner, source_text="x",
            total_chunks=4, done_chunks=1, drafts=[{"kind": "open_text", "text": "F"}],
            status=GenerationJob.Status.RUNNING,
        )
        with self.override_settings(**AI_ON):
            s = self.client.get(f"{self.url}jobs/{job.pk}/")
            a = self.client.get(f"{self.url}active/")
            c = self.client.post(f"{self.url}jobs/{job.pk}/cancel/")
        self.assertEqual(s.json()["done_chunks"], 1)
        self.assertEqual(a.json()["id"], job.pk)
        self.assertEqual(c.status_code, 200)
        job.refresh_from_db()
        self.assertEqual(job.status, GenerationJob.Status.CANCELLED)

    def test_new_job_does_not_touch_other_sets_running_job(self):
        from .models import GenerationJob
        other_qs = QuestionSet.objects.create(room=self.room, title="Other")
        other = GenerationJob.objects.create(
            question_set=other_qs, created_by=self.owner, source_text="x",
            status=GenerationJob.Status.RUNNING,
        )
        with self.override_settings(**AI_ON), self.mock.patch("rooms.views.generation.start_job"):
            self.client.post(self.url, {"text": "neu"})
        other.refresh_from_db()
        self.assertEqual(other.status, GenerationJob.Status.RUNNING)  # untouched

    def test_cancel_foreign_job_returns_404(self):
        from .models import GenerationJob
        other_qs = QuestionSet.objects.create(room=self.room, title="Other")
        job = GenerationJob.objects.create(
            question_set=other_qs, created_by=self.owner, source_text="x")
        with self.override_settings(**AI_ON):
            r = self.client.post(f"{self.url}jobs/{job.pk}/cancel/")
        self.assertEqual(r.status_code, 404)

    def test_start_computes_target_from_density(self):
        from .models import GenerationJob
        with self.override_settings(**AI_ON), self.mock.patch("rooms.views.generation.start_job"):
            r = self.client.post(self.url, {"text": "w " * 4000, "density": "0.5"})
        self.assertEqual(r.status_code, 201)
        job = GenerationJob.objects.get(pk=r.json()["job_id"])
        self.assertEqual(job.density, 0.5)
        self.assertGreaterEqual(job.pages, 1)
        self.assertEqual(job.target_count, max(1, round(0.5 * job.pages)))

    def test_start_stores_focus_within_kinds_and_drops_if_all(self):
        from .models import GenerationJob
        with self.override_settings(**AI_ON), self.mock.patch("rooms.views.generation.start_job"):
            r = self.client.post(self.url, {
                "text": "Stoff", "kinds": "single_choice,multiple_choice,open_text",
                "focus": "single_choice,open_text,likert",  # likert not a kind → dropped
            })
        job = GenerationJob.objects.get(pk=r.json()["job_id"])
        self.assertEqual(sorted(job.focus_kinds), ["open_text", "single_choice"])
        # Focus covering all selected kinds is dropped (no priority).
        with self.override_settings(**AI_ON), self.mock.patch("rooms.views.generation.start_job"):
            r2 = self.client.post(self.url, {
                "text": "Stoff", "kinds": "single_choice,open_text",
                "focus": "single_choice,open_text",
            })
        job2 = GenerationJob.objects.get(pk=r2.json()["job_id"])
        self.assertEqual(job2.focus_kinds, [])

    def test_active_generation_is_user_scoped_and_prioritises_running(self):
        from .models import GenerationJob
        other_qs = QuestionSet.objects.create(room=self.room, title="Other")
        GenerationJob.objects.create(
            question_set=other_qs, created_by=self.owner, source_text="x",
            status=GenerationJob.Status.DONE,
        )
        running = GenerationJob.objects.create(
            question_set=self.qs, created_by=self.owner, source_text="x",
            status=GenerationJob.Status.RUNNING,
        )
        stranger = User.objects.create_user(username="zoe")
        GenerationJob.objects.create(
            question_set=self.qs, created_by=stranger, source_text="x",
            status=GenerationJob.Status.RUNNING,
        )
        with self.override_settings(**AI_ON):
            r = self.client.get("/api/question-sets/active-generation/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["id"], running.id)  # running > done, only mine
        self.assertIn("set_title", r.json())

    def test_reviewed_endpoint_sets_flag_and_404s_foreign(self):
        from .models import GenerationJob
        job = GenerationJob.objects.create(
            question_set=self.qs, created_by=self.owner, source_text="x",
            status=GenerationJob.Status.DONE,
        )
        with self.override_settings(**AI_ON):
            ok = self.client.post(f"{self.url}jobs/{job.pk}/reviewed/")
        self.assertEqual(ok.status_code, 200)
        job.refresh_from_db()
        self.assertTrue(job.reviewed)
        other_qs = QuestionSet.objects.create(room=self.room, title="Other")
        foreign = GenerationJob.objects.create(
            question_set=other_qs, created_by=self.owner, source_text="x")
        with self.override_settings(**AI_ON):
            r = self.client.post(f"{self.url}jobs/{foreign.pk}/reviewed/")
        self.assertEqual(r.status_code, 404)

    def test_set_active_returns_only_unreviewed(self):
        from .models import GenerationJob
        GenerationJob.objects.create(
            question_set=self.qs, created_by=self.owner, source_text="x",
            status=GenerationJob.Status.DONE, reviewed=True,
        )
        with self.override_settings(**AI_ON):
            r = self.client.get(f"{self.url}active/")
        self.assertEqual(r.json(), {})  # reviewed job is not surfaced


class OwnershipTests(ApiTestCase):
    """Besitzer, transfer and leave for shared rooms (#25/#26)."""

    def setUp(self):
        super().setUp()
        self.room.owner = self.owner
        self.room.save(update_fields=["owner"])

    def test_serializer_exposes_ownership(self):
        self.room.owners.add(self.other)
        data = self.client.get(f"/api/rooms/{self.room.pk}/").json()
        self.assertTrue(data["is_owner"])
        self.assertEqual(data["owner_count"], 2)
        self.assertEqual(data["owner_name"], "frank")
        # From the co-owner's perspective the room is shared with them.
        self.client.force_login(self.other)
        data = self.client.get(f"/api/rooms/{self.room.pk}/").json()
        self.assertFalse(data["is_owner"])

    def test_transfer_owner(self):
        self.room.owners.add(self.other)
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/transfer-owner/", {"user": self.other.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.room.refresh_from_db()
        self.assertEqual(self.room.owner, self.other)
        flags = {o["username"]: o["is_owner"] for o in response.json()["owners"]}
        self.assertEqual(flags, {"frank": False, "eve": True})

    def test_transfer_target_must_be_co_owner(self):
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/transfer-owner/", {"user": self.other.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_only_owner_can_transfer(self):
        self.room.owners.add(self.other)
        self.client.force_login(self.other)
        response = self.client.post(
            f"/api/rooms/{self.room.pk}/transfer-owner/", {"user": self.other.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_co_owner_can_leave(self):
        self.room.owners.add(self.other)
        self.client.force_login(self.other)
        response = self.client.post(f"/api/rooms/{self.room.pk}/leave/")
        self.assertEqual(response.status_code, 204)
        self.assertNotIn(self.other, self.room.owners.all())

    def test_owner_cannot_leave_without_transfer(self):
        self.room.owners.add(self.other)
        response = self.client.post(f"/api/rooms/{self.room.pk}/leave/")
        self.assertEqual(response.status_code, 409)
        self.assertIn(self.owner, self.room.owners.all())

    def test_besitzer_cannot_be_removed_before_transfer(self):
        self.room.owners.add(self.other)
        response = self.client.delete(
            f"/api/rooms/{self.room.pk}/owners/{self.owner.pk}/"
        )
        self.assertEqual(response.status_code, 409)

    def test_only_owner_can_delete_room(self):
        self.room.owners.add(self.other)
        self.client.force_login(self.other)
        response = self.client.delete(f"/api/rooms/{self.room.pk}/")
        self.assertEqual(response.status_code, 403)
        self.assertTrue(Room.objects.filter(pk=self.room.pk).exists())
        # The Besitzer may delete for everyone.
        self.client.force_login(self.owner)
        response = self.client.delete(f"/api/rooms/{self.room.pk}/")
        self.assertEqual(response.status_code, 204)
        self.assertFalse(Room.objects.filter(pk=self.room.pk).exists())

    def test_create_sets_owner(self):
        response = self.client.post(
            "/api/rooms/", {"title": "Neu"}, content_type="application/json"
        )
        room = Room.objects.get(pk=response.json()["id"])
        self.assertEqual(room.owner, self.owner)


class RoomVisibilityTests(TestCase):
    """The overview is personal for everyone; staff opts into the full list
    with ?all=1 (is_owner no longer implies staff, and is_member reflects
    shared/co-owned rooms)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner")
        self.other = User.objects.create_user(username="other")
        self.staff = User.objects.create_user(username="chef", is_staff=True)
        # A room owned by `owner`, with `other` as co-owner (member, not owner).
        with translation.override("de"):
            self.room = Room.objects.create(title="R", owner=self.owner)
        self.room.owners.add(self.owner, self.other)
        # A room fully foreign to `staff` (and to `other`).
        with translation.override("de"):
            self.foreign = Room.objects.create(title="F", owner=self.owner)
        self.foreign.owners.add(self.owner)

    def test_is_owner_false_for_staff_on_foreign_room(self):
        self.client.force_login(self.staff)
        # Staff is not a member of `foreign`, so the room is only reachable
        # via the ?all=1 opt-in — is_owner must still be false there (staff
        # privilege no longer implies ownership).
        r = self.client.get(f"/api/rooms/{self.foreign.pk}/?all=1")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["is_owner"])

    def test_is_owner_true_for_actual_owner(self):
        self.client.force_login(self.owner)
        r = self.client.get(f"/api/rooms/{self.room.pk}/")
        self.assertTrue(r.json()["is_owner"])

    def test_is_member_reflects_membership(self):
        self.client.force_login(self.other)
        r = self.client.get(f"/api/rooms/{self.room.pk}/")
        body = r.json()
        self.assertTrue(body["is_member"])
        self.assertFalse(body["is_owner"])  # co-owner, not the owner

    def test_is_member_false_for_non_member(self):
        # `staff` can see `foreign` via ?all=1 but is not one of its owners.
        self.client.force_login(self.staff)
        r = self.client.get(f"/api/rooms/{self.foreign.pk}/?all=1")
        self.assertFalse(r.json()["is_member"])

    def test_list_default_hides_foreign_rooms_even_for_staff(self):
        self.client.force_login(self.staff)
        r = self.client.get("/api/rooms/?page_size=1000")
        ids = {row["id"] for row in r.json()["results"]}
        self.assertNotIn(self.room.pk, ids)     # staff is not a member
        self.assertNotIn(self.foreign.pk, ids)

    def test_list_all_returns_everything_for_staff(self):
        self.client.force_login(self.staff)
        r = self.client.get("/api/rooms/?page_size=1000&all=1")
        ids = {row["id"] for row in r.json()["results"]}
        self.assertIn(self.room.pk, ids)
        self.assertIn(self.foreign.pk, ids)

    def test_all_param_ignored_for_non_staff(self):
        self.client.force_login(self.other)  # member of self.room only
        r = self.client.get("/api/rooms/?page_size=1000&all=1")
        ids = {row["id"] for row in r.json()["results"]}
        self.assertIn(self.room.pk, ids)
        self.assertNotIn(self.foreign.pk, ids)

    def test_staff_can_retrieve_foreign_room_detail_without_all_param(self):
        # Regression guard: get_object() (retrieve/update/destroy) must reach
        # every room for staff even without ?all=1 — only LIST is personal.
        self.client.force_login(self.staff)
        r = self.client.get(f"/api/rooms/{self.foreign.pk}/")
        self.assertEqual(r.status_code, 200)

    def test_non_staff_cannot_retrieve_foreign_room_detail(self):
        # Non-owner, non-staff must never reach a foreign room's detail.
        self.client.force_login(self.other)  # member of self.room, not foreign
        r = self.client.get(f"/api/rooms/{self.foreign.pk}/")
        self.assertEqual(r.status_code, 404)

    def test_owner_not_in_members_still_listed_by_default(self):
        # Legacy data (migration 0018_room_owner): owner FK set without
        # guaranteed owners M2M membership. Must still show up by default.
        u = User.objects.create_user(username="legacy_owner")
        with translation.override("de"):
            room = Room.objects.create(title="Legacy", owner=u)
        # Deliberately NOT room.owners.add(u).
        self.client.force_login(u)
        r = self.client.get("/api/rooms/?page_size=1000")
        self.assertEqual(r.status_code, 200)
        rows = {row["id"]: row for row in r.json()["results"]}
        self.assertIn(room.pk, rows)
        self.assertTrue(rows[room.pk]["is_owner"])

        detail = self.client.get(f"/api/rooms/{room.pk}/")
        self.assertEqual(detail.status_code, 200)

    def test_owned_room_category_stable_across_all_toggle(self):
        # A staff-owned room without owners M2M membership must appear in
        # both the default and the ?all=1 list as is_owner=True — it must
        # not "jump" into view only when toggling show-all.
        with translation.override("de"):
            room = Room.objects.create(title="StaffOwned", owner=self.staff)
        # Deliberately NOT room.owners.add(self.staff).
        self.client.force_login(self.staff)

        default = self.client.get("/api/rooms/?page_size=1000")
        default_rows = {row["id"]: row for row in default.json()["results"]}
        self.assertIn(room.pk, default_rows)
        self.assertTrue(default_rows[room.pk]["is_owner"])

        all_rooms = self.client.get("/api/rooms/?page_size=1000&all=1")
        all_rows = {row["id"]: row for row in all_rooms.json()["results"]}
        self.assertIn(room.pk, all_rows)
        self.assertTrue(all_rows[room.pk]["is_owner"])

    def test_ensure_owner_membership_adds_missing_owner(self):
        from rooms.migrations._owner_membership import ensure_owner_membership
        u = User.objects.create_user(username="lonelyowner")
        with translation.override("de"):
            r = Room.objects.create(title="legacy", owner=u)  # NOT added to owners
        self.assertFalse(r.owners.filter(pk=u.pk).exists())
        fixed = ensure_owner_membership(Room)
        self.assertGreaterEqual(fixed, 1)
        self.assertTrue(r.owners.filter(pk=u.pk).exists())
        # idempotent: this room is already fixed, so a second run counts it 0
        self.assertEqual(ensure_owner_membership(Room), 0)
        self.assertTrue(r.owners.filter(pk=u.pk).exists())


class ModeltranslationTests(TestCase):
    # Note: Django's LANGUAGE_CODE (UI default) is "en", while
    # MODELTRANSLATION_DEFAULT_LANGUAGE (content canonical) is "de" — these are
    # deliberately distinct (#33 MR1 vs MR2). Outside a request/override,
    # translation.get_language() returns LANGUAGE_CODE, not the content
    # default, so writing the "canonical" value needs an explicit override
    # here (a real request would have LocaleMiddleware set the active
    # language instead).
    def test_bare_field_follows_active_language_with_fallback(self):
        with translation.override("de"):
            room = Room.objects.create(title="Bio 101")  # canonical (de)
        room.title_en = "Biology 101"
        room.save()
        with translation.override("en"):
            self.assertEqual(Room.objects.get(pk=room.pk).title, "Biology 101")
        with translation.override("de"):
            self.assertEqual(Room.objects.get(pk=room.pk).title, "Bio 101")

    def test_missing_translation_falls_back_to_default(self):
        with translation.override("de"):
            room = Room.objects.create(title="Nur Deutsch")
        with translation.override("en"):
            self.assertEqual(Room.objects.get(pk=room.pk).title, "Nur Deutsch")


class TranslatedMapContractTests(ApiTestCase):
    """The {de,en}-map contract (TranslatedMapMixin) wired into the rooms
    serializers (#33 MR2 Task 2)."""

    def test_read_returns_language_map(self):
        # self.room's canonical (de) value was set in ApiTestCase.setUp.
        response = self.client.get(f"/api/rooms/{self.room.pk}/").json()
        self.assertEqual(response["title"], {"de": "Bio 101", "en": ""})

    def test_write_with_map_sets_both_columns(self):
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"title": {"de": "Biologie", "en": "Biology"}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], {"de": "Biologie", "en": "Biology"})
        self.room.refresh_from_db()
        self.assertEqual(self.room.title_de, "Biologie")
        self.assertEqual(self.room.title_en, "Biology")

    def test_empty_second_language_stores_none(self):
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"title": {"de": "Biologie", "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.room.refresh_from_db()
        self.assertEqual(self.room.title_de, "Biologie")
        self.assertIsNone(self.room.title_en)

    def test_legacy_plain_string_write_still_works(self):
        # Other apps' tests (and older clients) send {"title": "X"} — must
        # keep working, writing the canonical (de) language only.
        response = self.client.post(
            "/api/rooms/", {"title": "Legacy Title"}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        room = Room.objects.get(pk=response.json()["id"])
        self.assertEqual(room.title_de, "Legacy Title")
        self.assertIsNone(room.title_en)

    def test_overlong_value_returns_400(self):
        # The base field (and its max_length validator) is popped out before
        # DRF's own validation runs, so the mixin must enforce it itself —
        # an over-long value must come back as a clean 400 (like the plain
        # CharField used to give), not silently truncate to max_length or
        # fail at the DB.
        response = self.client.post(
            "/api/rooms/",
            {"title": {"de": "x" * 250, "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("title", response.json())
        self.assertFalse(Room.objects.filter(title_de__startswith="xxx").exists())

        # Same check on update, over the field's exact boundary (+1).
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"title": {"de": "y" * 201, "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.room.refresh_from_db()
        self.assertEqual(self.room.title_de, "Bio 101")  # unchanged

    def test_blank_full_map_update_is_noop(self):
        # Pre-map contract: a blank value on update means "keep the old
        # value" — for every language, not just the canonical one.
        self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"title": {"de": "Biologie", "en": "Biology"}},
            content_type="application/json",
        )
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"title": {"de": "", "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], {"de": "Biologie", "en": "Biology"})
        self.room.refresh_from_db()
        self.assertEqual(self.room.title_de, "Biologie")
        self.assertEqual(self.room.title_en, "Biology")

    def test_blank_secondary_language_clears_it_when_canonical_present(self):
        # When the canonical value IS explicitly provided, a blank secondary
        # is an intentional clear, not a no-op.
        self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"title": {"de": "Biologie", "en": "Biology"}},
            content_type="application/json",
        )
        response = self.client.patch(
            f"/api/rooms/{self.room.pk}/",
            {"title": {"de": "Neu", "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.room.refresh_from_db()
        self.assertEqual(self.room.title_de, "Neu")
        self.assertIsNone(self.room.title_en)

    def test_question_and_option_text_map_write_with_sanitizing(self):
        qset = QuestionSet.objects.create(room=self.room, title_de="T")
        response = self.client.post(
            "/api/questions/",
            {
                "question_set": qset.pk,
                "kind": "single_choice",
                "text": {"de": "<p>Hi<script>alert(1)</script></p>", "en": ""},
                "options": [
                    {"text": {"de": "4", "en": "four"}, "is_correct": True},
                    {"text": "5", "is_correct": False},  # legacy string mixed in
                ],
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        data = response.json()
        # validate_text (HTML sanitizing) still runs, per language.
        self.assertEqual(data["text"], {"de": "<p>Hi</p>", "en": ""})
        self.assertEqual(data["options"][0]["text"], {"de": "4", "en": "four"})
        self.assertEqual(data["options"][1]["text"], {"de": "5", "en": ""})

    def test_canonical_required_field_without_downstream_default_rejects_blank(self):
        # In this app, every translated field is either optional at the
        # model level (Question/AnswerOption.text: blank=True) or has its
        # own default-filling logic downstream (Room/QuestionSet/Section
        # title, via translated_optional_fields) — so none of them ever
        # actually hits the mixin's own canonical-required check through the
        # real API. That check is still real, generic behavior of
        # TranslatedMapMixin (for any future required translated field), so
        # exercise it directly against a minimal serializer that does NOT
        # opt the field out, over Room.title (required at the model level:
        # blank=False).
        class _StrictTitleSerializer(TranslatedMapMixin, serializers.ModelSerializer):
            translated_fields = ("title",)

            class Meta:
                model = Room
                fields: ClassVar = ["id", "title"]

        serializer = _StrictTitleSerializer(data={"title": {"de": "", "en": "B"}})
        self.assertFalse(serializer.is_valid())
        self.assertIn("title", serializer.errors)

    def test_room_blank_canonical_title_gets_timestamped_default_not_400(self):
        # Unlike the synthetic case above, RoomSerializer opts title out of
        # the mixin's required check (translated_optional_fields) because it
        # has its own blank -> timestamped-default logic in validate().
        response = self.client.post(
            "/api/rooms/", {"title": {"de": "", "en": "Keep me"}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        title = response.json()["title"]
        self.assertTrue(title["de"].startswith("Unbenannter Raum vom "))
        self.assertEqual(title["en"], "Keep me")  # untouched by the default

    def test_set_blank_canonical_title_gets_timestamped_default_not_400(self):
        response = self.client.post(
            "/api/question-sets/",
            {"room": self.room.pk, "title": {"de": "", "en": "Keep me"}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        title = response.json()["title"]
        self.assertTrue(title["de"].startswith("Unbenanntes Fragenset vom "))
        self.assertEqual(title["en"], "Keep me")

    def test_section_blank_canonical_title_gets_numbered_default_not_400(self):
        qset = QuestionSet.objects.create(room=self.room, title_de="Set")
        response = self.client.post(
            "/api/sections/",
            {"question_set": qset.pk, "title": {"de": "", "en": "Intro"}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["title"], {"de": "Abschnitt 1", "en": "Intro"})

    def test_title_uniqueness_enforced_on_canonical_language(self):
        first = self.client.post(
            "/api/question-sets/",
            {"room": self.room.pk, "title": {"de": "Termin 1", "en": "Session 1"}},
            content_type="application/json",
        )
        self.assertEqual(first.status_code, 201)
        # Same canonical (de) title, different English — still a clash.
        second = self.client.post(
            "/api/question-sets/",
            {"room": self.room.pk, "title": {"de": "termin 1", "en": "Different"}},
            content_type="application/json",
        )
        self.assertEqual(second.status_code, 400)

    def test_title_de_set_from_map_regardless_of_request_active_language(self):
        # Watch out: modeltranslation re-syncs a bare-assigned title from
        # the active language on save — verify our explicit title_de/_en
        # writes win even when the request's active UI language is "en"
        # (the request would normally set the active language via
        # LocaleMiddleware; force it here since the test client doesn't).
        with translation.override("en"):
            response = self.client.post(
                "/api/rooms/",
                {"title": {"de": "Deutscher Titel", "en": "English Title"}},
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 201)
        room = Room.objects.get(pk=response.json()["id"])
        self.assertEqual(room.title_de, "Deutscher Titel")
        self.assertEqual(room.title_en, "English Title")

    def test_markdown_to_html_conversion_helper(self):
        from rooms.migrations import _mdhtml
        self.assertEqual(_mdhtml.md_to_html(""), "")
        self.assertEqual(_mdhtml.md_to_html(None), "")
        out = _mdhtml.md_to_html("**b** and [x](https://e.org)\n\n- a\n- b")
        self.assertIn("<strong>b</strong>", out)
        self.assertIn('rel="noopener"', out)
        self.assertIn("<ul>", out)
        # already-HTML survives (idempotent-tolerant): tags preserved
        self.assertIn("<strong>x</strong>", _mdhtml.md_to_html("<p><strong>x</strong></p>"))


class AiGenerateLevelsTests(TestCase):
    def test_levels_constant(self):
        self.assertEqual(ai_generate.LEVELS, ("mixed", "basics", "deep"))
        self.assertEqual(ai_generate.DEFAULT_LEVEL, "mixed")

    def test_prompt_mixed_mentions_mixing_levels(self):
        p = ai_generate.build_generate_prompt("Stoff", 5, ["single_choice"], "mixed")
        low = p.lower()
        self.assertIn("misch", low)  # "Mische die kognitiven Ebenen …"
        self.assertIn("transfer", low)

    def test_prompt_basics_focuses_on_recall(self):
        p = ai_generate.build_generate_prompt("Stoff", 5, ["single_choice"], "basics")
        low = p.lower()
        self.assertIn("erinnern", low)
        self.assertIn("verstehen", low)

    def test_prompt_deep_focuses_on_analysis_transfer(self):
        p = ai_generate.build_generate_prompt("Stoff", 5, ["single_choice"], "deep")
        low = p.lower()
        self.assertIn("analyse", low)
        self.assertIn("transfer", low)

    def test_prompt_unknown_level_falls_back_to_mixed(self):
        p = ai_generate.build_generate_prompt("Stoff", 5, ["single_choice"], "bogus")
        self.assertEqual(
            p, ai_generate.build_generate_prompt("Stoff", 5, ["single_choice"], "mixed")
        )

    def test_prompt_declares_unsuitable_reason_contract(self):
        p = ai_generate.build_generate_prompt("Stoff", 5, ["single_choice"], "mixed")
        self.assertIn("unsuitable_reason", p)

    def test_prompt_focus_gives_priority_type_a_higher_share(self):
        # One focus among four types → ~50 % focus, ~17 % each of the rest.
        kinds = ["single_choice", "multiple_choice", "true_false", "open_text"]
        p = ai_generate.build_generate_prompt(
            "Stoff", 5, kinds, "mixed", focus_kinds=["multiple_choice"]
        )
        self.assertIn("Multiple Choice ~50 %", p)
        self.assertIn("Single Choice ~17 %", p)
        self.assertIn("Freitext ~17 %", p)

    def test_prompt_no_focus_is_even_split(self):
        p = ai_generate.build_generate_prompt(
            "Stoff", 5, ["single_choice", "open_text"], "mixed"
        )
        self.assertIn("Single Choice ~50 %", p)
        self.assertIn("Freitext ~50 %", p)

    def test_prompt_all_focus_falls_back_to_even_split(self):
        kinds = ["single_choice", "open_text"]
        p = ai_generate.build_generate_prompt(
            "Stoff", 5, kinds, "mixed", focus_kinds=kinds
        )
        # All-focus carries no priority → even split, same as no focus.
        self.assertIn("Single Choice ~50 %", p)
        self.assertIn("Freitext ~50 %", p)

    def test_true_false_draft_normalised_to_single_choice(self):
        data = {"questions": [
            {"kind": "true_false", "text": "Osnabrück ist die größte Stadt.", "correct": False},
            {"kind": "true_false", "text": "Wasser siedet bei 100 °C.", "correct": True},
        ]}
        drafts = ai_generate.build_drafts(data, ["true_false"], 5)
        self.assertEqual(len(drafts), 2)
        first = drafts[0]
        self.assertEqual(first["kind"], "single_choice")
        self.assertTrue(first["binary_choice"])  # gets the editor template chooser
        self.assertEqual([o["text"] for o in first["options"]], ["Wahr", "Falsch"])
        # correct=False -> Falsch is the correct option
        self.assertFalse(first["options"][0]["is_correct"])
        self.assertTrue(first["options"][1]["is_correct"])
        # correct=True -> Wahr is correct
        self.assertTrue(drafts[1]["options"][0]["is_correct"])

    def test_true_false_falls_back_to_options_shape(self):
        data = {"questions": [
            {"kind": "true_false", "text": "Aussage.",
             "options": [{"text": "Wahr", "is_correct": False},
                         {"text": "Falsch", "is_correct": True}]},
        ]}
        drafts = ai_generate.build_drafts(data, ["true_false"], 5)
        self.assertEqual(drafts[0]["kind"], "single_choice")
        self.assertTrue(drafts[0]["options"][1]["is_correct"])  # Falsch

    def test_true_false_is_an_allowed_generation_kind(self):
        self.assertIn("true_false", ai_generate.ALLOWED_KINDS)
        p = ai_generate.build_generate_prompt("Stoff", 5, ["true_false"], "mixed")
        self.assertIn("true_false", p)
        self.assertIn("correct", p)  # the boolean contract is documented

    def test_prompt_includes_guidance_when_given(self):
        p = ai_generate.build_generate_prompt(
            "Stoff", 5, ["single_choice"], "mixed", "Alltagsbeispiele verwenden"
        )
        self.assertIn("Alltagsbeispiele verwenden", p)
        self.assertIn("Lehrperson", p)  # framed as subordinate teacher wishes

    def test_prompt_omits_guidance_block_when_empty(self):
        p = ai_generate.build_generate_prompt(
            "Stoff", 5, ["single_choice"], "mixed", "   "
        )
        self.assertEqual(
            p, ai_generate.build_generate_prompt("Stoff", 5, ["single_choice"], "mixed")
        )

    def test_system_mentions_cognitive_variety_and_declining(self):
        s = ai_generate.generate_system().lower()
        # cognitive variety + "don't invent questions for unusable material"
        self.assertTrue("reflex" in s or "transfer" in s or "analyse" in s)
        self.assertIn("erfind", s)   # "erfinde keine Fragen"
        self.assertIn("keine", s)

    def test_unsuitable_reason_extracts_and_trims(self):
        self.assertEqual(ai_generate.unsuitable_reason({}), "")
        self.assertEqual(ai_generate.unsuitable_reason({"unsuitable_reason": 5}), "")
        self.assertEqual(
            ai_generate.unsuitable_reason({"unsuitable_reason": "  kein Lehrinhalt  "}),
            "kein Lehrinhalt",
        )
        long = "x" * 500
        self.assertEqual(len(ai_generate.unsuitable_reason({"unsuitable_reason": long})), 300)


class CollaboratorsTests(ApiTestCase):
    """Known-collaborators picker for room sharing (#55)."""

    def test_lists_known_collaborators_by_frequency(self):
        eve = self.other
        self.room.owners.add(eve)  # frank + eve share room 1
        bob = User.objects.create_user(username="bob", first_name="Bob")
        with translation.override("de"):
            room2 = Room.objects.create(title="Chemie 101")
        room2.owners.add(self.owner, eve, bob)  # frank + eve + bob share room 2
        User.objects.create_user(username="mallory")  # shares nothing with frank
        data = self.client.get("/api/rooms/collaborators/").json()["collaborators"]
        usernames = [c["username"] for c in data]
        # eve (2 shared rooms) before bob (1); self and non-collaborators excluded.
        self.assertEqual(usernames, ["eve", "bob"])
        self.assertNotIn("frank", usernames)
        self.assertNotIn("mallory", usernames)
        # No e-mail is exposed.
        self.assertEqual(set(data[0]), {"id", "username", "name"})

    def test_requires_auth(self):
        self.client.logout()
        self.assertIn(
            self.client.get("/api/rooms/collaborators/").status_code, (401, 403)
        )


class NormalizeImageTests(SimpleTestCase):
    """Unit tests for rooms.images.normalize_image (no DB)."""

    def _file(self, img, fmt, name):
        buffer = io.BytesIO()
        img.save(buffer, format=fmt)
        buffer.seek(0)
        buffer.name = name
        return buffer

    def _open(self, result):
        return Image.open(io.BytesIO(result.read()))

    def test_large_photo_downscaled_to_webp(self):
        # A noisy 3000x2000 true-color image (many colors → lossy photo path).
        img = Image.effect_noise((3000, 2000), 80).convert("RGB")
        src = self._file(img, "PNG", "photo.png")
        src_size = len(src.getvalue())
        result = normalize_image(src)
        self.assertTrue(result.name.endswith(".webp"))
        out = self._open(result)
        self.assertEqual(out.format, "WEBP")
        self.assertEqual(max(out.size), 1600)
        result.seek(0)
        self.assertLess(len(result.read()), src_size)

    def test_transparent_png_keeps_alpha_lossless(self):
        img = Image.new("RGBA", (500, 500), (0, 128, 0, 0))
        src = self._file(img, "PNG", "logo.png")
        result = normalize_image(src)
        out = self._open(result)
        self.assertEqual(out.format, "WEBP")
        self.assertEqual(out.mode, "RGBA")
        # Fully transparent pixel survives (lossless).
        self.assertEqual(out.getpixel((0, 0))[3], 0)

    def test_small_image_not_upscaled(self):
        img = Image.new("RGB", (400, 300), "green")
        src = self._file(img, "PNG", "small.png")
        result = normalize_image(src)
        out = self._open(result)
        self.assertEqual(out.size, (400, 300))

    def test_few_color_graphic_uses_lossless(self):
        # 8-color flat diagram → lossless path preserves exact colors.
        img = Image.new("RGB", (200, 200), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        draw.rectangle((10, 10, 90, 90), fill=(255, 0, 0))
        src = self._file(img, "PNG", "diagram.png")
        result = normalize_image(src)
        out = self._open(result).convert("RGB")
        self.assertEqual(out.getpixel((50, 50)), (255, 0, 0))

    def test_animated_gif_passthrough(self):
        # Distinct RGB fill colors per frame: a "P" image filled via a bare
        # palette index (e.g. Image.new("P", size, i)) has no palette set, so
        # every index renders as black and Pillow's GIF encoder collapses the
        # visually-identical frames down to a single frame (is_animated
        # False) — defeating the point of this test.
        frames = [Image.new("RGB", (100, 100), color) for color in ((255, 0, 0), (0, 255, 0), (0, 0, 255))]
        buffer = io.BytesIO()
        frames[0].save(buffer, format="GIF", save_all=True, append_images=frames[1:])
        buffer.seek(0)
        buffer.name = "anim.gif"
        original = buffer.getvalue()
        result = normalize_image(buffer)
        result.seek(0)
        self.assertEqual(result.read(), original)

    def test_garbage_raises_invalid_image(self):
        bad = io.BytesIO(b"not an image at all")
        bad.name = "evil.png"
        with self.assertRaises(InvalidImageError):
            normalize_image(bad)

    def test_decompression_bomb_raises_invalid_image(self):
        from unittest import mock

        img = Image.new("RGB", (100, 100), "green")
        src = self._file(img, "PNG", "bomb.png")
        # Force Pillow's decompression-bomb guard to fire on a small image.
        with mock.patch("PIL.Image.MAX_IMAGE_PIXELS", 10), self.assertRaises(
            InvalidImageError
        ):
            normalize_image(src)


class OnboardingSeedTests(TestCase):
    """Structural validity of the seeded example room (#78). The
    whoami-triggered, once-per-user hook is covered in accounts.tests."""

    def setUp(self):
        self.user = User.objects.create_user(username="new_user")
        self.room = seed_example_room(self.user)

    def test_room_owned_by_user_with_one_set(self):
        self.assertIn(self.user, self.room.owners.all())
        self.assertEqual(self.room.owner, self.user)
        self.assertEqual(self.room.question_sets.count(), 1)

    def test_one_question_of_every_kind(self):
        question_set = self.room.question_sets.get()
        kinds = list(question_set.questions.values_list("kind", flat=True))
        self.assertEqual(sorted(kinds), sorted(Question.Kind.values))
        self.assertEqual(len(kinds), len(set(kinds)))  # exactly one each

    def test_mindmap_is_last_with_bilingual_root_and_branches(self):
        last = self.room.question_sets.get().questions.order_by("position").last()
        self.assertEqual(last.kind, Question.Kind.MINDMAP)
        self.assertEqual((last.mindmap_root_de, last.mindmap_root_en), ("Gute Lehre", "Good teaching"))
        self.assertEqual(
            [(b["text"]["de"], b["text"]["en"]) for b in last.mindmap_seed],
            [("Inhalt", "Content"), ("Methoden", "Methods")],
        )
        self.assertFalse(last.mindmap_rating_mode)
        self.assertFalse(last.wordcloud_ai_enabled)

    def test_every_question_has_bilingual_text(self):
        question_set = self.room.question_sets.get()
        for question in question_set.questions.all():
            self.assertTrue(question.text_de.strip(), question.kind)
            self.assertTrue(question.text_en.strip(), question.kind)

    def test_every_option_has_bilingual_text(self):
        question_set = self.room.question_sets.get()
        options = AnswerOption.objects.filter(question__question_set=question_set)
        self.assertGreater(options.count(), 0)
        for option in options.exclude(question__kind=Question.Kind.LIKERT):
            self.assertTrue(option.text_de.strip())
            self.assertTrue(option.text_en.strip())

    def test_single_choice_has_exactly_one_correct_option(self):
        question = self._question(Question.Kind.SINGLE_CHOICE)
        self.assertEqual(question.options.filter(is_correct=True).count(), 1)
        self.assertEqual(question.options.count(), 3)

    def test_multiple_choice_allows_multiple_with_at_least_two_correct(self):
        question = self._question(Question.Kind.MULTIPLE_CHOICE)
        self.assertTrue(question.allow_multiple)
        self.assertGreaterEqual(question.options.filter(is_correct=True).count(), 2)

    def test_likert_is_negative_first_with_trailing_abstention(self):
        question = self._question(Question.Kind.LIKERT)
        options = list(question.options.all())  # ordered by position
        self.assertFalse(any(o.is_correct for o in options))
        scale = [o for o in options if not o.is_abstention]
        abstentions = [o for o in options if o.is_abstention]
        self.assertEqual(len(scale), 5)
        self.assertEqual(len(abstentions), 1)
        # position 0 = strongest disagreement (low pole); the abstention is last.
        self.assertEqual(scale[0].position, 0)
        # Like the editor's "agreement" preset: only the endpoints have text.
        self.assertEqual((scale[0].text_de, scale[0].text_en), ("Stimme nicht zu", "Disagree"))
        self.assertEqual((scale[-1].text_de, scale[-1].text_en), ("Stimme zu", "Agree"))
        for middle in scale[1:-1]:
            self.assertEqual((middle.text_de, middle.text_en), ("", ""))
        self.assertEqual(abstentions[0].text_de, "Enthaltung")
        self.assertEqual(abstentions[0].text_en, "Abstain")
        self.assertEqual(abstentions[0].position, options[-1].position)

    def test_word_cloud_allows_five_terms(self):
        question = self._question(Question.Kind.WORD_CLOUD)
        self.assertTrue(question.allow_multiple)
        self.assertEqual(question.wordcloud_max_answers, 5)

    def test_word_cloud_and_open_text_have_no_options(self):
        for kind in (Question.Kind.WORD_CLOUD, Question.Kind.OPEN_TEXT):
            question = self._question(kind)
            self.assertEqual(question.options.count(), 0)

    def test_priorities_and_ordering_have_at_least_three_options(self):
        for kind in (Question.Kind.PRIORITIES, Question.Kind.ORDERING):
            question = self._question(kind)
            self.assertGreaterEqual(question.options.count(), 3)

    def _question(self, kind):
        return self.room.question_sets.get().questions.get(kind=kind)


class ExampleResultsSeedTests(TestCase):
    """Example results seeded with the example room (guided tour v3.1): two
    finished runs in the past with answers to every question."""

    def setUp(self):
        self.user = User.objects.create_user(username="seed_results_user")
        self.room = seed_example_room(self.user)
        self.question_set = self.room.question_sets.get()

    def test_two_finished_runs_in_the_past_older_first(self):
        runs = list(self.question_set.runs.order_by("created_at"))
        self.assertEqual(len(runs), 2)
        today = timezone.localdate()
        for run in runs:
            self.assertEqual(run.phase, Run.Phase.FINISHED)
            self.assertIsNotNone(run.ended_at)
            self.assertLess(timezone.localdate(run.created_at), today)
        self.assertLess(runs[0].created_at, runs[1].created_at)

    def test_every_question_answered_in_every_run(self):
        for run in self.question_set.runs.all():
            for question in self.question_set.questions.exclude(kind=Question.Kind.MINDMAP):
                self.assertTrue(
                    run.votes.filter(question=question).exists(), (run.pk, question.kind)
                )

    def test_seeding_works_with_english_canonical_language(self):
        from django.test import override_settings
        from live.models import MindmapNode

        with override_settings(
            MODELTRANSLATION_DEFAULT_LANGUAGE="en", CONTENT_DEFAULT_LANGUAGE="en"
        ):
            user = User.objects.create_user(username="seed_en_canonical")
            room = seed_example_room(user)
            qset = room.question_sets.get()
            question = qset.questions.get(kind=Question.Kind.MINDMAP)
            for run in qset.runs.all():
                node = MindmapNode.objects.get(run=run, question=question, seed_i18n__text__de="Methoden")
                self.assertEqual(node.children.filter(seeded=False).count(), 4)

    def test_mindmap_contributions_in_both_runs(self):
        from live.models import MindmapContribution, MindmapNode

        question = self.question_set.questions.get(kind=Question.Kind.MINDMAP)
        for run in self.question_set.runs.all():
            nodes = MindmapNode.objects.filter(run=run, question=question)
            self.assertEqual(nodes.filter(seeded=True, parent=None).count(), 2)
            self.assertEqual(nodes.filter(seeded=False).count(), 7)
            total = MindmapContribution.objects.filter(node__in=nodes).count()
            self.assertGreaterEqual(total, 6)
            twice = nodes.get(text="Beispiele")
            self.assertEqual(twice.contributions.count(), 2)
            self.assertEqual(twice.parent.text, "Methoden")
            self.assertEqual(run.votes.filter(question=question).count(), 0)

    def test_participant_counts_per_run(self):
        older, newer = self.question_set.runs.order_by("created_at")
        single = self.question_set.questions.get(kind=Question.Kind.SINGLE_CHOICE)
        self.assertEqual(older.votes.filter(question=single).count(), 9)
        self.assertEqual(newer.votes.filter(question=single).count(), 12)

    def test_choice_and_text_votes_are_well_formed(self):
        questions = {q.kind: q for q in self.question_set.questions.all()}
        for vote in Vote.objects.filter(question=questions[Question.Kind.SINGLE_CHOICE]):
            self.assertEqual(vote.options.count(), 1)
        for vote in Vote.objects.filter(question=questions[Question.Kind.LIKERT]):
            self.assertEqual(vote.options.count(), 1)
        for vote in Vote.objects.filter(question=questions[Question.Kind.MULTIPLE_CHOICE]):
            self.assertGreaterEqual(vote.options.count(), 1)
        for kind in (Question.Kind.WORD_CLOUD, Question.Kind.OPEN_TEXT):
            for vote in Vote.objects.filter(question=questions[kind]):
                self.assertTrue(vote.text.strip(), kind)

    def test_priorities_rows_complete_and_within_budget(self):
        question = self.question_set.questions.get(kind=Question.Kind.PRIORITIES)
        option_ids = set(question.options.values_list("pk", flat=True))
        votes = Vote.objects.filter(question=question)
        self.assertTrue(votes.exists())
        for vote in votes:
            scores = list(vote.priority_scores.all())
            self.assertEqual({s.option_id for s in scores}, option_ids)
            self.assertLessEqual(sum(s.points for s in scores), 100)

    def test_ordering_responses_are_full_permutations(self):
        question = self.question_set.questions.get(kind=Question.Kind.ORDERING)
        option_ids = set(question.options.values_list("pk", flat=True))
        votes = Vote.objects.filter(question=question)
        self.assertTrue(votes.exists())
        for vote in votes:
            responses = list(vote.ordering_responses.all())
            self.assertEqual({r.option_id for r in responses}, option_ids)
            self.assertEqual(
                sorted(r.position for r in responses), list(range(len(option_ids)))
            )

    def test_results_endpoint_lists_both_runs(self):
        self.client.force_login(self.user)
        response = self.client.get(f"/api/question-sets/{self.question_set.pk}/results/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["results"]), 2)


class SetTypeModelTests(TestCase):
    def test_new_set_defaults_to_live_poll(self):
        room = Room.objects.create(title="R")
        qs = QuestionSet.objects.create(room=room, title="S")
        self.assertEqual(qs.type, QuestionSet.SetType.LIVE_POLL)
        self.assertEqual(qs.type, "live_poll")

    def test_quiz_time_limit_and_run_quiz_ends_at_default_to_none(self):
        # #75: overall time limit for Quiz-Block runs is opt-in.
        from live.models import Run

        room = Room.objects.create(title="R")
        qs = QuestionSet.objects.create(room=room, title="S")
        self.assertIsNone(qs.quiz_time_limit)

        run = Run.objects.create(question_set=qs)
        self.assertIsNone(run.quiz_ends_at)

    def test_present_results_after_defaults_to_true(self):
        # #75: post-run results walkthrough is opt-out, not opt-in.
        room = Room.objects.create(title="R")
        qs = QuestionSet.objects.create(room=room, title="S")
        self.assertTrue(qs.present_results_after)

    def test_allow_back_navigation_and_shuffle_questions_defaults(self):
        # #75 (Quiz-Block Phase 2): back-nav is opt-out, shuffling is opt-in.
        room = Room.objects.create(title="R")
        qs = QuestionSet.objects.create(room=room, title="S")
        self.assertTrue(qs.allow_back_navigation)
        self.assertFalse(qs.shuffle_questions)


class SelfCheckTokenModelTests(TestCase):
    """#75 Phase 3 (Lernkontrolle): permanent publish link, mirroring
    share_token/enable_sharing/disable_sharing."""

    def test_enable_self_check_sets_token_and_is_idempotent(self):
        room = Room.objects.create(title="R")
        qs = QuestionSet.objects.create(room=room, title="S")
        self.assertIsNone(qs.self_check_token)

        qs.enable_self_check()
        self.assertIsNotNone(qs.self_check_token)
        # secrets.token_urlsafe(16)[:32] -> 22 chars, well under max_length=32,
        # same as share_token.
        self.assertLessEqual(len(qs.self_check_token), 32)
        self.assertGreater(len(qs.self_check_token), 0)

        token = qs.self_check_token
        qs.enable_self_check()
        self.assertEqual(qs.self_check_token, token)

    def test_disable_self_check_clears_token(self):
        room = Room.objects.create(title="R")
        qs = QuestionSet.objects.create(room=room, title="S")
        qs.enable_self_check()
        self.assertIsNotNone(qs.self_check_token)

        qs.disable_self_check()
        self.assertIsNone(qs.self_check_token)


class SetTypeRulesTests(TestCase):
    def test_allowed_kinds_permissive_types(self):
        allk = tuple(k for k, _ in Question.Kind.choices)
        self.assertEqual(set(set_types.allowed_kinds("live_poll")), set(allk))
        # Mindmap is a shared live activity: live polls only.
        self.assertEqual(
            set(set_types.allowed_kinds("self_paced")), set(allk) - {"mindmap"}
        )

    def test_allowed_kinds_self_check(self):
        self.assertEqual(
            set(set_types.allowed_kinds("self_check")),
            {"single_choice", "multiple_choice", "ordering", "open_text"},
        )


class QuestionKindGatingTests(ApiTestCase):
    # Reuses the authed owner client (self.owner/self.room) from ApiTestCase.

    def _create_q(self, qs, kind, **extra):
        return self.client.post(
            "/api/questions/",
            {
                "question_set": qs.pk,
                "kind": kind,
                "text": {"de": "F", "en": "Q"},
                "options": [
                    {"text": {"de": "A", "en": "A"}, "is_correct": True},
                    {"text": {"de": "B", "en": "B"}},
                ],
                **extra,
            },
            content_type="application/json",
        )

    def test_disallowed_kind_for_self_check_rejected(self):
        qs = QuestionSet.objects.create(room=self.room, title="S", type="self_check")
        r = self._create_q(qs, "likert")  # likert not allowed in self_check
        self.assertEqual(r.status_code, 400)

    def test_open_text_in_self_check_without_solution_is_allowed(self):
        # No hard requirement: the editor shows a bypassable warning (#75).
        qs = QuestionSet.objects.create(room=self.room, title="S", type="self_check")
        r = self.client.post(
            "/api/questions/",
            {
                "question_set": qs.pk,
                "kind": "open_text",
                "text": {"de": "F", "en": "Q"},
                "options": [],
            },
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201)
        r2 = self.client.post(
            "/api/questions/",
            {
                "question_set": qs.pk,
                "kind": "open_text",
                "text": {"de": "F", "en": "Q"},
                "options": [],
                "model_solution": "Paris",
            },
            content_type="application/json",
        )
        self.assertEqual(r2.status_code, 201)

    def test_all_kinds_allowed_in_live_poll(self):
        qs = QuestionSet.objects.create(room=self.room, title="S", type="live_poll")
        self.assertEqual(self._create_q(qs, "single_choice").status_code, 201)

    def test_self_check_open_text_forces_participant_feedback(self):
        qs = QuestionSet.objects.create(room=self.room, title="S", type="self_check")
        r = self.client.post(
            "/api/questions/",
            {
                "question_set": qs.pk,
                "kind": "open_text",
                "text": {"de": "F", "en": "Q"},
                "options": [],
                "model_solution": "Paris",
                "participant_feedback": False,  # client tries to turn it off
            },
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201)
        self.assertTrue(Question.objects.get(pk=r.json()["id"]).participant_feedback)

class SetTypeApiTests(ApiTestCase):
    # Reuses the authed owner client (self.owner/self.room) from ApiTestCase.

    def test_create_with_type(self):
        r = self.client.post("/api/question-sets/", {
            "room": self.room.pk, "title": "S", "type": "self_paced",
        }, content_type="application/json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["type"], "self_paced")

    def test_type_defaults_to_live_poll(self):
        r = self.client.post("/api/question-sets/", {
            "room": self.room.pk, "title": "S",
        }, content_type="application/json")
        self.assertEqual(r.json()["type"], "live_poll")

    def test_type_is_immutable_on_update(self):
        qs = QuestionSet.objects.create(room=self.room, title="S", type="live_poll")
        r = self.client.patch(f"/api/question-sets/{qs.pk}/", {
            "type": "self_paced",
        }, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        qs.refresh_from_db()
        self.assertEqual(qs.type, "live_poll")  # unchanged

    def test_quiz_time_limit_on_self_paced_create(self):
        r = self.client.post("/api/question-sets/", {
            "room": self.room.pk, "title": "S", "type": "self_paced",
            "quiz_time_limit": 300,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["quiz_time_limit"], 300)

    def test_present_results_after_create_false_stores_false(self):
        # #75: serializer round-trips the opt-out explicitly.
        r = self.client.post("/api/question-sets/", {
            "room": self.room.pk, "title": "S", "type": "self_paced",
            "present_results_after": False,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 201)
        self.assertFalse(r.json()["present_results_after"])
        qs = QuestionSet.objects.get(pk=r.json()["id"])
        self.assertFalse(qs.present_results_after)

    def test_allow_back_navigation_and_shuffle_questions_create_non_default(self):
        # #75 (Quiz-Block Phase 2): serializer round-trips both opt-outs/opt-ins.
        r = self.client.post("/api/question-sets/", {
            "room": self.room.pk, "title": "S", "type": "self_paced",
            "allow_back_navigation": False,
            "shuffle_questions": True,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 201)
        self.assertFalse(r.json()["allow_back_navigation"])
        self.assertTrue(r.json()["shuffle_questions"])
        qs = QuestionSet.objects.get(pk=r.json()["id"])
        self.assertFalse(qs.allow_back_navigation)
        self.assertTrue(qs.shuffle_questions)

    def test_quiz_time_limit_nulled_for_live_poll_create(self):
        r = self.client.post("/api/question-sets/", {
            "room": self.room.pk, "title": "S", "type": "live_poll",
            "quiz_time_limit": 300,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 201)
        qs = QuestionSet.objects.get(pk=r.json()["id"])
        self.assertIsNone(qs.quiz_time_limit)

    def test_quiz_time_limit_patch_persists_on_self_paced(self):
        qs = QuestionSet.objects.create(room=self.room, title="S", type="self_paced")
        r = self.client.patch(f"/api/question-sets/{qs.pk}/", {
            "quiz_time_limit": 600,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        qs.refresh_from_db()
        self.assertEqual(qs.quiz_time_limit, 600)

    def test_quiz_time_limit_rejects_non_positive(self):
        qs = QuestionSet.objects.create(room=self.room, title="S", type="self_paced")
        r = self.client.patch(f"/api/question-sets/{qs.pk}/", {
            "quiz_time_limit": 0,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/question-sets/{qs.pk}/", {
            "quiz_time_limit": -5,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_quiz_time_limit_patch_to_null_clears_it(self):
        qs = QuestionSet.objects.create(
            room=self.room, title="S", type="self_paced", quiz_time_limit=300,
        )
        r = self.client.patch(f"/api/question-sets/{qs.pk}/", {
            "quiz_time_limit": None,
        }, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        qs.refresh_from_db()
        self.assertIsNone(qs.quiz_time_limit)

    def test_quiz_time_limit_unchanged_when_not_in_patch(self):
        qs = QuestionSet.objects.create(
            room=self.room, title="S", type="self_paced", quiz_time_limit=300,
        )
        r = self.client.patch(f"/api/question-sets/{qs.pk}/", {
            "title": "New title",
        }, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        qs.refresh_from_db()
        self.assertEqual(qs.quiz_time_limit, 300)


class SelfCheckPublishStatsApiTests(ApiTestCase):
    """#75 Phase 3 (Lernkontrolle): owner actions to publish/unpublish a
    self_check set and read/reset its anonymous attempt stats."""

    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(
            room=self.room, title="Lernkontrolle", type="self_check"
        )

    def publish(self):
        return self.client.post(
            f"/api/question-sets/{self.question_set.pk}/self-check/publish/"
        )

    def unpublish(self):
        return self.client.post(
            f"/api/question-sets/{self.question_set.pk}/self-check/unpublish/"
        )

    def stats(self, method="get"):
        url = f"/api/question-sets/{self.question_set.pk}/self-check/stats/"
        return getattr(self.client, method)(url)

    def test_publish_returns_token_and_is_idempotent(self):
        response = self.publish()
        self.assertEqual(response.status_code, 200)
        token = response.json()["self_check_token"]
        self.assertTrue(token)
        # Publishing again keeps the same token (link stays stable).
        response = self.publish()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["self_check_token"], token)

    def test_publish_rejects_non_self_check_set(self):
        live_poll = QuestionSet.objects.create(
            room=self.room, title="Runde", type="live_poll"
        )
        response = self.client.post(
            f"/api/question-sets/{live_poll.pk}/self-check/publish/"
        )
        self.assertEqual(response.status_code, 400)

    def test_unpublish_clears_token(self):
        self.publish()
        response = self.unpublish()
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["self_check_token"])
        self.question_set.refresh_from_db()
        self.assertIsNone(self.question_set.self_check_token)

    def test_stats_empty(self):
        response = self.stats()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"attempts": 0, "correct": 0, "scored": 0, "ratio": None},
        )

    def test_stats_aggregates_attempts(self):
        from live.models import SelfCheckAttempt

        SelfCheckAttempt.objects.create(
            question_set=self.question_set, correct=3, scored=4
        )
        SelfCheckAttempt.objects.create(
            question_set=self.question_set, correct=1, scored=2
        )
        response = self.stats()
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["attempts"], 2)
        self.assertEqual(payload["correct"], 4)
        self.assertEqual(payload["scored"], 6)
        self.assertAlmostEqual(payload["ratio"], 4 / 6)

    def test_stats_delete_resets_attempts(self):
        from live.models import SelfCheckAttempt

        SelfCheckAttempt.objects.create(
            question_set=self.question_set, correct=3, scored=4
        )
        response = self.stats(method="delete")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"attempts": 0, "correct": 0, "scored": 0, "ratio": None},
        )
        self.assertEqual(
            SelfCheckAttempt.objects.filter(question_set=self.question_set).count(), 0
        )

    def test_non_owner_gets_404(self):
        self.client.force_login(self.other)
        self.assertEqual(self.publish().status_code, 404)
        self.assertEqual(self.unpublish().status_code, 404)
        self.assertEqual(self.stats().status_code, 404)


class GenerationJobModelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="frank")
        self.room = Room.objects.create(title="Bio 101")

    def test_defaults_and_is_active(self):
        from .models import GenerationJob

        qs = QuestionSet.objects.create(room=self.room, title="T")
        job = GenerationJob.objects.create(
            question_set=qs, created_by=self.user, source_text="Stoff", kinds=["open_text"],
        )
        self.assertEqual(job.status, GenerationJob.Status.PENDING)
        self.assertEqual(job.drafts, [])
        self.assertFalse(job.truncated)
        self.assertTrue(job.is_active)
        job.status = GenerationJob.Status.DONE
        self.assertFalse(job.is_active)

    def test_new_fields_defaults(self):
        from .models import GenerationJob

        qs = QuestionSet.objects.create(room=self.room, title="T2")
        job = GenerationJob.objects.create(
            question_set=qs, created_by=self.user, source_text="x")
        self.assertEqual(job.pages, 0)
        self.assertEqual(job.density, 1.0)
        self.assertEqual(job.target_count, 0)
        self.assertFalse(job.reviewed)


class GenerationChunkingTests(TestCase):
    def test_chunk_splits_on_whitespace_and_caps(self):
        from .generation import chunk_text
        text = " ".join(f"wort{i}" for i in range(1000))  # ~ many words
        chunks, truncated = chunk_text(text, chunk_chars=50, max_chunks=3)
        self.assertEqual(len(chunks), 3)
        self.assertTrue(truncated)
        self.assertTrue(all(len(c) <= 110 for c in chunks))  # grows up to 2*chunk_chars
        self.assertNotIn("  ", " ".join(chunks))

    def test_chunk_no_truncation_when_it_fits(self):
        from .generation import chunk_text
        chunks, truncated = chunk_text("a b c", chunk_chars=1000, max_chunks=40)
        self.assertEqual(chunks, ["a b c"])
        self.assertFalse(truncated)

    def test_chunk_grows_to_cover_whole_doc_without_truncation(self):
        from .generation import chunk_text
        # 900 chars: more than max_chunks*chunk_chars (500) would hold at the
        # base size, but within the 2*chunk_chars-grown budget (1000) — so
        # growth is required, and is enough, to avoid truncation.
        text = "w " * 450
        chunks, truncated = chunk_text(text, chunk_chars=100, max_chunks=5)
        self.assertFalse(truncated)
        self.assertLessEqual(len(chunks), 5)
        self.assertEqual("".join(c.replace(" ", "") for c in chunks),
                         text.replace(" ", ""))  # nothing dropped

    def test_chunk_truncates_only_beyond_grown_budget(self):
        from .generation import chunk_text
        text = "w " * 100000  # far over 2*chunk_chars*max_chunks
        chunks, truncated = chunk_text(text, chunk_chars=100, max_chunks=5)
        self.assertTrue(truncated)
        self.assertEqual(len(chunks), 5)

    def test_merge_drafts_dedupes_by_normalised_text(self):
        from .generation import merge_drafts
        existing = [{"kind": "open_text", "text": "Was ist Usability?"}]
        new = [
            {"kind": "open_text", "text": "  was ist usability? "},  # dup (norm)
            {"kind": "open_text", "text": "Was ist Ergonomie?"},     # new
        ]
        out = merge_drafts(existing, new)
        self.assertEqual([d["text"] for d in out],
                         ["Was ist Usability?", "Was ist Ergonomie?"])

    def test_merge_drafts_skips_empty_text(self):
        from .generation import merge_drafts, norm_question
        self.assertEqual(norm_question(""), "")          # empty -> falsy key
        out = merge_drafts([], [
            {"kind": "open_text", "text": "   "},          # blank -> skipped
            {"kind": "open_text", "text": "Echte Frage?"}, # kept
        ])
        self.assertEqual([d["text"] for d in out], ["Echte Frage?"])


class GenerationWorkerTests(TransactionTestCase):
    """Uses TransactionTestCase (not TestCase) because run_generation_job()
    calls connections.close_all() to get a fresh DB connection (needed when
    it later runs on a worker thread) — inside the default TestCase's
    wrapping transaction that raises "Cannot open a new connection in an
    atomic block" (see ConcurrentStartRunTests in live/tests.py)."""

    def setUp(self):
        super().setUp()
        from .models import GenerationJob
        self.user = User.objects.create_user(username="frank")
        self.room = Room.objects.create(title="Bio 101")
        self.GenerationJob = GenerationJob
        self.qs = QuestionSet.objects.create(room=self.room, title="T")

    def _job(self, text):
        return self.GenerationJob.objects.create(
            question_set=self.qs, created_by=self.user, source_text=text,
            kinds=["open_text"], level="mixed",
        )

    def test_processes_all_chunks_and_dedupes(self):
        from unittest import mock

        from django.test import override_settings

        from . import generation
        job = self._job("A " * 100 + " B " * 100)  # forces 2 chunks at small chunk size
        replies = [
            {"questions": [{"kind": "open_text", "text": "Frage 1"}]},
            {"questions": [{"kind": "open_text", "text": "Frage 1"}]},  # dup across chunks
        ]
        with override_settings(**AI_ON, AI_CHUNK_CHARS=210, AI_GEN_MAX_CHUNKS=40), \
             mock.patch("rooms.generation.ai.chat_json", side_effect=replies):
            generation.run_generation_job(job.id)
        job.refresh_from_db()
        self.assertEqual(job.status, self.GenerationJob.Status.DONE)
        self.assertEqual(job.total_chunks, 2)
        self.assertEqual(job.done_chunks, 2)
        self.assertEqual([d["text"] for d in job.drafts], ["Frage 1"])  # deduped

    def test_sweep_orphaned_jobs_fails_running_jobs(self):
        # A RUNNING job whose worker died with the previous process is
        # reclaimed by the startup sweep (which runs in a thread off the ASGI
        # loop, hence the connections.close_all() path this class requires).
        from . import generation
        job = self._job("x")
        self.GenerationJob.objects.filter(pk=job.id).update(
            status=self.GenerationJob.Status.RUNNING
        )
        generation.sweep_orphaned_jobs()
        job.refresh_from_db()
        self.assertEqual(job.status, self.GenerationJob.Status.FAILED)
        self.assertIn("Neustart", job.error)

    def test_truncation_sets_flag_and_notice(self):
        from unittest import mock

        from django.test import override_settings

        from . import generation
        job = self._job("x " * 500)  # many chunks
        with override_settings(**AI_ON, AI_CHUNK_CHARS=20, AI_GEN_MAX_CHUNKS=2), \
             mock.patch("rooms.generation.ai.chat_json",
                        return_value={"questions": [{"kind": "open_text", "text": "F"}]}):
            generation.run_generation_job(job.id)
        job.refresh_from_db()
        self.assertTrue(job.truncated)
        self.assertEqual(job.total_chunks, 2)  # capped
        self.assertIn("überschreit", job.notice.lower())

    def test_chunk_error_is_skipped(self):
        from unittest import mock

        from basicbar_integrations.ai import AIError
        from django.test import override_settings

        from . import generation
        job = self._job("A " * 100 + " B " * 100)
        with override_settings(**AI_ON, AI_CHUNK_CHARS=210, AI_GEN_MAX_CHUNKS=40), \
             mock.patch("rooms.generation.ai.chat_json",
                        side_effect=[AIError("boom"),
                                     {"questions": [{"kind": "open_text", "text": "F2"}]}]):
            generation.run_generation_job(job.id)
        job.refresh_from_db()
        self.assertEqual(job.status, self.GenerationJob.Status.DONE)
        self.assertEqual([d["text"] for d in job.drafts], ["F2"])
        self.assertEqual(job.done_chunks, 2)

    def test_cancel_observed_mid_run_stays_cancelled(self):
        from unittest import mock

        from django.test import override_settings

        from . import generation
        job = self._job("A " * 100 + " B " * 100)  # forces 2+ chunks at small chunk size

        def cancel_then_reply(*args, **kwargs):
            self.GenerationJob.objects.filter(pk=job.id).update(
                status=self.GenerationJob.Status.CANCELLED
            )
            return {"questions": [{"kind": "open_text", "text": "Frage 1"}]}

        with override_settings(**AI_ON, AI_CHUNK_CHARS=50, AI_GEN_MAX_CHUNKS=40), \
             mock.patch("rooms.generation.ai.chat_json", side_effect=cancel_then_reply):
            generation.run_generation_job(job.id)
        job.refresh_from_db()
        self.assertEqual(job.status, self.GenerationJob.Status.CANCELLED)

    def test_target_count_distributed_and_capped(self):
        from unittest import mock

        from django.test import override_settings

        from . import generation
        job = self._job("A " * 100 + " B " * 100)  # 2 chunks at small size
        job.target_count = 2
        job.save(update_fields=["target_count"])
        replies = [
            {"questions": [{"kind": "open_text", "text": "F1"},
                           {"kind": "open_text", "text": "F2"}]},
            {"questions": [{"kind": "open_text", "text": "F3"}]},
        ]
        with override_settings(**AI_ON, AI_CHUNK_CHARS=210, AI_GEN_MAX_CHUNKS=40), \
             mock.patch("rooms.generation.ai.chat_json", side_effect=replies):
            generation.run_generation_job(job.id)
        job.refresh_from_db()
        self.assertEqual(job.status, self.GenerationJob.Status.DONE)
        self.assertEqual(len(job.drafts), 2)  # capped at target_count

    def test_cancel_during_last_chunk_not_overwritten_with_done(self):
        from unittest import mock

        from django.test import override_settings

        from . import generation
        job = self._job("A B C")  # a single chunk with a generous chunk size

        def cancel_then_reply(*args, **kwargs):
            self.GenerationJob.objects.filter(pk=job.id).update(
                status=self.GenerationJob.Status.CANCELLED
            )
            return {"questions": [{"kind": "open_text", "text": "Frage 1"}]}

        with override_settings(**AI_ON, AI_CHUNK_CHARS=1000, AI_GEN_MAX_CHUNKS=40), \
             mock.patch("rooms.generation.ai.chat_json", side_effect=cancel_then_reply):
            generation.run_generation_job(job.id)
        job.refresh_from_db()
        self.assertEqual(job.status, self.GenerationJob.Status.CANCELLED)


class MindmapAuthoringTests(ApiTestCase):
    """Mindmap question kind (stage 1, Task 1): settings, predefined
    branches (seed), set-type gating and transfer."""

    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(room=self.room, title_de="Live")

    def _create(self, question_set=None, **overrides):
        payload = {
            "question_set": (question_set or self.question_set).pk,
            "kind": "mindmap",
            "text": {"de": "<p>Was gehört zu Nachhaltigkeit?</p>", "en": ""},
            "options": [],
        }
        payload.update(overrides)
        return self.client.post("/api/questions/", payload, content_type="application/json")

    def _update(self, question, **fields):
        return self.client.patch(
            f"/api/questions/{question['id']}/", fields, content_type="application/json"
        )

    def test_create_with_defaults(self):
        response = self._create()
        self.assertEqual(response.status_code, 201, response.content)
        data = response.json()
        self.assertEqual(data["kind"], "mindmap")
        self.assertEqual(data["mindmap_root"], {"de": "", "en": ""})
        self.assertEqual(data["mindmap_depth"], 5)
        self.assertEqual(data["mindmap_max_per_person"], 10)
        self.assertFalse(data["mindmap_descriptions"])
        self.assertTrue(data["mindmap_highlight_duplicates"])
        self.assertEqual(data["mindmap_seed"], [])
        self.assertEqual(data["options"], [])

    def test_root_label_is_translatable(self):
        response = self._create(mindmap_root={"de": "Nachhaltigkeit", "en": "Sustainability"})
        self.assertEqual(response.status_code, 201, response.content)
        question = Question.objects.get(pk=response.json()["id"])
        self.assertEqual(question.mindmap_root_de, "Nachhaltigkeit")
        self.assertEqual(question.mindmap_root_en, "Sustainability")
        self.assertEqual(
            response.json()["mindmap_root"], {"de": "Nachhaltigkeit", "en": "Sustainability"}
        )

    def test_root_label_max_length(self):
        response = self._create(mindmap_root={"de": "x" * 61, "en": ""})
        self.assertEqual(response.status_code, 400)
        self.assertIn("mindmap_root", response.json())

    def test_options_rejected(self):
        response = self._create(options=[{"text": "A"}, {"text": "B"}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("options", response.json())

    def test_settings_saved(self):
        response = self._create(
            mindmap_depth=3, mindmap_max_per_person=0,
            mindmap_descriptions=True, mindmap_highlight_duplicates=False,
        )
        self.assertEqual(response.status_code, 201, response.content)
        question = Question.objects.get(pk=response.json()["id"])
        self.assertEqual(question.mindmap_depth, 3)
        self.assertEqual(question.mindmap_max_per_person, 0)
        self.assertTrue(question.mindmap_descriptions)
        self.assertFalse(question.mindmap_highlight_duplicates)

    def test_depth_range(self):
        for bad in (0, 9):
            response = self._create(mindmap_depth=bad)
            self.assertEqual(response.status_code, 400, bad)
            self.assertIn("mindmap_depth", response.json())
        for ok in (1, 8):
            self.assertEqual(self._create(mindmap_depth=ok).status_code, 201, ok)

    def test_max_per_person_not_negative(self):
        response = self._create(mindmap_max_per_person=-1)
        self.assertEqual(response.status_code, 400)
        self.assertIn("mindmap_max_per_person", response.json())

    def test_seed_is_normalised(self):
        seed = [
            {"text": "  Ökologie ", "children": [
                {"text": "Klima   schutz", "description": " CO2 ", "children": []},
            ]},
            {"text": "Soziales", "description": "", "extra": "dropped"},
        ]
        response = self._create(mindmap_seed=seed)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(
            response.json()["mindmap_seed"],
            [
                {"text": {"de": "Ökologie", "en": ""},
                 "description": {"de": "", "en": ""}, "children": [
                    {"text": {"de": "Klima schutz", "en": ""},
                     "description": {"de": "CO2", "en": ""}, "children": []},
                ]},
                {"text": {"de": "Soziales", "en": ""},
                 "description": {"de": "", "en": ""}, "children": []},
            ],
        )

    def test_seed_bilingual_maps(self):
        seed = [
            {"text": {"de": " Ökologie ", "en": "Ecology  "},
             "description": {"de": "Umwelt", "en": "Environment"}, "children": [
                {"text": {"de": "Klima", "en": ""}, "children": []},
            ]},
        ]
        response = self._create(mindmap_seed=seed)
        self.assertEqual(response.status_code, 201, response.content)
        stored = response.json()["mindmap_seed"]
        self.assertEqual(stored[0]["text"], {"de": "Ökologie", "en": "Ecology"})
        self.assertEqual(
            stored[0]["description"], {"de": "Umwelt", "en": "Environment"}
        )
        self.assertEqual(stored[0]["children"][0]["text"], {"de": "Klima", "en": ""})

    def test_seed_bilingual_validation(self):
        cases = {
            "canonical term missing": [{"text": {"de": "", "en": "Ecology"}}],
            "translation too long": [{"text": {"de": "a", "en": "x" * 61}}],
            "translated description too long": [
                {"text": "a", "description": {"de": "", "en": "d" * 201}}
            ],
            "duplicate canonical": [
                {"text": {"de": "Klima", "en": "Climate"}},
                {"text": {"de": "klima", "en": "Weather"}},
            ],
        }
        for label, seed in cases.items():
            response = self._create(mindmap_seed=seed)
            self.assertEqual(response.status_code, 400, label)
            self.assertIn("mindmap_seed", response.json(), label)
        # Same translation under different canonical terms is fine: only the
        # canonical term is the merge key.
        response = self._create(mindmap_seed=[
            {"text": {"de": "Klima", "en": "Climate"}},
            {"text": {"de": "Wetter", "en": "Climate"}},
        ])
        self.assertEqual(response.status_code, 201, response.content)

    def test_seed_rejects_invalid_structures(self):
        cases = {
            "not a list": "Ökologie",
            "empty term": [{"text": "  "}],
            "too long": [{"text": "x" * 61}],
            "description too long": [{"text": "a", "description": "d" * 201}],
            "duplicate siblings": [{"text": "Klima"}, {"text": " klima "}],
            "children not a list": [{"text": "a", "children": "b"}],
            "too many": [{"text": f"t{i}"} for i in range(101)],
        }
        for label, seed in cases.items():
            response = self._create(mindmap_seed=seed)
            self.assertEqual(response.status_code, 400, label)
            self.assertIn("mindmap_seed", response.json(), label)

    def test_seed_depth_limited_by_mindmap_depth(self):
        seed = [{"text": "a", "children": [{"text": "b", "children": [{"text": "c"}]}]}]
        self.assertEqual(self._create(mindmap_depth=2, mindmap_seed=seed).status_code, 400)
        self.assertEqual(self._create(mindmap_depth=3, mindmap_seed=seed).status_code, 201)

    def test_same_term_under_different_parents_allowed(self):
        seed = [
            {"text": "a", "children": [{"text": "x"}]},
            {"text": "b", "children": [{"text": "X"}]},
        ]
        self.assertEqual(self._create(mindmap_seed=seed).status_code, 201)

    def test_lowering_depth_below_existing_seed_rejected(self):
        seed = [{"text": "a", "children": [{"text": "b"}]}]
        created = self._create(mindmap_seed=seed).json()
        response = self._update(created, mindmap_depth=1)
        self.assertEqual(response.status_code, 400)
        self.assertIn("mindmap_seed", response.json())

    def test_editor_save_needs_no_options(self):
        created = self._create().json()
        response = self._update(
            created, text={"de": "<p>Neu</p>", "en": ""}, options=[],
            mindmap_seed=[{"text": "Ast"}],
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["mindmap_seed"][0]["text"], {"de": "Ast", "en": ""}
        )

    def test_only_allowed_in_live_polls(self):
        for set_type in ("self_paced", "self_check"):
            qs = QuestionSet.objects.create(room=self.room, title=set_type, type=set_type)
            response = self._create(question_set=qs)
            self.assertEqual(response.status_code, 400, set_type)
            self.assertIn("kind", response.json())

    def _mindmap_question(self, question_set=None):
        return Question.objects.create(
            question_set=question_set or self.question_set,
            kind="mindmap",
            text_de="<p>Begriffe?</p>", text_en="<p>Terms?</p>",
            mindmap_root_de="Wurzel", mindmap_root_en="Root",
            mindmap_depth=3, mindmap_max_per_person=4,
            mindmap_descriptions=True, mindmap_highlight_duplicates=False,
            mindmap_seed=[{"text": {"de": "a", "en": "A"},
                           "description": {"de": "d", "en": "D"}, "children": [
                {"text": {"de": "b", "en": ""}, "description": {"de": "", "en": ""},
                 "children": []}]}],
        )

    def _assert_same_mindmap(self, question):
        self.assertEqual(question.kind, "mindmap")
        self.assertEqual(question.mindmap_root_de, "Wurzel")
        self.assertEqual(question.mindmap_root_en, "Root")
        self.assertEqual(question.mindmap_depth, 3)
        self.assertEqual(question.mindmap_max_per_person, 4)
        self.assertTrue(question.mindmap_descriptions)
        self.assertFalse(question.mindmap_highlight_duplicates)
        self.assertEqual(
            question.mindmap_seed,
            [{"text": {"de": "a", "en": "A"},
              "description": {"de": "d", "en": "D"}, "children": [
                {"text": {"de": "b", "en": ""}, "description": {"de": "", "en": ""},
                 "children": []}]}],
        )
        self.assertEqual(question.options.count(), 0)

    def test_duplicate_set_copies_mindmap(self):
        from .transfer import duplicate_set

        self._mindmap_question()
        clone = duplicate_set(self.question_set, self.room)
        self._assert_same_mindmap(clone.questions.get())

    def test_export_import_roundtrip(self):
        from .transfer import export_set, import_set

        self._mindmap_question()
        data = export_set(self.question_set)
        exported = data["questions"][0]
        self.assertEqual(exported["mindmap_root"], {"de": "Wurzel", "en": "Root"})
        self.assertEqual(exported["mindmap_depth"], 3)
        self.assertEqual(exported["mindmap_seed"][0]["text"], {"de": "a", "en": "A"})
        imported = import_set(self.room, data)
        self._assert_same_mindmap(imported.questions.get())

    def test_import_legacy_string_seed_becomes_maps(self):
        from .transfer import import_set

        imported = import_set(self.room, {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Alt", "en": ""},
            "questions": [{
                "kind": "mindmap",
                "text": {"de": "<p>Q</p>", "en": ""},
                "mindmap_seed": [
                    {"text": "Wind", "description": "Rotoren", "children": []},
                    # Foreign instance with another canonical language: the
                    # term is kept (promoted), not dropped.
                    {"text": {"de": "", "en": "Sun"}, "children": []},
                ],
            }],
        })
        self.assertEqual(
            imported.questions.get().mindmap_seed,
            [
                {"text": {"de": "Wind", "en": ""},
                 "description": {"de": "Rotoren", "en": ""}, "children": []},
                {"text": {"de": "Sun", "en": "Sun"},
                 "description": {"de": "", "en": ""}, "children": []},
            ],
        )

    def test_import_sanitises_foreign_mindmap(self):
        from .transfer import import_set

        imported = import_set(self.room, {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Fremd", "en": ""},
            "questions": [{
                "kind": "mindmap",
                "text": {"de": "<p>Q</p>", "en": ""},
                "mindmap_root": {"de": "w" * 80, "en": ""},
                "mindmap_depth": 42,
                "mindmap_max_per_person": -3,
                "mindmap_seed": [
                    {"text": "x" * 80, "children": [{"text": "too deep?"}]},
                    {"text": "X" * 80},
                    "junk",
                    {"text": ""},
                ],
                "options": [{"text": "ignored"}],
            }],
        })
        question = imported.questions.get()
        self.assertEqual(len(question.mindmap_root_de), 60)
        self.assertEqual(question.mindmap_depth, 5)
        self.assertEqual(question.mindmap_max_per_person, 10)
        self.assertEqual(
            question.mindmap_seed,
            [{"text": {"de": "x" * 60, "en": ""}, "description": {"de": "", "en": ""},
              "children": [
                {"text": {"de": "too deep?", "en": ""},
                 "description": {"de": "", "en": ""}, "children": []}]}],
        )
        self.assertEqual(question.options.count(), 0)

    def test_0052_migrates_string_seeds_to_maps(self):
        import importlib

        from django.apps import apps as django_apps

        mod = importlib.import_module("rooms.migrations.0052_mindmap_seed_i18n")
        legacy = Question.objects.create(
            question_set=self.question_set, kind="mindmap", text_de="<p>Q</p>",
            mindmap_seed=[{"text": "Wind", "description": "Rotoren", "children": [
                {"text": "Offshore", "children": []}]}],
        )
        already = Question.objects.create(
            question_set=self.question_set, kind="mindmap", text_de="<p>Q2</p>",
            mindmap_seed=[{"text": {"de": "Sonne", "en": "Sun"},
                           "description": {"de": "", "en": ""}, "children": []}],
        )
        mod.forwards(django_apps, None)
        legacy.refresh_from_db()
        already.refresh_from_db()
        self.assertEqual(
            legacy.mindmap_seed,
            [{"text": {"de": "Wind", "en": ""},
              "description": {"de": "Rotoren", "en": ""}, "children": [
                {"text": {"de": "Offshore", "en": ""},
                 "description": {"de": "", "en": ""}, "children": []}]}],
        )
        self.assertEqual(already.mindmap_seed[0]["text"], {"de": "Sonne", "en": "Sun"})

    def test_import_rejects_mindmap_outside_live_poll(self):
        from .transfer import import_set

        with self.assertRaises(serializers.ValidationError):
            import_set(self.room, {
                "format": "abstimmbar-set-v2",
                "title": {"de": "Quiz", "en": ""},
                "type": "self_paced",
                "questions": [{"kind": "mindmap", "text": {"de": "<p>Q</p>", "en": ""}}],
            })

    def test_move_into_self_paced_set_rejected(self):
        question = self._mindmap_question()
        target = QuestionSet.objects.create(room=self.room, title="Quiz", type="self_paced")
        response = self.client.post(
            f"/api/questions/{question.pk}/move/", {"question_set": target.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        question.refresh_from_db()
        self.assertEqual(question.question_set, self.question_set)

    def test_move_with_mindmap_contributions_blocked(self):
        question = self._mindmap_question()
        target = QuestionSet.objects.create(room=self.room, title="Andere")
        run = Run.objects.create(question_set=self.question_set)
        node = MindmapNode.objects.create(run=run, question=question, text="A", text_key="a")
        MindmapContribution.objects.create(
            node=node, token=ParticipantToken.objects.create(room=self.room)
        )
        response = self.client.post(
            f"/api/questions/{question.pk}/move/", {"question_set": target.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        question.refresh_from_db()
        self.assertEqual(question.question_set, self.question_set)

    def test_import_keeps_other_kinds_the_set_type_disallows(self):
        # Only mindmap is a hard reject; legacy files with other kinds a set
        # type would not offer in the editor still import (no regression).
        from .transfer import import_set

        imported = import_set(self.room, {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Alt", "en": ""},
            "type": "self_check",
            "questions": [{"kind": "word_cloud", "text": {"de": "<p>W</p>", "en": ""}}],
        })
        self.assertEqual(imported.questions.get().kind, "word_cloud")

    def test_set_list_has_results_uses_exists_subqueries(self):
        question = self._mindmap_question()
        response = self.client.get(f"/api/question-sets/?room={self.room.pk}")
        self.assertFalse(response.json()["results"][0]["has_results"])
        run = Run.objects.create(question_set=self.question_set)
        token = ParticipantToken.objects.create(room=self.room)
        for i in range(3):
            node = MindmapNode.objects.create(
                run=run, question=question, text=f"A{i}", text_key=f"a{i}"
            )
            MindmapContribution.objects.create(node=node, token=token)
        response = self.client.get(f"/api/question-sets/?room={self.room.pk}")
        self.assertTrue(response.json()["results"][0]["has_results"])
        from .views import QuestionSetViewSet

        view = QuestionSetViewSet()
        view.request = type("R", (), {"user": self.owner, "query_params": {}})()
        sql = str(view.get_queryset().query).upper()
        self.assertIn("EXISTS", sql)
        # No multiplying JOIN over runs/votes/contributions.
        self.assertNotIn("COUNT(DISTINCT \"LIVE_", sql)

    def test_copy_into_self_paced_set_rejected(self):
        question = self._mindmap_question()
        target = QuestionSet.objects.create(room=self.room, title="Quiz", type="self_paced")
        response = self.client.post(
            f"/api/question-sets/{target.pk}/copy-questions/",
            {"question_ids": [question.pk]}, content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(target.questions.count(), 0)

    def test_after_question_not_offered(self):
        question = self._mindmap_question()
        response = self.client.post(
            f"/api/questions/{question.pk}/add-after/", {}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)


class MindmapRatingSettingsTests(ApiTestCase):
    """Mindmap rating phase (Task 1): the four authoring settings."""

    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(room=self.room, title_de="Live")

    def _create(self, **overrides):
        payload = {
            "question_set": self.question_set.pk,
            "kind": "mindmap",
            "text": {"de": "<p>Q?</p>", "en": ""},
            "options": [],
        }
        payload.update(overrides)
        return self.client.post("/api/questions/", payload, content_type="application/json")

    def test_defaults(self):
        data = self._create().json()
        self.assertEqual(data["mindmap_rating_mode"], "")
        self.assertEqual(data["mindmap_rating_budget"], 5)
        self.assertTrue(data["mindmap_rating_multi"])
        self.assertFalse(data["mindmap_rating_live"])

    def test_settings_saved(self):
        response = self._create(
            mindmap_rating_mode="updown", mindmap_rating_budget=12,
            mindmap_rating_multi=False, mindmap_rating_live=True,
        )
        self.assertEqual(response.status_code, 201, response.content)
        question = Question.objects.get(pk=response.json()["id"])
        self.assertEqual(question.mindmap_rating_mode, "updown")
        self.assertEqual(question.mindmap_rating_budget, 12)
        self.assertFalse(question.mindmap_rating_multi)
        self.assertTrue(question.mindmap_rating_live)

    def test_mode_choices(self):
        for ok in ("", "points", "updown"):
            self.assertEqual(self._create(mindmap_rating_mode=ok).status_code, 201, ok)
        response = self._create(mindmap_rating_mode="stars")
        self.assertEqual(response.status_code, 400)
        self.assertIn("mindmap_rating_mode", response.json())

    def test_budget_range(self):
        for bad in (0, 51, -1):
            response = self._create(mindmap_rating_budget=bad)
            self.assertEqual(response.status_code, 400, bad)
            self.assertIn("mindmap_rating_budget", response.json())
        for ok in (1, 50):
            self.assertEqual(self._create(mindmap_rating_budget=ok).status_code, 201, ok)

    def _rated_question(self):
        return Question.objects.create(
            question_set=self.question_set, kind="mindmap", text_de="<p>Q</p>",
            mindmap_rating_mode="points", mindmap_rating_budget=7,
            mindmap_rating_multi=False, mindmap_rating_live=True,
        )

    def _assert_rating(self, question):
        self.assertEqual(question.mindmap_rating_mode, "points")
        self.assertEqual(question.mindmap_rating_budget, 7)
        self.assertFalse(question.mindmap_rating_multi)
        self.assertTrue(question.mindmap_rating_live)

    def test_duplicate_copies_rating_settings(self):
        from .transfer import duplicate_set

        self._rated_question()
        clone = duplicate_set(self.question_set, self.room)
        self._assert_rating(clone.questions.get())

    def test_export_import_roundtrip(self):
        from .transfer import export_set, import_set

        self._rated_question()
        data = export_set(self.question_set)
        self.assertEqual(data["questions"][0]["mindmap_rating_mode"], "points")
        self._assert_rating(import_set(self.room, data).questions.get())

    def test_import_sanitises_foreign_rating_settings(self):
        from .transfer import import_set

        imported = import_set(self.room, {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Fremd", "en": ""},
            "questions": [{
                "kind": "mindmap",
                "text": {"de": "<p>Q</p>", "en": ""},
                "mindmap_rating_mode": "stars",
                "mindmap_rating_budget": 999,
            }],
        })
        question = imported.questions.get()
        self.assertEqual(question.mindmap_rating_mode, "")
        self.assertEqual(question.mindmap_rating_budget, 5)
        self.assertTrue(question.mindmap_rating_multi)
        self.assertFalse(question.mindmap_rating_live)


    def _with_rating(self, phase):
        from live.models import MindmapRating

        question = self._rated_question()
        run = Run.objects.create(question_set=self.question_set, phase=phase,
                                 active_question=question)
        node = MindmapNode.objects.create(run=run, question=question, text="A", text_key="a")
        MindmapRating.objects.create(
            node=node, token=ParticipantToken.objects.create(room=self.room), value=1
        )
        return question

    def test_mode_locked_while_active_run_has_ratings(self):
        question = self._with_rating(Run.Phase.OPEN)
        response = self.client.patch(
            f"/api/questions/{question.pk}/", {"mindmap_rating_mode": "updown"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("mindmap_rating_mode", response.json())
        question.refresh_from_db()
        self.assertEqual(question.mindmap_rating_mode, "points")
        # Unchanged mode and other settings stay editable.
        response = self.client.patch(
            f"/api/questions/{question.pk}/",
            {"mindmap_rating_mode": "points", "mindmap_rating_budget": 9},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)

    def test_mode_editable_when_ratings_only_in_finished_runs(self):
        question = self._with_rating(Run.Phase.FINISHED)
        response = self.client.patch(
            f"/api/questions/{question.pk}/", {"mindmap_rating_mode": ""},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)


class MindmapSeedHelperTests(SimpleTestCase):
    def test_normalisation_nfkc_and_control_characters(self):
        from .mindmap import normalize_text, text_key

        self.assertEqual(normalize_text("Ab\x00c\u200b d\tef\n"), "Abc d ef")
        self.assertEqual(normalize_text("\u200b\u200d\x00"), "")
        self.assertEqual(text_key("Cafe\u0301"), text_key("Café"))

    def test_text_key_fits_its_column(self):
        from .mindmap import MINDMAP_TEXT_MAX, text_key

        self.assertEqual(len(text_key("ß" * 60)), MINDMAP_TEXT_MAX)

    def test_seed_text_and_description_normalised(self):
        from .mindmap import SeedError, clean_seed

        seed = clean_seed(
            [{"text": "Wi\x00nd", "description": "Ro\u200btoren\x00 \n x", "children": []}], 3
        )
        self.assertEqual(seed[0]["text"], {"de": "Wind", "en": ""})
        self.assertEqual(seed[0]["description"], {"de": "Rotoren x", "en": ""})
        with self.assertRaises(SeedError):
            clean_seed([{"text": "\u200b\x00", "children": []}], 3)

    def test_seed_maps_normalised_per_language(self):
        from .mindmap import SeedError, clean_seed

        seed = clean_seed(
            [{"text": {"de": "Wi\x00nd", "en": " Wi  nd\u200b ", "fr": "dropped"},
              "description": {"en": "x" * 250}, "children": []}],
            3, strict=False,
        )
        self.assertEqual(seed[0]["text"], {"de": "Wind", "en": "Wi nd"})
        self.assertEqual(seed[0]["description"], {"de": "", "en": "x" * 200})
        with self.assertRaises(SeedError):
            clean_seed([{"text": {"de": "a", "en": "x" * 61}}], 3)
        with self.assertRaises(SeedError):
            clean_seed([{"text": {"en": "only English"}}], 3)
        # Lenient: an English-only term is promoted, a fully empty one dropped.
        self.assertEqual(
            [n["text"] for n in clean_seed(
                [{"text": {"en": "Sun"}}, {"text": {"de": "", "en": ""}}], 3, strict=False
            )],
            [{"de": "Sun", "en": "Sun"}],
        )

    def test_text_key_merges_case_and_whitespace(self):
        from .mindmap import text_key

        self.assertEqual(text_key("  Klima   Schutz "), text_key("klima schutz"))


class MindmapAiSettingsTests(ApiTestCase):
    """Mindmap AI optimisation (stage 3): the four question settings and the
    AI switch (``wordcloud_ai_enabled``) on mindmap questions."""

    def setUp(self):
        super().setUp()
        self.question_set = QuestionSet.objects.create(room=self.room, title_de="Live")

    def _create(self, **overrides):
        payload = {
            "question_set": self.question_set.pk,
            "kind": "mindmap",
            "text": {"de": "<p>Q?</p>", "en": ""},
            "options": [],
        }
        payload.update(overrides)
        return self.client.post("/api/questions/", payload, content_type="application/json")

    def test_defaults(self):
        data = self._create().json()
        self.assertTrue(data["mindmap_ai_merge"])
        self.assertTrue(data["mindmap_ai_translate"])
        self.assertEqual(data["mindmap_ai_target_lang"], "")
        self.assertTrue(data["mindmap_ai_restructure"])
        self.assertFalse(data["wordcloud_ai_enabled"])

    def test_settings_saved_incl_ai_switch(self):
        response = self._create(
            wordcloud_ai_enabled=True, mindmap_ai_merge=False, mindmap_ai_translate=False,
            mindmap_ai_target_lang="en", mindmap_ai_restructure=False,
        )
        self.assertEqual(response.status_code, 201, response.content)
        question = Question.objects.get(pk=response.json()["id"])
        self.assertTrue(question.wordcloud_ai_enabled)
        self.assertFalse(question.mindmap_ai_merge)
        self.assertFalse(question.mindmap_ai_translate)
        self.assertEqual(question.mindmap_ai_target_lang, "en")
        self.assertFalse(question.mindmap_ai_restructure)

    def test_target_lang_choices(self):
        for ok in ("", "de", "en"):
            self.assertEqual(self._create(mindmap_ai_target_lang=ok).status_code, 201, ok)
        response = self._create(mindmap_ai_target_lang="fr")
        self.assertEqual(response.status_code, 400)
        self.assertIn("mindmap_ai_target_lang", response.json())

    def _ai_question(self):
        return Question.objects.create(
            question_set=self.question_set, kind="mindmap", text_de="<p>Q</p>",
            wordcloud_ai_enabled=True, mindmap_ai_merge=False, mindmap_ai_translate=True,
            mindmap_ai_target_lang="en", mindmap_ai_restructure=False,
        )

    def _assert_ai(self, question):
        self.assertTrue(question.wordcloud_ai_enabled)
        self.assertFalse(question.mindmap_ai_merge)
        self.assertTrue(question.mindmap_ai_translate)
        self.assertEqual(question.mindmap_ai_target_lang, "en")
        self.assertFalse(question.mindmap_ai_restructure)

    def test_duplicate_copies_ai_settings(self):
        from .transfer import duplicate_set

        self._ai_question()
        self._assert_ai(duplicate_set(self.question_set, self.room).questions.get())

    def test_export_import_roundtrip(self):
        from .transfer import export_set, import_set

        self._ai_question()
        data = export_set(self.question_set)
        self.assertEqual(data["questions"][0]["mindmap_ai_target_lang"], "en")
        self._assert_ai(import_set(self.room, data).questions.get())

    def test_import_sanitises_and_defaults(self):
        from .transfer import import_set

        imported = import_set(self.room, {
            "format": "abstimmbar-set-v2",
            "title": {"de": "Fremd", "en": ""},
            "questions": [{
                "kind": "mindmap",
                "text": {"de": "<p>Q</p>", "en": ""},
                "mindmap_ai_target_lang": "xx",
            }],
        })
        question = imported.questions.get()
        self.assertEqual(question.mindmap_ai_target_lang, "")
        self.assertTrue(question.mindmap_ai_merge)
        self.assertTrue(question.mindmap_ai_translate)
        self.assertTrue(question.mindmap_ai_restructure)
