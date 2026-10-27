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


class SelfCheckSyncTests(Base):
    """Self-checks that fill themselves from other sets (quizbar.selfcheck)."""

    def setUp(self):
        super().setUp()
        from . import selfcheck

        self.sc = selfcheck
        self.quiz2 = QuestionSet.objects.create(room=self.room, title="Quiz 2")
        self.cloud = Question.objects.create(
            question_set=self.quiz2, kind=Question.Kind.WORD_CLOUD, text="cloud", position=0
        )
        self.mc = Question.objects.create(
            question_set=self.quiz2, kind=Question.Kind.MULTIPLE_CHOICE, text="mc", position=1
        )
        AnswerOption.objects.create(question=self.mc, text="a", is_correct=True, position=0)
        AnswerOption.objects.create(question=self.mc, text="b", position=1)
        self.check = QuestionSet.objects.create(
            room=self.room, title="Self-check", type=QuestionSet.SetType.SELF_CHECK
        )
        self.sc.set_sources(self.check, [self.question_set, self.quiz2])

    def outline(self):
        sections = [(s.position, "S", s.title) for s in self.check.sections.all()]
        questions = [(q.position, "Q", q.text) for q in self.check.questions.all()]
        return [(kind, text) for _p, kind, text in sorted(sections + questions)]

    def test_copies_allowed_kinds_with_sections_and_justifications(self):
        self.assertEqual(
            self.outline(),
            [("S", "Woche 1"), ("Q", "<p>2+2?</p>"), ("S", "Quiz 2"), ("Q", "mc")],
        )
        copy = self.check.questions.get(text="<p>2+2?</p>")
        right = copy.options.get(is_correct=True)
        self.assertEqual(justifications.text_for(right), "Because $2 + 2 = 4$.")

    def test_edit_updates_copy_in_place_and_keeps_id(self):
        copy_id = self.check.questions.get(text="mc").pk
        self.mc.text = "mc edited"
        self.mc.save()
        self.assertTrue(self.sc.ensure_synced(self.check))
        self.assertEqual(self.check.questions.get(pk=copy_id).text, "mc edited")
        self.assertFalse(self.sc.ensure_synced(self.check))  # unchanged → no work

    def test_deleted_source_question_and_removed_source(self):
        self.mc.delete()
        self.sc.ensure_synced(self.check)
        self.assertEqual(self.outline(), [("S", "Woche 1"), ("Q", "<p>2+2?</p>")])
        self.sc.set_sources(self.check, [self.quiz2])
        self.assertEqual(self.outline(), [])

    def test_manual_questions_are_kept_after_copies(self):
        Question.objects.create(
            question_set=self.check, kind=Question.Kind.SINGLE_CHOICE, text="mine", position=0
        )
        self.sc.ensure_synced(self.check, force=True)
        self.assertEqual(self.outline()[-1], ("Q", "mine"))
        self.assertEqual(self.check.questions.count(), 3)

    def test_student_page_catches_up(self):
        self.check.enable_self_check()
        self.mc.text = "changed"
        self.mc.save()
        data = self.client.get(f"/api/live/check/{self.check.self_check_token}/").json()
        texts = {q["text"]["de"] or q["text"]["en"] for q in data["questions"]}
        self.assertIn("changed", texts)

    def test_sources_api(self):
        self.client.force_login(self.owner)
        url = f"/api/quizbar/sets/{self.check.pk}/self-check-sources/"
        data = self.client.get(url).json()
        self.assertEqual(data["sources"], [self.question_set.pk, self.quiz2.pk])
        self.assertEqual({c["id"] for c in data["candidates"]}, {self.question_set.pk, self.quiz2.pk})
        resp = self.client.put(url, {"sources": [self.quiz2.pk]}, content_type="application/json")
        self.assertEqual(resp.json()["sources"], [self.quiz2.pk])
        self.assertEqual(self.outline(), [("S", "Quiz 2"), ("Q", "mc")])


