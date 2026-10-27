# SPDX-License-Identifier: Apache-2.0
"""Per-option justifications (quizbar, fork feature)."""
from django.contrib.auth import get_user_model
from django.test import TestCase

from live.models import Run
from live.state import build_payloads
from rooms.models import AnswerOption, Question, QuestionSet, Room
from rooms.transfer import duplicate_set, export_set, import_set

from . import justifications
from .models import OptionJustification

User = get_user_model()


class Base(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="frank")
        self.room = Room.objects.create(title="Physik")
        self.room.owners.add(self.owner)
        self.question_set = QuestionSet.objects.create(room=self.room, title="Woche 1")
        self.question = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE, text="<p>2+2?</p>"
        )
        self.right = AnswerOption.objects.create(
            question=self.question, text="4", is_correct=True, position=0
        )
        self.wrong = AnswerOption.objects.create(question=self.question, text="5", position=1)
        justifications.set_text(self.right, "Because $2 + 2 = 4$.")
        justifications.set_text(self.wrong, "Off by one.")


class StorageTests(Base):
    def test_set_text_trims_and_empty_deletes(self):
        justifications.set_text(self.right, "  why  ")
        self.assertEqual(justifications.text_for(self.right), "why")
        justifications.set_text(self.right, "   ")
        self.assertEqual(justifications.text_for(self.right), "")
        self.assertFalse(OptionJustification.objects.filter(option=self.right).exists())

    def test_for_question_skips_empty(self):
        justifications.set_text(self.wrong, "")
        self.assertEqual(
            justifications.for_question(self.question), {self.right.pk: "Because $2 + 2 = 4$."}
        )


