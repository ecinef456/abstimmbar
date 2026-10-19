# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Mind-map moderation log (#201): every merge, move, rename and applied AI
proposal is logged with a readable label and can be reset selectively."""
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone

from . import mindmap_log
from . import tests as base
from .models import MindmapModerationEntry, MindmapNode, MindmapPhase
from .state import build_payloads
from .test_ai_mindmap import CHAT

User = get_user_model()


class MindmapLogTestCase(base.MindmapModerationTestCase):
    def log(self):
        """Active entries as the presenter payload delivers them."""
        return build_payloads(self.room)["presenter"]["mindmap"]["moderation_log"]

    def reset(self, entry_id, user=None):
        self.client.force_login(user or self.owner)
        with patch("live.views.broadcast"):
            return self.client.post(
                f"/api/runs/{self.run.pk}/mindmap/{self.mq.pk}/moderation-log/{entry_id}/reset",
                {}, content_type="application/json",
            )

    def parent_of(self, node):
        return MindmapNode.objects.get(pk=node).parent_id


class MindmapLogEntryTests(MindmapLogTestCase):
    def test_merge_is_logged_with_texts(self):
        source = self.contribute("Windkraft")
        target = self.contribute("Windenergie")
        response = self.owner_mod("merge", source=source, target=target)
        self.assertEqual(response.status_code, 200, response.content)
        log = self.log()
        self.assertEqual(len(log), 1)
        entry = log[0]
        self.assertEqual(set(entry), {"id", "kind", "label", "created_at"})
        self.assertEqual(entry["kind"], "merge")
        self.assertEqual(
            entry["label"], {"source": {"text": "Windkraft"}, "target": {"text": "Windenergie"}}
        )
        self.assertEqual(response.json()["log_id"], entry["id"])

    def test_move_is_logged_with_old_and_new_place(self):
        tech = self.contribute("Technik")
        wind = self.contribute("Wind")
        rotor = self.contribute("Rotor", parent=tech)
        response = self.owner_mod("move", node=rotor, parent=wind)
        self.assertEqual(response.status_code, 200, response.content)
        [entry] = self.log()
        self.assertEqual(entry["kind"], "move")
        self.assertEqual(
            entry["label"],
            {"node": {"text": "Rotor"}, "from": {"text": "Technik"}, "to": {"text": "Wind"}},
        )
        self.assertEqual(response.json()["log_id"], entry["id"])
        # Main branch = null place.
        self.owner_mod("move", node=rotor, parent=None)
        self.assertEqual(self.log()[0]["label"]["to"], None)

    def test_noop_move_is_not_logged(self):
        a = self.contribute("A")
        response = self.owner_mod("move", node=a, parent=None)
        self.assertIsNone(response.json()["log_id"])
        self.assertEqual(self.log(), [])

    def test_rename_is_logged(self):
        a = self.contribute("Wnd")
        response = self.owner_mod("rename", node=a, text="Wind")
        [entry] = self.log()
        self.assertEqual(entry["kind"], "rename")
        self.assertEqual(entry["label"], {"old": {"text": "Wnd"}, "new": {"text": "Wind"}})
        self.assertEqual(response.json()["log_id"], entry["id"])

    def test_rename_into_sibling_is_logged_as_merge(self):
        a = self.contribute("Wnd")
        self.contribute("Wind")
        self.owner_mod("rename", node=a, text="wind")
        [entry] = self.log()
        self.assertEqual(entry["kind"], "merge")
        self.assertEqual(
            entry["label"], {"source": {"text": "Wnd"}, "target": {"text": "Wind"}}
        )

    def test_seeded_terms_carry_their_translations(self):
        self.mq.mindmap_seed = [{
            "text": {"de": "Wind", "en": "Wind power"},
            "description": {"de": "", "en": ""}, "children": [],
        }]
        self.mq.save()
        self.tree("presenter")  # materialise the seed
        seeded = MindmapNode.objects.get(run=self.run, seeded=True)
        other = self.contribute("Windkraft")
        self.owner_mod("merge", source=other, target=seeded.pk)
        target = self.log()[0]["label"]["target"]
        self.assertEqual(target["text"], "Wind")
        self.assertEqual(target["text_i18n"]["en"], "Wind power")

    def test_newest_first_and_hide_add_not_logged(self):
        a = self.contribute("A")
        b = self.contribute("B")
        self.owner_mod("rename", node=a, text="A2")
        self.owner_mod("move", node=b, parent=a)
        self.owner_mod("add", parent=None, text="C")
        self.hide(self.run, b)
        self.assertEqual([e["kind"] for e in self.log()], ["move", "rename"])

    def test_failed_action_is_not_logged(self):
        a = self.contribute("A")
        self.assertEqual(self.owner_mod("merge", source=a, target=a).status_code, 400)
        self.assertEqual(self.owner_mod("move", node=a, parent=999999).status_code, 404)
        self.assertEqual(MindmapModerationEntry.objects.count(), 0)

    def test_no_participant_data_in_log(self):
        t1, t2 = self.join(), self.join()
        source = self.contribute("Wind", token=t1, description="geheim")
        target = self.contribute("Windkraft", token=t2)
        self.owner_mod("merge", source=source, target=target)
        dumped = json.dumps(self.log())
        for secret in (t1, t2):
            self.assertNotIn(secret, dumped)
        entry = MindmapModerationEntry.objects.get()
        self.assertNotIn(t1, json.dumps(entry.label))

    def test_log_only_in_presenter_payload(self):
        a = self.contribute("A")
        self.owner_mod("rename", node=a, text="B")
        participant = build_payloads(self.room)["participant"]["mindmap"]
        self.assertNotIn("moderation_log", participant)


class MindmapLogResetTests(MindmapLogTestCase):
    def test_reset_merge_restores_exactly(self):
        t1, t2 = self.join(), self.join()
        source = self.contribute("Wind", token=t1)
        self.contribute("Wind", token=t2)
        target = self.contribute("Windkraft", token=t2)
        before = self.shape()
        log_id = self.owner_mod("merge", source=source, target=target).json()["log_id"]
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"status": "ok", "id": log_id, "kind": "merge"})
        self.assertEqual(self.shape(), before)
        self.assertEqual(self.log(), [])
        self.assertEqual(MindmapModerationEntry.objects.get().state, "reset")

    def test_selective_reset_of_older_merge(self):
        a = self.contribute("A")
        a2 = self.contribute("A2")
        b = self.contribute("B")
        b2 = self.contribute("B2")
        first = self.owner_mod("merge", source=a2, target=a).json()["log_id"]
        second = self.owner_mod("merge", source=b2, target=b).json()["log_id"]
        self.assertEqual(self.reset(first).status_code, 200)
        self.assertTrue(MindmapNode.objects.filter(pk=a2).exists())
        self.assertFalse(MindmapNode.objects.filter(pk=b2).exists())
        self.assertEqual([e["id"] for e in self.log()], [second])

    def test_reset_move(self):
        tech = self.contribute("Technik")
        wind = self.contribute("Wind")
        rotor = self.contribute("Rotor", parent=tech)
        log_id = self.owner_mod("move", node=rotor, parent=wind).json()["log_id"]
        self.contribute("Blatt", parent=rotor)  # children come along
        self.assertEqual(self.reset(log_id).status_code, 200)
        self.assertEqual(self.parent_of(rotor), tech)
        self.assertEqual(self.log(), [])

    def test_reset_rename(self):
        a = self.contribute("Wnd")
        log_id = self.owner_mod("rename", node=a, text="Wind").json()["log_id"]
        self.assertEqual(self.reset(log_id).status_code, 200)
        self.assertEqual(MindmapNode.objects.get(pk=a).text, "Wnd")

    @override_settings(**base.AI_ON)
    def test_ai_apply_logged_and_reset(self):
        self.mq.wordcloud_ai_enabled = True
        self.mq.save()
        wind = self.contribute("Wind")
        windkraft = self.contribute("Windkraft")
        energy = self.contribute("Energy")
        before = self.shape()
        ops = [
            {"type": "merge", "source": windkraft, "target": wind, "reason": "Synonym"},
            {"type": "rename", "node": energy, "text": "Energie"},
        ]
        self.client.force_login(self.owner)
        with patch(CHAT, return_value={"ops": ops}), patch("live.views.broadcast"):
            proposal = self.mod("ai-optimize").json()["proposal"]
            response = self.mod("ai-apply", proposal=proposal, selected=[0, 1])
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["applied"], 2)
        # One entry for the whole batch, none for its single ops.
        [entry] = self.log()
        self.assertEqual(entry["kind"], "ai")
        self.assertEqual(entry["label"], {"count": 2})
        self.assertEqual(response.json()["log_id"], entry["id"])
        self.assertEqual(self.reset(entry["id"]).status_code, 200)
        self.assertEqual(self.shape(), before)
        self.assertEqual(self.log(), [])

    def test_conflict_is_409_and_changes_nothing(self):
        a = self.contribute("A")
        b = self.contribute("B")
        log_id = self.owner_mod("merge", source=a, target=b).json()["log_id"]
        # A new term with the merged-away name at the same place blocks it.
        self.contribute("A")
        before = self.shape()
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json()["detail"],
            "The mind map has changed in the meantime — this can no longer be undone.",
        )
        self.assertEqual(self.shape(), before)
        self.assertEqual([e["id"] for e in self.log()], [log_id])

    def test_move_conflicts(self):
        tech = self.contribute("Technik")
        wind = self.contribute("Wind")
        sun = self.contribute("Sonne")
        rotor = self.contribute("Rotor", parent=tech)
        first = self.owner_mod("move", node=rotor, parent=wind).json()["log_id"]
        self.owner_mod("move", node=rotor, parent=sun)
        # Moved on since: the older move can't be reset on its own.
        response = self.reset(first)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "The term's place has changed since.")
        self.assertEqual(self.parent_of(rotor), sun)

    def test_move_conflict_original_place_gone(self):
        tech = self.contribute("Technik")
        rotor = self.contribute("Rotor", parent=tech)
        log_id = self.owner_mod("move", node=rotor, parent=None).json()["log_id"]
        self.owner_mod("add", parent=None, text="X")
        MindmapNode.objects.filter(pk=tech).delete()
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "The original place no longer exists.")
        self.assertIsNone(self.parent_of(rotor))

    def test_move_conflict_name_clash(self):
        tech = self.contribute("Technik")
        rotor = self.contribute("Rotor", parent=tech)
        log_id = self.owner_mod("move", node=rotor, parent=None).json()["log_id"]
        self.contribute("Rotor", parent=tech)
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json()["detail"],
            "A term with this name already exists at the original place.",
        )

    def test_move_conflict_term_gone(self):
        tech = self.contribute("Technik")
        rotor = self.contribute("Rotor", parent=tech)
        log_id = self.owner_mod("move", node=rotor, parent=None).json()["log_id"]
        MindmapNode.objects.filter(pk=rotor).delete()
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "The term no longer exists.")

    def test_reset_twice_is_409(self):
        a = self.contribute("Wnd")
        log_id = self.owner_mod("rename", node=a, text="Wind").json()["log_id"]
        self.assertEqual(self.reset(log_id).status_code, 200)
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "This change has already been reset.")

    def test_reset_refused_while_rating(self):
        self.mq.mindmap_rating_mode = "points"
        self.mq.save()
        a = self.contribute("Wnd")
        log_id = self.owner_mod("rename", node=a, text="Wind").json()["log_id"]
        MindmapPhase.objects.create(run=self.run, question=self.mq, stage="rate")
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "Not possible while rating is in progress.")
        self.assertEqual(MindmapNode.objects.get(pk=a).text, "Wind")
        self.assertEqual(len(self.log()), 1)

    def test_owner_only_and_scoped(self):
        a = self.contribute("Wnd")
        log_id = self.owner_mod("rename", node=a, text="Wind").json()["log_id"]
        eve = User.objects.create_user(username="eve")
        self.assertEqual(self.reset(log_id, user=eve).status_code, 404)
        self.client.logout()
        response = self.client.post(
            f"/api/runs/{self.run.pk}/mindmap/{self.mq.pk}/moderation-log/{log_id}/reset",
            {}, content_type="application/json",
        )
        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(self.reset(999999).status_code, 404)
        # An entry of another question is not reachable through this one.
        self.client.force_login(self.owner)
        with patch("live.views.broadcast"):
            response = self.client.post(
                f"/api/runs/{self.run.pk}/mindmap/{self.question.pk}/moderation-log/{log_id}/reset",
                {}, content_type="application/json",
            )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(MindmapNode.objects.get(pk=a).text, "Wind")

    def test_reset_broadcasts(self):
        a = self.contribute("Wnd")
        log_id = self.owner_mod("rename", node=a, text="Wind").json()["log_id"]
        self.client.force_login(self.owner)
        with patch("live.views.broadcast") as bc:
            self.client.post(
                f"/api/runs/{self.run.pk}/mindmap/{self.mq.pk}/moderation-log/{log_id}/reset",
                {}, content_type="application/json",
            )
        bc.assert_called_once()


class MindmapLogTopUndoTests(MindmapLogTestCase):
    """The beamer's own undo (top) marks the matching entry as reset."""

    def test_unmerge_marks_merge_entry(self):
        a = self.contribute("A")
        b = self.contribute("B")
        c = self.contribute("C")
        keep = self.owner_mod("rename", node=c, text="C2").json()["log_id"]
        undo = self.owner_mod("merge", source=a, target=b).json()["undo"]
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 200)
        self.assertEqual([e["id"] for e in self.log()], [keep])

    def test_unmerge_marks_rename_entry(self):
        a = self.contribute("Wnd")
        undo = self.owner_mod("rename", node=a, text="Wind").json()["undo"]
        self.owner_mod("unmerge", undo=undo)
        self.assertEqual(self.log(), [])

    def test_move_back_marks_move_entry(self):
        tech = self.contribute("Technik")
        wind = self.contribute("Wind")
        rotor = self.contribute("Rotor", parent=tech)
        undo = self.owner_mod("move", node=rotor, parent=wind).json()["undo"]
        response = self.owner_mod("move", node=undo["node"], parent=undo["parent"])
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["log_id"])
        self.assertEqual(self.log(), [])
        # Redo = a fresh move → a fresh entry.
        self.owner_mod("move", node=rotor, parent=wind)
        self.assertEqual(len(self.log()), 1)

    def test_move_back_only_reverses_newest_move_of_that_term(self):
        tech = self.contribute("Technik")
        wind = self.contribute("Wind")
        sun = self.contribute("Sonne")
        rotor = self.contribute("Rotor", parent=tech)
        first = self.owner_mod("move", node=rotor, parent=wind).json()["log_id"]
        self.owner_mod("move", node=rotor, parent=sun)
        self.owner_mod("move", node=rotor, parent=wind)  # undo of the second
        self.assertEqual([e["id"] for e in self.log()], [first])
        self.owner_mod("move", node=rotor, parent=tech)  # undo of the first
        self.assertEqual(self.log(), [])

    @override_settings(**base.AI_ON)
    def test_ai_undo_marks_ai_entry(self):
        self.mq.wordcloud_ai_enabled = True
        self.mq.save()
        wind = self.contribute("Wind")
        windkraft = self.contribute("Windkraft")
        self.contribute("Energy")
        ops = [{"type": "merge", "source": windkraft, "target": wind, "reason": "x"}]
        self.client.force_login(self.owner)
        with patch(CHAT, return_value={"ops": ops}), patch("live.views.broadcast"):
            proposal = self.mod("ai-optimize").json()["proposal"]
            undo = self.mod("ai-apply", proposal=proposal, selected=[0]).json()["undo"]
            self.assertEqual(len(self.log()), 1)
            self.assertEqual(self.mod("ai-undo", undo=undo).status_code, 200)
        self.assertEqual(self.log(), [])

    def test_failed_top_undo_keeps_entry(self):
        a = self.contribute("A")
        b = self.contribute("B")
        undo = self.owner_mod("merge", source=a, target=b).json()["undo"]
        self.contribute("A")
        self.assertEqual(self.owner_mod("unmerge", undo=undo).status_code, 409)
        self.assertEqual(len(self.log()), 1)