class CourseTests(Base):
    def test_create_course_structure(self):
        from . import course, languages

        room = course.create_course(self.owner, "0000 - TEMPLATE", weeks=3, archived=True)
        self.assertTrue(room.archived_by.filter(pk=self.owner.pk).exists())
        self.assertEqual(languages.room_language(room), "en")
        folders_ = list(room.qb_folders.all())
        self.assertEqual([f.title for f in folders_], ["Week 1", "Week 2", "Week 3"])
        week2 = [
            p.question_set for p in folders_[1].placements.select_related("question_set")
        ]
        self.assertEqual(
            [qs.title for qs in week2],
            ["Week 2 – Activators PRE", "Week 2 – Quiz 1", "Week 2 – Quiz 2",
             "Week 2 – Activators POST", "Week 2 – Self-check"],
        )
        self.assertEqual(week2[0].reveal_answers, "never")
        self.assertEqual(week2[4].type, QuestionSet.SetType.SELF_CHECK)
        self.assertEqual(
            [s.source.title for s in week2[4].qb_sources.all()],
            ["Week 2 – Quiz 1", "Week 2 – Quiz 2", "Week 2 – Activators POST"],
        )

    def test_duplicate_room_keeps_structure_and_relinks(self):
        from . import course, languages

        template = course.create_course(self.owner, "0000 - TEMPLATE", weeks=2, archived=True)
        languages.set_room_language(template, "fr")
        quiz = template.question_sets.get(title_de="Week 1 – Quiz 1")
        q = Question.objects.create(question_set=quiz, kind=Question.Kind.SINGLE_CHOICE, text="q1")
        AnswerOption.objects.create(question=q, text="x", is_correct=True)
        check = template.question_sets.get(title_de="Week 1 – Self-check")
        course.selfcheck.ensure_synced(check)
        self.assertEqual(check.questions.count(), 1)

        self.client.force_login(self.owner)
        resp = self.client.post(f"/api/quizbar/rooms/{template.pk}/duplicate/", {}, content_type="application/json")
        copy = Room.objects.get(pk=resp.json()["id"])
        self.assertEqual(copy.title, "0000 - TEMPLATE (copy)")
        self.assertFalse(copy.archived_by.exists())
        self.assertEqual(languages.room_language(copy), "fr")
        self.assertEqual(copy.question_sets.count(), 10)
        self.assertEqual(copy.qb_folders.count(), 2)
        new_check = copy.question_sets.get(title_de="Week 1 – Self-check")
        self.assertEqual(
            [s.source.room_id for s in new_check.qb_sources.all()], [copy.pk] * 3
        )
        # One copy, linked to the NEW room's quiz (not doubled, not the old one).
        self.assertEqual(new_check.questions.count(), 1)
        new_quiz = copy.question_sets.get(title_de="Week 1 – Quiz 1")
        new_quiz.questions.update(text="changed in copy")
        Question.objects.filter(question_set=new_quiz).first().save()
        course.selfcheck.ensure_synced(new_check)
        self.assertEqual(new_check.questions.get().text, "changed in copy")
        self.assertEqual(check.questions.get().text, "q1")

    def test_management_command(self):
        from django.core.management import call_command

        call_command("quizbar_course", owner="frank", title="HS26 - TA - Physics", weeks=14)
        room = Room.objects.get(title_de="HS26 - TA - Physics")
        self.assertEqual(room.qb_folders.count(), 14)
        self.assertEqual(room.question_sets.count(), 70)