class QuestionApiTests(Base):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.owner)

    def test_read_includes_justification(self):
        data = self.client.get(f"/api/questions/{self.question.pk}/").json()
        by_id = {o["id"]: o for o in data["options"]}
        self.assertEqual(by_id[self.right.pk]["justification"], "Because $2 + 2 = 4$.")
        self.assertEqual(by_id[self.wrong.pk]["justification"], "Off by one.")

    def test_create_with_justifications(self):
        resp = self.client.post(
            "/api/questions/",
            {
                "question_set": self.question_set.pk,
                "kind": "multiple_choice",
                "text": "<p>Which are even?</p>",
                "options": [
                    {"text": "2", "is_correct": True, "justification": "$2 = 2 dot 1$"},
                    {"text": "3", "is_correct": False},
                ],
            },
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        question = Question.objects.get(pk=resp.json()["id"])
        texts = {o.text: justifications.text_for(o) for o in question.options.all()}
        self.assertEqual(texts, {"2": "$2 = 2 dot 1$", "3": ""})

    def test_update_keeps_omitted_and_changes_given(self):
        resp = self.client.patch(
            f"/api/questions/{self.question.pk}/",
            {
                "text": "<p>2+2?</p>",
                "options": [
                    {"id": self.right.pk, "text": "4", "is_correct": True},
                    {"id": self.wrong.pk, "text": "5", "justification": "New reason."},
                ]
            },
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        # Omitted justification = unchanged; given = replaced.
        self.assertEqual(justifications.text_for(self.right), "Because $2 + 2 = 4$.")
        self.assertEqual(justifications.text_for(self.wrong), "New reason.")

    def test_deleting_option_deletes_justification(self):
        self.client.patch(
            f"/api/questions/{self.question.pk}/",
            {"text": "<p>2+2?</p>", "options": [
                {"id": self.right.pk, "text": "4", "is_correct": True},
                {"text": "6"},
            ]},
            content_type="application/json",
        )
        self.assertFalse(OptionJustification.objects.filter(option_id=self.wrong.pk).exists())


class TransferTests(Base):
    def test_duplicate_copies_justifications(self):
        clone = duplicate_set(self.question_set, self.room)
        question = clone.questions.get()
        texts = sorted(justifications.text_for(o) for o in question.options.all())
        self.assertEqual(texts, ["Because $2 + 2 = 4$.", "Off by one."])
        # Copies are independent rows.
        self.assertEqual(OptionJustification.objects.count(), 4)

    def test_export_import_round_trip(self):
        data = export_set(self.question_set)
        self.assertEqual(
            [o["justification"] for o in data["questions"][0]["options"]],
            ["Because $2 + 2 = 4$.", "Off by one."],
        )
        data["title"] = {"de": "Woche 1 (import)"}  # fixture title sits in title_en
        imported = import_set(self.room, data)
        question = imported.questions.get()
        texts = [justifications.text_for(o) for o in question.options.all()]
        self.assertEqual(texts, ["Because $2 + 2 = 4$.", "Off by one."])


class LiveTests(Base):
    def setUp(self):
        super().setUp()
        self.run = Run.objects.create(
            question_set=self.question_set, phase=Run.Phase.RESULTS, active_question=self.question
        )

    def press_j(self, show=True):
        self.client.force_login(self.owner)
        return self.client.post(
            f"/api/quizbar/runs/{self.run.pk}/justification/",
            {"show": show},
            content_type="application/json",
        )

    def results(self, role):
        return {r["id"]: r for r in build_payloads(self.room)[role]["results"]}

    def test_presenter_always_has_texts_participant_only_after_j(self):
        presenter = self.results("presenter")
        self.assertEqual(presenter[self.right.pk]["justification"], "Because $2 + 2 = 4$.")
        self.assertNotIn("justification_shown", build_payloads(self.room)["presenter"])
        self.assertNotIn("justification", self.results("participant")[self.right.pk])

        self.assertEqual(self.press_j().status_code, 200)
        self.run.refresh_from_db()
        self.assertTrue(self.run.answers_revealed)
        self.assertTrue(build_payloads(self.room)["presenter"].get("justification_shown"))
        participant = self.results("participant")
        self.assertEqual(participant[self.wrong.pk]["justification"], "Off by one.")
        self.assertTrue(participant[self.right.pk]["is_correct"])

    def test_j_from_closed_vote_goes_to_results(self):
        self.run.phase = Run.Phase.CLOSED
        self.run.save()
        self.press_j()
        self.run.refresh_from_db()
        self.assertEqual(self.run.phase, Run.Phase.RESULTS)

    def test_hidden_again_by_toggle_unreveal_or_other_question(self):
        self.press_j()
        self.press_j(show=False)
        self.assertNotIn("justification", self.results("participant")[self.right.pk])

        self.press_j()
        self.run.answers_revealed = False  # E: back to plain results
        self.run.save()
        self.assertNotIn("justification", self.results("participant")[self.right.pk])

        self.press_j()
        other = Question.objects.create(
            question_set=self.question_set, kind=Question.Kind.SINGLE_CHOICE, position=1
        )
        AnswerOption.objects.create(question=other, text="x", is_correct=True)
        self.run.active_question = other
        self.run.save()
        self.assertNotIn("justification_shown", build_payloads(self.room)["presenter"])

    def test_only_owner_may_press_j(self):
        intruder = User.objects.create_user(username="eve")
        self.client.force_login(intruder)
        resp = self.client.post(
            f"/api/quizbar/runs/{self.run.pk}/justification/", {}, content_type="application/json"
        )
        self.assertEqual(resp.status_code, 404)


class FeedbackTests(Base):
    def test_self_paced_vote_feedback_contains_justifications(self):
        self.client.force_login(self.owner)
        self.client.post(
            f"/api/question-sets/{self.question_set.pk}/start-run/",
            {"mode": "self_paced"},
            content_type="application/json",
        )
        self.client.logout()
        token = self.client.post(
            f"/api/live/rooms/{self.room.code}/join/", {}, content_type="application/json"
        ).json()["token"]
        resp = self.client.post(
            f"/api/live/rooms/{self.room.code}/vote/",
            {"token": token, "question": self.question.pk, "options": [self.wrong.pk]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        data = resp.json()
        self.assertFalse(data["is_correct"])
        self.assertEqual(data["justifications"][str(self.wrong.pk)], "Off by one.")
        # A reload of the quiz brings them back with the stored answer.
        quiz = self.client.get(
            f"/api/live/rooms/{self.room.code}/quiz/", {"token": token}
        ).json()
        entry = quiz["answered"][str(self.question.pk)]
        self.assertEqual(entry["justifications"][str(self.right.pk)], "Because $2 + 2 = 4$.")

    def test_self_check_payload_contains_justifications(self):
        self.question_set.type = QuestionSet.SetType.SELF_CHECK
        self.question_set.save()
        self.question_set.enable_self_check()
        data = self.client.get(f"/api/live/check/{self.question_set.self_check_token}/").json()
        question = data["questions"][0]
        self.assertEqual(question["justifications"][str(self.right.pk)], "Because $2 + 2 = 4$.")


class RoomLanguageTests(Base):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.owner)

    def test_room_api_reads_and_writes_language(self):
        self.assertEqual(self.client.get(f"/api/rooms/{self.room.pk}/").json()["language"], "")
        resp = self.client.patch(
            f"/api/rooms/{self.room.pk}/", {"language": "fr"}, content_type="application/json"
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["language"], "fr")
        self.assertEqual(build_payloads(self.room)["presenter"]["room"]["language"], "fr")
        self.client.patch(
            f"/api/rooms/{self.room.pk}/", {"language": ""}, content_type="application/json"
        )
        self.assertEqual(self.client.get(f"/api/rooms/{self.room.pk}/").json()["language"], "")

    def test_invalid_language_rejected(self):
        resp = self.client.patch(
            f"/api/rooms/{self.room.pk}/", {"language": "xx"}, content_type="application/json"
        )
        self.assertEqual(resp.status_code, 400)


class ParticipantLanguageTests(Base):
    def page(self, cookie=None, **extra):
        self.client.logout()  # also drops all cookies
        if cookie:
            self.client.cookies["django_language"] = cookie
        return self.client.get(f"/p/{self.room.code}/", **extra)

    def test_room_language_sets_page_language(self):
        set_room_language = __import__("quizbar.languages", fromlist=["x"]).set_room_language
        set_room_language(self.room, "fr")
        html = self.page(HTTP_ACCEPT_LANGUAGE="de").content.decode()
        self.assertIn('<html lang="fr">', html)
        self.assertIn("Mes réponses", html)

    def test_participant_pick_beats_room_language(self):
        __import__("quizbar.languages", fromlist=["x"]).set_room_language(self.room, "fr")
        self.assertIn('<html lang="en">', self.page(cookie="en").content.decode())

    def test_lang_param_fr_sets_cookie(self):
        resp = self.page(QUERY_STRING="lang=fr")
        self.assertIn('<html lang="fr">', resp.content.decode())
        self.assertEqual(resp.cookies["django_language"].value, "fr")

    def test_browser_french_without_room_language(self):
        html = self.page(HTTP_ACCEPT_LANGUAGE="fr-CH,fr;q=0.9,en;q=0.5").content.decode()
        self.assertIn('<html lang="fr">', html)

    def test_other_paths_untouched(self):
        self.client.cookies["django_language"] = "fr"
        resp = self.client.get("/api/whoami/")
        self.assertNotEqual(resp.get("Content-Language"), "fr")


class FolderTests(Base):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.owner)
        self.sets = [self.question_set] + [
            QuestionSet.objects.create(room=self.room, title=f"Woche {n}") for n in (2, 3, 4)
        ]
        for qs in self.sets[1:]:
            Question.objects.create(question_set=qs, kind=Question.Kind.SINGLE_CHOICE, text="q")

    def api(self, method, url, data=None):
        return getattr(self.client, method)(
            f"/api/quizbar/{url}", data or {}, content_type="application/json"
        )

    def make_folder(self, ordered=True, sets=()):
        folder = self.api("post", f"rooms/{self.room.pk}/folders/", {"title": "HS26", "ordered": ordered}).json()
        for qs in sets:
            self.assertEqual(self.api("post", f"sets/{qs.pk}/folder/", {"folder": folder["id"]}).status_code, 200)
        return folder["id"]

    def test_create_place_list_and_reorder(self):
        fid = self.make_folder(sets=self.sets[:3])
        data = self.api("get", f"rooms/{self.room.pk}/folders/").json()["folders"]
        self.assertEqual(data[0]["sets"], [s.pk for s in self.sets[:3]])
        new_order = [self.sets[2].pk, self.sets[0].pk, self.sets[1].pk]
        self.assertEqual(self.api("post", f"folders/{fid}/order/", {"sets": new_order}).status_code, 200)
        self.assertEqual(self.api("get", f"rooms/{self.room.pk}/folders/").json()["folders"][0]["sets"], new_order)
        # The list must be exactly the folder's sets.
        self.assertEqual(self.api("post", f"folders/{fid}/order/", {"sets": new_order[:2]}).status_code, 400)

    def test_next_skips_unpresentable_and_stops_at_end(self):
        check = QuestionSet.objects.create(room=self.room, title="Lernkontrolle", type="self_check")
        Question.objects.create(question_set=check, kind=Question.Kind.SINGLE_CHOICE, text="q")
        empty = QuestionSet.objects.create(room=self.room, title="leer")
        self.make_folder(sets=[self.sets[0], check, empty, self.sets[1]])
        info = self.api("get", f"sets/{self.sets[0].pk}/next/").json()
        self.assertEqual(info["number"], 1)
        self.assertEqual(info["next"]["id"], self.sets[1].pk)
        self.assertEqual(info["next"]["number"], 4)
        self.assertIsNone(self.api("get", f"sets/{self.sets[1].pk}/next/").json()["next"])

    def test_unordered_folder_has_no_next(self):
        self.make_folder(ordered=False, sets=self.sets[:2])
        info = self.api("get", f"sets/{self.sets[0].pk}/next/").json()
        self.assertIsNone(info["number"])
        self.assertIsNone(info["next"])

    def test_move_out_and_delete_folder_keeps_sets(self):
        fid = self.make_folder(sets=self.sets[:2])
        self.api("post", f"sets/{self.sets[0].pk}/folder/", {"folder": None})
        self.assertEqual(self.api("get", f"rooms/{self.room.pk}/folders/").json()["folders"][0]["sets"], [self.sets[1].pk])
        self.assertEqual(self.api("delete", f"folders/{fid}/").status_code, 204)
        self.assertEqual(QuestionSet.objects.filter(room=self.room).count(), 4)

    def test_duplicate_lands_after_original(self):
        fid = self.make_folder(sets=self.sets[:3])
        resp = self.client.post(
            f"/api/question-sets/{self.sets[0].pk}/duplicate/", {}, content_type="application/json"
        )
        clone = resp.json()["id"]
        sets = self.api("get", f"rooms/{self.room.pk}/folders/").json()["folders"][0]["sets"]
        self.assertEqual(sets, [self.sets[0].pk, clone, self.sets[1].pk, self.sets[2].pk])
        self.assertTrue(fid)

    def test_other_users_and_other_rooms_refused(self):
        fid = self.make_folder()
        other_room = Room.objects.create(title="Other")
        other_room.owners.add(self.owner)
        foreign = QuestionSet.objects.create(room=other_room, title="x")
        self.assertEqual(self.api("post", f"sets/{foreign.pk}/folder/", {"folder": fid}).status_code, 400)
        self.client.force_login(User.objects.create_user(username="eve"))
        self.assertEqual(self.api("get", f"rooms/{self.room.pk}/folders/").status_code, 404)
        self.assertEqual(self.api("delete", f"folders/{fid}/").status_code, 404)