class MindmapLogReviewFixTests(MindmapLogTestCase):
    def later(self):
        later = timezone.now() + timezone.timedelta(hours=25)
        return patch("django.core.signing.time.time", return_value=later.timestamp())

    def test_parent_merged_away_gives_neutral_reason(self):
        tech = self.contribute("Technik")
        wind = self.contribute("Wind")
        energie = self.contribute("Energie")
        rotor = self.contribute("Rotor", parent=tech)
        log_id = self.owner_mod("move", node=rotor, parent=wind).json()["log_id"]
        self.owner_mod("merge", source=wind, target=energie)
        response = self.reset(log_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "The term's place has changed since.")
        self.assertEqual(self.parent_of(rotor), energie)

    def test_log_reset_ignores_token_expiry(self):
        a, b = self.contribute("A"), self.contribute("B")
        c = self.contribute("Wnd")
        merge_id = self.owner_mod("merge", source=a, target=b).json()["log_id"]
        merge_undo = MindmapModerationEntry.objects.get(pk=merge_id).undo
        rename_id = self.owner_mod("rename", node=c, text="Wind").json()["log_id"]
        with self.later():
            # Client-held blobs still expire ...
            response = self.owner_mod("unmerge", undo=merge_undo)
            self.assertEqual(response.status_code, 409)
            self.assertIn("expired", response.json()["detail"])
            # ... the log's server-side undo data does not.
            self.assertEqual(self.reset(merge_id).status_code, 200)
            self.assertEqual(self.reset(rename_id).status_code, 200)
        self.assertTrue(MindmapNode.objects.filter(pk=a).exists())
        self.assertEqual(MindmapNode.objects.get(pk=c).text, "Wnd")

    @override_settings(**base.AI_ON)
    def test_ai_log_reset_ignores_token_expiry(self):
        self.mq.wordcloud_ai_enabled = True
        self.mq.save()
        wind = self.contribute("Wind")
        windkraft = self.contribute("Windkraft")
        self.contribute("Energy")
        ops = [{"type": "merge", "source": windkraft, "target": wind, "reason": "x"}]
        self.client.force_login(self.owner)
        with patch(CHAT, return_value={"ops": ops}), patch("live.views.broadcast"):
            proposal = self.mod("ai-optimize").json()["proposal"]
            body = self.mod("ai-apply", proposal=proposal, selected=[0]).json()
        with self.later():
            self.client.force_login(self.owner)
            with patch("live.views.broadcast"):
                response = self.mod("ai-undo", undo=body["undo"])
            self.assertEqual(response.status_code, 409)
            self.assertIn("expired", response.json()["detail"])
            self.assertEqual(self.reset(body["log_id"]).status_code, 200)
        self.assertTrue(MindmapNode.objects.filter(pk=windkraft).exists())

    def test_tampered_log_undo_still_refused(self):
        a = self.contribute("Wnd")
        log_id = self.owner_mod("rename", node=a, text="Wind").json()["log_id"]
        MindmapModerationEntry.objects.filter(pk=log_id).update(undo="tampered")
        self.assertEqual(self.reset(log_id).status_code, 400)
        self.assertEqual(MindmapNode.objects.get(pk=a).text, "Wind")

    def test_payload_capped_at_newest(self):
        a = self.contribute("A")
        entries = [
            MindmapModerationEntry(
                run=self.run, question=self.mq, kind="ai", label={"count": i}, undo=[]
            )
            for i in range(mindmap_log.PAYLOAD_MAX + 5)
        ]
        MindmapModerationEntry.objects.bulk_create(entries)
        newest = self.owner_mod("rename", node=a, text="B").json()["log_id"]
        log = self.log()
        self.assertEqual(len(log), mindmap_log.PAYLOAD_MAX)
        self.assertEqual(log[0]["id"], newest)

    def test_entries_go_with_deleted_results(self):
        a = self.contribute("A")
        self.owner_mod("rename", node=a, text="B")
        self.client.force_login(self.owner)
        with patch("live.views.broadcast"):
            response = self.client.post(
                f"/api/question-sets/{self.question_set.pk}/delete-results/"
            )
        self.assertIn(response.status_code, (200, 204), response.content)
        self.assertEqual(MindmapModerationEntry.objects.count(), 0)