class LibraryTests(TestCase):
    def setUp(self):
        from . import library

        self.library = library
        self.owner = User.objects.create_user(username="lib", is_staff=True)
        self.room = Room.objects.create(title="HS26", owner=self.owner)
        self.room.owners.add(self.owner)
        self.quiz = QuestionSet.objects.create(room=self.room, title="Quiz 1")
        self.client.force_login(self.owner)

    def new_question(self, text="Energy?", question_set=None, **library):
        payload = {
            "question_set": (question_set or self.quiz).pk,
            "kind": "single_choice",
            "text": {"de": text, "en": ""},
            "options": [
                {"text": {"de": "E=mc^2", "en": ""}, "is_correct": True},
                {"text": {"de": "E=mc", "en": ""}, "is_correct": False},
            ],
        }
        if library:
            payload["library"] = library
        resp = self.client.post("/api/questions/", payload, content_type="application/json")
        self.assertEqual(resp.status_code, 201, resp.content)
        return Question.objects.get(pk=resp.json()["id"]), resp.json()

    def entries(self):
        return self.client.get("/api/quizbar/library/").json()["entries"]

    def test_new_question_joins_library_with_tags(self):
        question, data = self.new_question(in_library=True, tags=["Energy", " energy ", "Week 1"])
        self.assertTrue(data["library"]["in_library"])
        self.assertEqual(data["library"]["tags"], ["energy", "week-1"])
        [entry] = self.entries()
        self.assertEqual(entry["master"], question.pk)
        self.assertEqual(entry["used_in"][0]["set"], self.quiz.pk)
        self.assertEqual(len(entry["options"]), 2)

    def test_opt_out_and_back(self):
        question, data = self.new_question(in_library=False)
        self.assertFalse(data["library"]["in_library"])
        self.assertEqual(self.entries(), [])
        resp = self.client.patch(
            f"/api/questions/{question.pk}/",
            {"library": {"in_library": True, "tags": ["Optics"]}},
            content_type="application/json",
        )
        self.assertEqual(resp.json()["library"]["tags"], ["optics"])
        self.assertEqual(len(self.entries()), 1)

    def test_copies_do_not_add_entries(self):
        self.new_question()
        copy = duplicate_set(self.quiz, self.room)
        self.assertEqual(len(self.entries()), 1)
        self.assertEqual(len(self.entries()[0]["used_in"]), 2)
        self.assertEqual(copy.questions.get().qb_lineage.entry.members.count(), 2)

    def test_example_rooms_stay_out(self):
        room = Room.objects.create(title="Beispiel", owner=self.owner, is_example=True)
        qs = QuestionSet.objects.create(room=room, title="x")
        Question.objects.create(question_set=qs, kind="single_choice", text="demo")
        self.assertEqual(self.entries(), [])

    def test_deleting_master_moves_to_copy(self):
        self.new_question()
        copy_set = duplicate_set(self.quiz, self.room)
        with self.captureOnCommitCallbacks(execute=True):
            self.quiz.delete()
        [entry] = self.entries()
        self.assertEqual(entry["master_set"], copy_set.pk)
        self.assertEqual([u["set"] for u in entry["used_in"]], [copy_set.pk])
        vault = self.owner.qb_library_vault.question_set
        self.assertEqual(vault.questions.count(), 0)

    def test_deleting_last_copy_keeps_it_in_the_vault(self):
        self.new_question(tags=["Mechanics"], in_library=True)
        with self.captureOnCommitCallbacks(execute=True):
            self.room.delete()
        [entry] = self.entries()
        self.assertIsNone(entry["master_set"])
        self.assertEqual(entry["used_in"], [])
        self.assertEqual(entry["tags"], [{"id": entry["tags"][0]["id"], "name": "mechanics"}])
        self.assertEqual(entry["options"][0]["text"]["de"], "E=mc^2")
        # The vault room is never listed, not even in the staff-wide list.
        rooms = self.client.get("/api/rooms/?all=1").json()
        listed = rooms["results"] if isinstance(rooms, dict) else rooms
        self.assertEqual(listed, [])
        # Back into a set: that copy becomes the master, the vault empties.
        room = Room.objects.create(title="HS27", owner=self.owner)
        room.owners.add(self.owner)
        target = QuestionSet.objects.create(room=room, title="Quiz")
        resp = self.client.post(
            "/api/quizbar/library/insert/",
            {"set": target.pk, "entries": [entry["id"]]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        [entry] = self.entries()
        self.assertEqual(entry["master_set"], target.pk)
        self.assertEqual(self.owner.qb_library_vault.question_set.questions.count(), 0)
        self.assertEqual(target.questions.get().options.count(), 2)

    def test_insert_skips_kinds_the_set_cannot_hold(self):
        self.new_question()
        cloud = Question.objects.create(question_set=self.quiz, kind="word_cloud", text="Words")
        check = QuestionSet.objects.create(
            room=self.room, title="Check", type=QuestionSet.SetType.SELF_CHECK
        )
        ids = [e["id"] for e in self.entries()]
        resp = self.client.post(
            "/api/quizbar/library/insert/", {"set": check.pk, "entries": ids},
            content_type="application/json",
        )
        self.assertEqual(resp.json()["skipped"], [cloud.qb_lineage.entry_id])
        self.assertEqual(check.questions.count(), 1)
        self.assertEqual(len(self.entries()), 2)

    def test_insert_needs_own_set(self):
        self.new_question()
        other = User.objects.create_user(username="other")
        room = Room.objects.create(title="Theirs", owner=other)
        room.owners.add(other)
        target = QuestionSet.objects.create(room=room, title="Q")
        # Staff may open any room; a normal teacher may not.
        self.owner.is_staff = False
        self.owner.save()
        resp = self.client.post(
            "/api/quizbar/library/insert/",
            {"set": target.pk, "entries": [self.entries()[0]["id"]]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 404)

    def test_remove_keeps_questions(self):
        question, _ = self.new_question()
        entry_id = self.entries()[0]["id"]
        self.assertEqual(self.client.delete(f"/api/quizbar/library/entries/{entry_id}/").status_code, 204)
        self.assertEqual(self.entries(), [])
        self.assertTrue(Question.objects.filter(pk=question.pk).exists())

    def test_bulk_tags_and_rename_merges(self):
        self.new_question("A")
        self.new_question("B", tags=["optics"], in_library=True)
        ids = [e["id"] for e in self.entries()]
        self.client.post(
            "/api/quizbar/library/tags/", {"entries": ids, "add": ["Week 3"]},
            content_type="application/json",
        )
        tags = {t["name"]: t["id"] for t in self.client.get("/api/quizbar/library/").json()["tags"]}
        self.assertEqual(set(tags), {"optics", "week-3"})
        self.client.patch(
            f"/api/quizbar/library/tags/{tags['optics']}/", {"name": "week 3"},
            content_type="application/json",
        )
        data = self.client.get("/api/quizbar/library/").json()
        self.assertEqual([t["name"] for t in data["tags"]], ["week-3"])
        self.assertTrue(all(len(e["tags"]) == 1 for e in data["entries"]))

    def test_tag_spelling_is_normalized(self):
        self.assertEqual(
            self.library.clean_tag_names(["Week 3", " week   3 ", "Thermo, Gas", "--A--B--", ""]),
            ["week-3", "thermo-gas", "a-b"],
        )

    def test_migration_merges_old_spellings(self):
        import importlib

        from django.apps import apps

        from .models import LibraryEntry, LibraryTag

        migration = importlib.import_module("quizbar.migrations.0006_normalize_tags")
        first = LibraryEntry.objects.create(owner=self.owner)
        second = LibraryEntry.objects.create(owner=self.owner)
        a = LibraryTag.objects.create(owner=self.owner, name="Week 3")
        b = LibraryTag.objects.create(owner=self.owner, name="week-3")
        first.tags.add(a)
        second.tags.add(b)
        migration.forwards(apps, None)
        self.assertEqual(list(LibraryTag.objects.values_list("name", flat=True)), ["week-3"])
        self.assertEqual(LibraryTag.objects.get().entries.count(), 2)

    def test_backfill_merges_identical_questions(self):
        from .models import LibraryEntry, QuestionLineage

        for title in ("Old 1", "Old 2"):
            qs = QuestionSet.objects.create(room=self.room, title=title)
            q = Question.objects.create(question_set=qs, kind="single_choice", text="Same?")
            AnswerOption.objects.create(question=q, text="yes", is_correct=True)
        Question.objects.create(question_set=qs, kind="single_choice", text="Other")
        # Pretend these existed before the library.
        QuestionLineage.objects.all().delete()
        LibraryEntry.objects.all().delete()
        created, joined = self.library.backfill(self.owner)
        self.assertEqual((created, joined), (2, 1))
        self.assertEqual(self.library.backfill(self.owner), (0, 0))

    def test_deleting_the_user_does_not_rescue(self):
        self.new_question()
        with self.captureOnCommitCallbacks(execute=True):
            self.owner.delete()
        from .models import LibraryVault

        self.assertFalse(LibraryVault.objects.exists())
        self.assertEqual(Question.objects.count(), 1)


class TypstImportTests(TestCase):
    QUIZ = r"""
#import "quizbar.typ": *
#show: quizbar.with(title: "Week 3 – Quiz 1", type: "self-check", figures: "figures")

// #question([commented out], answers: ())
#question(
  [Speed with $lambda = 2$ m and $f = 3$ Hz? A *bold* word, a bracket $[0, 1)$.],
  kind: "SC",
  answers: (
    answer(true, [6 m/s], why: [$v = lambda f$.]),
    answer(false, [1.5 m/s], why: [That is $lambda \/ f$.]),
  ),
  image: "wave.png",
  tags: ("Waves", "Week 3"),
  time-limit-s: 60,
)

#question(
  [Which are conserved?

  - energy
  - period],
  kind: "mc",
  answers: (
    answer(true)[Energy],
    answer(false, [Momentum]),
    answer(true, "Period"),
  ),
  tags: "Oscillations",
  shuffle: true,
)
"""

    def setUp(self):
        self.owner = User.objects.create_user(username="typ")
        self.room = Room.objects.create(title="HS26", owner=self.owner)
        self.room.owners.add(self.owner)
        self.client.force_login(self.owner)

    def test_parse(self):
        from .typst_import import parse

        quiz = parse(self.QUIZ)
        self.assertEqual((quiz.title, quiz.set_type), ("Week 3 – Quiz 1", "self_check"))
        first, second = quiz.questions
        self.assertEqual(
            first.text_html,
            "<p>Speed with $lambda = 2$ m and $f = 3$ Hz? A <strong>bold</strong> word, "
            "a bracket $[0, 1)$.</p>",
        )
        self.assertEqual(first.options[1]["justification"], r"That is $lambda \/ f$.")
        self.assertEqual((first.image, first.time_limit, first.tags), ("wave.png", 60, ["Waves", "Week 3"]))
        self.assertEqual(second.kind, "multiple_choice")
        self.assertEqual(second.text_html, "<p>Which are conserved?</p><ul><li>energy</li><li>period</li></ul>")
        self.assertEqual([o["text"] for o in second.options], ["Energy", "Momentum", "Period"])
        self.assertTrue(second.shuffle)

    def test_errors_name_the_line(self):
        from .typst_import import TypstImportError, parse

        with self.assertRaisesRegex(TypstImportError, "Line 3"):
            parse('#import "quizbar.typ": *\n\n#question([Q], kind: "SC", answers: (answer(true, [a]), answer(true, [b])))')
        with self.assertRaisesRegex(TypstImportError, "No #question"):
            parse("= Just notes")

    def _png(self):
        import io

        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (40, 20), "green").save(buffer, format="PNG")
        return buffer.getvalue()

    def test_import_zip_with_figure_into_folder(self):
        import io
        import zipfile

        from django.core.files.uploadedfile import SimpleUploadedFile

        from . import folders

        folder = folders.create_folder(self.room, "Week 3")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("week3/quiz.typ", self.QUIZ)
            archive.writestr("week3/quizbar.typ", "#let question(..args) = none")
            archive.writestr("week3/figures/wave.png", self._png())
        upload = SimpleUploadedFile("week3.zip", buffer.getvalue(), content_type="application/zip")
        resp = self.client.post(
            f"/api/quizbar/rooms/{self.room.pk}/import-typst/",
            {"files": [upload], "folder": folder.pk},
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["warnings"], [])
        question_set = QuestionSet.objects.get(pk=resp.json()["id"])
        self.assertEqual(question_set.type, QuestionSet.SetType.SELF_CHECK)
        self.assertEqual(question_set.qb_placement.folder, folder)
        first, second = question_set.questions.order_by("position")
        self.assertIn('<img src="/media/question-images/', first.text)
        self.assertEqual(first.time_limit, 60)
        self.assertEqual(
            justifications.text_for(first.options.order_by("position")[1]), r"That is $lambda \/ f$."
        )
        self.assertEqual(sorted(t.name for t in first.qb_lineage.entry.tags.all()), ["waves", "week-3"])
        self.assertTrue(second.shuffle_options)

    def test_import_fills_the_empty_set_of_a_course_room(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from . import course, selfcheck

        room = course.create_course(self.owner, "HS26 - TA - Physics", weeks=1)
        quiz = room.question_sets.get(title_de="Week 1 – Quiz 1")
        source = self.QUIZ.replace("Week 3 – Quiz 1", "Week 1 – Quiz 1").replace(
            'type: "self-check"', 'type: "live"'
        )
        upload = SimpleUploadedFile("quiz.typ", source.encode())
        resp = self.client.post(f"/api/quizbar/rooms/{room.pk}/import-typst/", {"files": [upload]})
        self.assertEqual(resp.json()["id"], quiz.pk)
        self.assertEqual(room.question_sets.count(), 5)
        self.assertEqual(quiz.questions.count(), 2)
        self.assertEqual(quiz.qb_placement.folder.title, "Week 1")
        check = room.question_sets.get(title_de="Week 1 – Self-check")
        selfcheck.ensure_synced(check)
        self.assertEqual(check.questions.count(), 2)

    def test_import_plain_typ_warns_about_missing_figure(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        upload = SimpleUploadedFile("quiz.typ", self.QUIZ.encode())
        resp = self.client.post(f"/api/quizbar/rooms/{self.room.pk}/import-typst/", {"files": [upload]})
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()["warnings"], ["Question 1: figure wave.png was not uploaded."])

    def test_bad_file_is_a_400_with_the_reason(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        upload = SimpleUploadedFile("quiz.typ", b'#question([Q], answers: (answer(true, [a]),))')
        resp = self.client.post(f"/api/quizbar/rooms/{self.room.pk}/import-typst/", {"files": [upload]})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("at least two answers", resp.json()["detail"])

    def test_example_file_parses(self):
        from pathlib import Path

        from django.conf import settings

        from .typst_import import parse

        example = Path(settings.BASE_DIR).parent / "frontend/public/quizbar/example.typ"
        if not example.exists():
            self.skipTest("frontend not next to backend")
        self.assertEqual(len(parse(example.read_text()).questions), 3)


class GameTests(TestCase):
    def setUp(self):
        from datetime import timedelta

        from django.utils import timezone

        self.timedelta, self.now = timedelta, timezone.now
        self.owner = User.objects.create_user(username="game")
        self.room = Room.objects.create(title="Physics", owner=self.owner)
        self.room.owners.add(self.owner)
        self.quiz = QuestionSet.objects.create(room=self.room, title="Quiz 1")
        self.sc = Question.objects.create(
            question_set=self.quiz, kind="single_choice", text="SC", position=0, time_limit=10
        )
        self.sc_right = AnswerOption.objects.create(question=self.sc, text="a", is_correct=True)
        self.sc_wrong = AnswerOption.objects.create(question=self.sc, text="b")
        self.mc = Question.objects.create(
            question_set=self.quiz, kind="multiple_choice", text="MC", position=1
        )
        self.mc_a = AnswerOption.objects.create(question=self.mc, text="a", is_correct=True)
        self.mc_b = AnswerOption.objects.create(question=self.mc, text="b", is_correct=True)
        AnswerOption.objects.create(question=self.mc, text="c")
        self.client.force_login(self.owner)
        resp = self.client.put(
            f"/api/quizbar/sets/{self.quiz.pk}/game/", {"enabled": True},
            content_type="application/json",
        )
        # Nicknames and avatars are off unless switched on.
        self.assertEqual(resp.json(), {"enabled": True, "nicknames": False, "avatars": False})
        self.client.put(
            f"/api/quizbar/sets/{self.quiz.pk}/game/", {"nicknames": True, "avatars": True},
            content_type="application/json",
        )
        self.run = Run.objects.create(question_set=self.quiz, phase=Run.Phase.LOBBY)

    def player(self, nickname, avatar=""):
        from live.models import ParticipantToken

        token = ParticipantToken.objects.create(room=self.room)
        resp = self.client.post(
            f"/api/quizbar/game/{self.room.code}/enter/",
            {"token": token.key, "run": self.run.pk, "nickname": nickname, "avatar": avatar},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        return token

    def open(self, question):
        self.run.active_question = question
        self.run.phase = Run.Phase.OPEN
        self.run.opened_at = self.now()
        self.run.answers_revealed = False
        self.run.save()

    def vote(self, token, question, options, after):
        from live.models import Vote

        vote = Vote.objects.create(run=self.run, question=question, token=token)
        vote.options.set(options)
        Vote.objects.filter(pk=vote.pk).update(created_at=self.run.opened_at + self.timedelta(seconds=after))

    def me(self, token):
        return self.client.post(
            f"/api/quizbar/game/{self.room.code}/me/", {"token": token.key},
            content_type="application/json",
        ).json()

    def test_points_rank_and_hidden_until_revealed(self):
        from . import game

        ada, bob, cyd = self.player("Ada"), self.player("Bob"), self.player("Cyd")
        self.open(self.sc)
        self.vote(ada, self.sc, [self.sc_right], after=0)  # 1000
        self.vote(bob, self.sc, [self.sc_right], after=5)  # 750
        self.vote(cyd, self.sc, [self.sc_wrong], after=1)  # 0
        # Before E: the phone's points would give the answer away.
        self.assertEqual(self.me(ada)["score"], 0)
        self.run.answers_revealed = True
        self.run.save()
        mine = self.me(bob)
        self.assertEqual((mine["score"], mine["rank"], mine["players"]), (750, 2, 3))
        self.assertEqual(mine["last"]["points"], 750)
        # Multiple choice: all right choices, nothing else; no limit = 20 s window.
        self.open(self.mc)
        self.vote(ada, self.mc, [self.mc_a], after=1)  # incomplete → 0
        self.vote(bob, self.mc, [self.mc_a, self.mc_b], after=20)  # 500
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        board = self.client.get(f"/api/quizbar/game/runs/{self.run.pk}/leaderboard/").json()
        self.assertEqual(
            [(r["rank"], r["nickname"], r["score"], r["last"]) for r in board["leaderboard"]],
            [(1, "Bob", 1250, 500), (2, "Ada", 1000, 0), (3, "Cyd", 0, None)],
        )
        self.assertEqual(game.points_for(2.5, 10), 875)
        # The podium counts the last question even if its solution was not shown.
        self.run.phase = Run.Phase.CLOSED
        self.run.answers_revealed = False
        self.run.save()
        hidden = self.client.get(f"/api/quizbar/game/runs/{self.run.pk}/leaderboard/").json()
        final = self.client.get(f"/api/quizbar/game/runs/{self.run.pk}/leaderboard/?final=1").json()
        self.assertEqual(hidden["leaderboard"][0]["nickname"], "Ada")
        self.assertEqual(final["leaderboard"][0]["nickname"], "Bob")

    def test_nicknames_unique_per_run_and_suggested_next_time(self):
        from live.models import ParticipantToken

        ada = self.player("Ada")
        other = ParticipantToken.objects.create(room=self.room)
        resp = self.client.post(
            f"/api/quizbar/game/{self.room.code}/enter/",
            {"token": other.key, "run": self.run.pk, "nickname": " ada "},
            content_type="application/json",
        )
        self.assertEqual((resp.status_code, resp.json()), (409, {"error": "taken"}))
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        self.run = Run.objects.create(question_set=self.quiz, phase=Run.Phase.LOBBY)
        mine = self.me(ada)
        self.assertEqual((mine["nickname"], mine["suggested"]), (None, "Ada"))

    def test_payloads(self):
        self.player("Ada")
        payloads = build_payloads(self.room)
        self.assertEqual(
            payloads["participant"]["game"], {"run": self.run.pk, "question": None, "revealed": False}
        )
        self.assertEqual([p["nickname"] for p in payloads["presenter"]["game"]["players"]], ["Ada"])
        self.client.put(
            f"/api/quizbar/sets/{self.quiz.pk}/game/", {"enabled": False},
            content_type="application/json",
        )
        self.assertNotIn("game", build_payloads(self.room)["participant"])

    def test_avatars(self):
        from .avatars import slugs
        from .models import GameEntry

        curie = self.player("Ada", "curie")
        self.player("Bob", "not-a-physicist")
        avatars = dict(GameEntry.objects.values_list("nickname", "avatar"))
        self.assertEqual(avatars["Ada"], "curie")
        self.assertIn(avatars["Bob"], set(slugs()) - {"curie"})  # a free one instead
        board = self.client.get(f"/api/quizbar/game/runs/{self.run.pk}/leaderboard/").json()
        self.assertEqual({r["avatar"] for r in board["leaderboard"]}, set(avatars.values()))
        ada = next(r for r in board["leaderboard"] if r["nickname"] == "Ada")
        self.assertEqual(ada["avatar_icon"], "/static/quizbar/avatars/curie.svg")
        self.assertIsNone(ada["avatar_full"])
        # Next run: the phone suggests the same avatar again.
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        self.run = Run.objects.create(question_set=self.quiz, phase=Run.Phase.LOBBY)
        mine = self.me(curie)
        self.assertEqual(mine["suggested_avatar"], "curie")
        self.assertEqual(len(mine["avatars"]), 30)
        self.assertEqual(mine["needs"], {"nickname": True, "avatar": True})

    def test_defaults_random_names_no_avatars_no_join_screen(self):
        from live.models import ParticipantToken

        from . import funny_names
        from .models import GameEntry

        self.client.put(
            f"/api/quizbar/sets/{self.quiz.pk}/game/", {"nicknames": False, "avatars": False},
            content_type="application/json",
        )
        token = ParticipantToken.objects.create(room=self.room)
        mine = self.me(token)  # joins at once, no join screen
        name = funny_names.for_token(token.key)
        self.assertEqual((mine["nickname"], mine["avatar"]), (name, ""))
        self.assertEqual(len(name.split()), 2)
        # A typed nickname or avatar is ignored.
        resp = self.client.post(
            f"/api/quizbar/game/{self.room.code}/enter/",
            {"token": token.key, "run": self.run.pk, "nickname": "Hacker", "avatar": "curie"},
            content_type="application/json",
        )
        self.assertEqual((resp.json()["nickname"], resp.json()["avatar"]), (name, ""))
        # Same phone, next game: same name.
        self.run.phase = Run.Phase.FINISHED
        self.run.save()
        self.run = Run.objects.create(question_set=self.quiz, phase=Run.Phase.LOBBY)
        self.assertEqual(self.me(token)["nickname"], name)
        self.assertEqual(GameEntry.objects.filter(run=self.run).count(), 1)

    def test_random_names_never_clash(self):
        from . import funny_names

        first = funny_names.for_token("abc")
        self.assertNotEqual(funny_names.for_token("abc", taken=[first]), first)

    def test_avatar_only(self):
        from live.models import ParticipantToken

        from . import funny_names

        self.client.put(
            f"/api/quizbar/sets/{self.quiz.pk}/game/", {"nicknames": False, "avatars": True},
            content_type="application/json",
        )
        token = ParticipantToken.objects.create(room=self.room)
        mine = self.me(token)
        self.assertIsNone(mine["nickname"])
        self.assertEqual(mine["needs"], {"nickname": False, "avatar": True})
        self.assertEqual(mine["name"], funny_names.for_token(token.key))
        resp = self.client.post(
            f"/api/quizbar/game/{self.room.code}/enter/",
            {"token": token.key, "run": self.run.pk, "avatar": "tesla"},
            content_type="application/json",
        ).json()
        self.assertEqual((resp["nickname"], resp["avatar"]), (mine["name"], "tesla"))

    def test_own_pictures(self):
        import shutil
        import tempfile
        from pathlib import Path
        from unittest import mock

        from . import avatars

        folder = Path(tempfile.mkdtemp())
        try:
            shutil.copy(avatars.FOLDER / "newton.svg", folder / "newton.svg")
            (folder / "newton-full.png").write_bytes(b"png")
            (folder / "ada-lovelace.png").write_bytes(b"png")
            with mock.patch.object(avatars, "FOLDER", folder), mock.patch.dict(avatars._cache, {"key": None}):
                found = {a["slug"]: a for a in avatars.available()}
            self.assertEqual(found["newton"]["full"], "/static/quizbar/avatars/newton-full.png")
            self.assertEqual(found["ada-lovelace"]["name"], "Ada Lovelace")
            self.assertEqual(found["ada-lovelace"]["icon"], "/static/quizbar/avatars/ada-lovelace.png")
            self.assertNotIn("einstein", found)  # no picture in that folder
        finally:
            shutil.rmtree(folder)

    def test_avatar_files_exist(self):
        from pathlib import Path

        from .avatar_list import AVATARS

        folder = Path(__file__).parent / "static/quizbar/avatars"
        for slug, _ in AVATARS:
            self.assertTrue((folder / f"{slug}.svg").exists(), slug)

    def test_duplicate_keeps_game_mode(self):
        from . import game

        clone = duplicate_set(self.quiz, self.room)
        self.assertFalse(game.enabled(clone))  # transfer helper alone: no
        resp = self.client.post(f"/api/question-sets/{self.quiz.pk}/duplicate/", {}, content_type="application/json")
        self.assertTrue(game.enabled(QuestionSet.objects.get(pk=resp.json()["id"])))
