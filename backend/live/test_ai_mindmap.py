# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Mindmap stage 3: AI optimisation — prompt, parsing, simulation (preview),
batch apply and undo. The LLM is always faked (no network)."""
from unittest.mock import patch

from basicbar_integrations import ai as ai_module
from django.contrib.auth import get_user_model
from django.test import override_settings

from . import ai_mindmap, mindmap
from . import tests as base
from .models import MindmapContribution, MindmapNode, MindmapPhase, ParticipantToken

User = get_user_model()
CHAT = "basicbar_integrations.ai.chat_json"


class MindmapAiTestCase(base.MindmapModerationTestCase):
    """A map with: Wind (2 participants), Windkraft (2, one shared with Wind),
    Solar (1), Energy (1), Speicher (presenter-added), Spam (hidden)."""

    def setUp(self):
        super().setUp()
        self.mq.wordcloud_ai_enabled = True
        self.mq.save()
        self.t1, self.t2, self.t3, self.t4 = (self.join() for _ in range(4))
        self.wind = self.contribute("Wind", token=self.t1)
        self.contribute("Wind", token=self.t2)
        self.windkraft = self.contribute("Windkraft", token=self.t2)
        self.contribute("Windkraft", token=self.t3)
        self.solar = self.contribute("Solar", token=self.t1)
        self.energy = self.contribute("Energy", token=self.t4)
        self.speicher = self.owner_mod("add", parent=None, text="Speicher").json()["node_id"]
        self.spam = self.contribute("Spam", token=self.t4)
        MindmapNode.objects.filter(pk=self.spam).update(hidden=True)
        self.client.logout()

    def url(self, op, question=None):
        return f"/api/runs/{self.run.pk}/mindmap/{(question or self.mq).pk}/{op}"

    def post(self, op, body=None, user=None, question=None):
        self.client.force_login(user or self.owner)
        with patch("live.views.broadcast"):
            return self.client.post(
                self.url(op, question), body or {}, content_type="application/json"
            )

    @override_settings(**base.AI_ON)
    def optimize(self, ops, **body):
        with patch(CHAT, return_value={"ops": ops}) as chat:
            response = self.post("ai-optimize", body)
        self.chat = chat
        return response

    def options(self, **overrides):
        return {**mindmap.ai_settings(self.mq), **overrides}

    def simulate(self, ops, selected=None, **options):
        return mindmap.simulate_ops(
            self.run, self.mq, ai_mindmap.parse_ops({"ops": ops}),
            self.options(**options), selected,
        )

    def contributions(self):
        return sorted(
            MindmapContribution.objects.filter(node__run=self.run).values_list(
                # A dropped duplicate comes back with a new id (as in unmerge).
                "node__text", "token_id", "description", "created_at"
            )
        )

    def preview_node(self, preview, text):
        def walk(nodes):
            for node in nodes:
                if node["text"] == text:
                    return node
                found = walk(node["children"])
                if found:
                    return found
            return None

        return walk(preview["nodes"])


class MindmapAiPromptTests(MindmapAiTestCase):
    def prompt(self, **options):
        tree = mindmap.build_tree(self.run, self.mq, presenter=True)
        return ai_mindmap.build_prompt(tree, self.mq, self.options(**options))

    def test_prompt_has_terms_but_no_tokens_and_no_hidden(self):
        system, user = self.prompt()
        for token in ParticipantToken.objects.values_list("key", flat=True):
            self.assertNotIn(token, system + user)
        for term in ("Wind", "Windkraft", "Solar", "Energy", "Speicher"):
            self.assertIn(f'"{term}"', user)
        self.assertNotIn("Spam", user)
        self.assertIn("Energiewende", user)  # question context
        self.assertIn('"fixed": true', user)  # Speicher

    def test_prompt_follows_options(self):
        system, user = self.prompt(merge=False, restructure=False, target_lang="en")
        self.assertNotIn('"merge"', system.split("Regeln:")[0])
        self.assertNotIn('"move"', system.split("Regeln:")[0])
        self.assertIn('"rename"', system)
        self.assertIn("Englisch", system + user)
        self.assertIn(f"höchstens {self.mq.mindmap_depth} Ebenen", system)


class MindmapAiParseTests(MindmapAiTestCase):
    def test_parse_keeps_well_formed_and_drops_malformed(self):
        ops = ai_mindmap.parse_ops({"ops": [
            {"type": "merge", "source": 1, "target": 2, "reason": "  Synonym "},
            {"type": "merge", "source": "1", "target": 2},  # string id
            {"type": "merge", "source": True, "target": 2},  # bool
            {"type": "rename", "node": 3, "text": ""},  # empty
            {"type": "rename", "node": 3, "text": "Energie"},
            {"type": "delete", "node": 3},  # unknown type
            {"type": "move", "node": 4, "parent": "n1"},  # ref before its add
            {"type": "add", "ref": "n1", "parent": None, "text": "Erneuerbare"},
            {"type": "add", "ref": "n1", "parent": None, "text": "Doppelt"},  # ref reused
            {"type": "add", "ref": "n2", "parent": "nope", "text": "X"},  # unknown ref
            {"type": "move", "node": 4, "parent": "n1"},
            {"type": "move", "node": 5, "parent": None},
            "garbage",
        ]})
        self.assertEqual(
            [(op["index"], op["type"]) for op in ops],
            [(0, "merge"), (1, "rename"), (2, "add"), (3, "move"), (4, "move")],
        )
        self.assertEqual(ops[0]["reason"], "Synonym")
        self.assertEqual(ops[2], {"type": "add", "ref": "n1", "parent": None,
                                  "text": "Erneuerbare", "reason": "", "index": 2})
        self.assertEqual(ai_mindmap.parse_ops({"ops": "x"}), [])
        self.assertEqual(ai_mindmap.parse_ops(["x"]), [])
        self.assertEqual(ai_mindmap.raw_count({"ops": [1, 2, 3]}), 3)


class MindmapAiSimulateTests(MindmapAiTestCase):
    def test_merge_preview_counts_distinct_participants(self):
        result = self.simulate([{"type": "merge", "source": self.windkraft, "target": self.wind}])
        self.assertEqual(result["dropped"], 0)
        self.assertEqual(result["ops"][0]["label"], "Windkraft → Wind")
        self.assertEqual(result["ops"][0]["source_text"], "Windkraft")
        wind = self.preview_node(result["preview"], "Wind")
        self.assertEqual(wind["count"], 3)  # t1, t2, t3 — t2 only once
        self.assertEqual(wind["merged_from"], ["Windkraft"])
        self.assertIsNone(self.preview_node(result["preview"], "Windkraft"))
        # Nothing changed in the database.
        self.assertTrue(MindmapNode.objects.filter(pk=self.windkraft).exists())

    def test_fixed_terms_are_never_merge_source_renamed_or_moved(self):
        result = self.simulate([
            {"type": "merge", "source": self.speicher, "target": self.wind},
            {"type": "rename", "node": self.speicher, "text": "Storage"},
            {"type": "move", "node": self.speicher, "parent": self.wind},
            {"type": "merge", "source": self.solar, "target": self.speicher},  # target: ok
        ])
        self.assertEqual([op["index"] for op in result["ops"]], [3])
        self.assertEqual(result["dropped"], 3)
        speicher = self.preview_node(result["preview"], "Speicher")
        self.assertEqual(speicher["merged_from"], ["Solar"])

    def test_hidden_terms_untouched(self):
        result = self.simulate([
            {"type": "rename", "node": self.spam, "text": "Spam!"},
            {"type": "merge", "source": self.spam, "target": self.wind},
            {"type": "merge", "source": self.solar, "target": self.spam},
            {"type": "move", "node": self.spam, "parent": self.wind},
            {"type": "move", "node": self.solar, "parent": self.spam},
            {"type": "add", "ref": "n1", "parent": self.spam, "text": "X"},
        ])
        self.assertEqual(result["ops"], [])
        self.assertEqual(result["dropped"], 6)
        self.assertTrue(self.preview_node(result["preview"], "Spam")["hidden"])

    def test_unknown_ids_dropped(self):
        result = self.simulate([
            {"type": "merge", "source": 999999, "target": self.wind},
            {"type": "rename", "node": 999999, "text": "X"},
            {"type": "move", "node": self.solar, "parent": 999999},
            {"type": "rename", "node": self.energy, "text": "Energy"},  # no change
        ])
        self.assertEqual((result["ops"], result["dropped"]), ([], 4))

    def test_depth_respected(self):
        self.mq.mindmap_depth = 1
        self.mq.save()
        result = self.simulate([
            {"type": "move", "node": self.solar, "parent": self.wind},
            {"type": "add", "ref": "n1", "parent": self.wind, "text": "Rotor"},
            {"type": "add", "ref": "n2", "parent": None, "text": "Erneuerbare"},
        ])
        self.assertEqual([op["type"] for op in result["ops"]], ["add"])
        self.assertEqual(result["dropped"], 2)

    def test_add_and_move_chain_preview(self):
        result = self.simulate([
            {"type": "add", "ref": "n1", "parent": None, "text": "Erneuerbare"},
            {"type": "move", "node": self.wind, "parent": "n1"},
            {"type": "move", "node": self.solar, "parent": "n1"},
            {"type": "rename", "node": self.energy, "text": "Energie"},
        ])
        self.assertEqual(result["dropped"], 0)
        self.assertEqual([op["requires"] for op in result["ops"]], [[], [0], [0], []])
        self.assertEqual(result["ops"][1]["parent_text"], "Erneuerbare")
        self.assertEqual(result["active"], [0, 1, 2, 3])
        new = self.preview_node(result["preview"], "Erneuerbare")
        self.assertTrue(new["new"])
        self.assertLess(new["id"], 0)
        self.assertEqual([c["text"] for c in new["children"]], ["Wind", "Solar"])
        self.assertTrue(new["children"][0]["moved"])
        self.assertEqual(self.preview_node(result["preview"], "Energie")["renamed_from"], "Energy")

    def test_deselected_add_drops_its_dependants(self):
        ops = [
            {"type": "add", "ref": "n1", "parent": None, "text": "Erneuerbare"},
            {"type": "move", "node": self.wind, "parent": "n1"},
            {"type": "rename", "node": self.energy, "text": "Energie"},
        ]
        result = self.simulate(ops, selected=[1, 2])
        self.assertEqual(len(result["ops"]), 3)  # the full checklist stays
        self.assertEqual(result["active"], [2])
        self.assertIsNone(self.preview_node(result["preview"], "Erneuerbare"))
        self.assertNotIn("moved", self.preview_node(result["preview"], "Wind"))

    def test_add_of_existing_term_reuses_it(self):
        result = self.simulate([
            {"type": "add", "ref": "n1", "parent": None, "text": "wind"},
            {"type": "move", "node": self.solar, "parent": "n1"},
        ])
        self.assertEqual([op["type"] for op in result["ops"]], ["move"])
        self.assertEqual(result["ops"][0]["parent_text"], "Wind")
        self.assertEqual(result["dropped"], 0)

    def test_rename_into_sibling_merges(self):
        result = self.simulate([{"type": "rename", "node": self.windkraft, "text": "wind"}])
        self.assertEqual(result["ops"][0]["merges_into"], self.wind)
        self.assertEqual(self.preview_node(result["preview"], "Wind")["merged_from"], ["Windkraft"])

    def test_switched_off_kinds_dropped(self):
        result = self.simulate(
            [{"type": "merge", "source": self.windkraft, "target": self.wind},
             {"type": "add", "ref": "n1", "parent": None, "text": "X"}],
            merge=False, restructure=False,
        )
        self.assertEqual((result["ops"], result["dropped"]), ([], 2))


class MindmapAiEndpointTests(MindmapAiTestCase):
    def ops(self):
        return [
            {"type": "merge", "source": self.windkraft, "target": self.wind, "reason": "Synonym"},
            {"type": "add", "ref": "n1", "parent": None, "text": "Erneuerbare"},
            {"type": "move", "node": self.wind, "parent": "n1"},
            {"type": "move", "node": self.solar, "parent": "n1"},
            {"type": "rename", "node": self.energy, "text": "Energie"},
            {"type": "explode"},  # malformed → counted as dropped
        ]

    def test_optimize_returns_preview_and_proposal(self):
        response = self.optimize(self.ops())
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(
            set(body), {"ops", "dropped", "preview", "active", "proposal", "settings"}
        )
        self.assertEqual(len(body["ops"]), 5)
        self.assertEqual(body["dropped"], 1)
        self.assertEqual(body["settings"]["target_lang"], "de")
        self.chat.assert_called_once()
        # Nothing applied yet.
        self.assertEqual(MindmapNode.objects.get(pk=self.energy).text, "Energy")

    def test_overrides_saved_and_validated(self):
        response = self.optimize([], merge=False, target_lang="en")
        self.assertEqual(response.status_code, 200, response.content)
        self.mq.refresh_from_db()
        self.assertFalse(self.mq.mindmap_ai_merge)
        self.assertEqual(self.mq.mindmap_ai_target_lang, "en")
        self.assertEqual(response.json()["settings"]["target_lang"], "en")
        for bad in ({"merge": "no"}, {"target_lang": "fr"}, {"translate": 1}):
            self.assertEqual(self.optimize([], **bad).status_code, 400, bad)
        self.assertEqual(
            self.optimize([], merge=False, translate=False, restructure=False).status_code, 400
        )
        self.mq.refresh_from_db()
        self.assertTrue(self.mq.mindmap_ai_translate)

    def apply(self, proposal, selected):
        return self.post("ai-apply", {"proposal": proposal, "selected": selected})

    def test_apply_and_undo_round_trip_restores_exact_map(self):
        before_shape, before_contribs = self.shape(), self.contributions()
        before_ids = set(MindmapNode.objects.values_list("pk", flat=True))
        body = self.optimize(self.ops()).json()
        self.client.force_login(self.owner)
        with patch("live.views.broadcast") as bc:
            response = self.client.post(
                self.url("ai-apply"),
                {"proposal": body["proposal"], "selected": [op["index"] for op in body["ops"]]},
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 200, response.content)
        bc.assert_called_once()
        result = response.json()
        self.assertEqual((result["applied"], result["skipped"]), (5, 0))
        self.assertEqual(
            [item["type"] for item in result["undo"]],
            ["merge", "add", "move", "move", "rename"],
        )
        new = MindmapNode.objects.get(run=self.run, text="Erneuerbare")
        self.assertTrue(new.teacher)
        self.assertEqual(MindmapNode.objects.get(pk=self.wind).parent_id, new.pk)
        self.assertEqual(MindmapNode.objects.get(pk=self.wind).contributions.count(), 3)
        self.assertEqual(MindmapNode.objects.get(pk=self.energy).text, "Energie")
        self.assertFalse(MindmapNode.objects.filter(pk=self.windkraft).exists())

        response = self.post("ai-undo", {"undo": result["undo"]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.shape(), before_shape)
        self.assertEqual(self.contributions(), before_contribs)
        self.assertEqual(set(MindmapNode.objects.values_list("pk", flat=True)), before_ids)

    def test_apply_selection_skips_dependants_of_deselected_add(self):
        body = self.optimize(self.ops()).json()
        result = self.apply(body["proposal"], [2, 4]).json()  # moves into n1 + rename
        self.assertEqual((result["applied"], result["skipped"]), (1, 1))
        self.assertFalse(MindmapNode.objects.filter(text="Erneuerbare").exists())
        self.assertIsNone(MindmapNode.objects.get(pk=self.wind).parent_id)

    def test_apply_skips_ops_invalidated_in_between(self):
        body = self.optimize(self.ops()).json()
        # Meanwhile: Windkraft merged by hand, Solar hidden.
        self.owner_mod("merge", source=self.windkraft, target=self.wind)
        MindmapNode.objects.filter(pk=self.solar).update(hidden=True)
        result = self.apply(body["proposal"], [0, 1, 2, 3, 4]).json()
        self.assertEqual((result["applied"], result["skipped"]), (3, 2))
        self.assertIsNone(MindmapNode.objects.get(pk=self.solar).parent_id)

    def test_undo_refused_when_map_changed(self):
        body = self.optimize(self.ops()).json()
        undo = self.apply(body["proposal"], [1, 2, 4]).json()["undo"]
        new = MindmapNode.objects.get(run=self.run, text="Erneuerbare")
        self.contribute("Erneuerbare", token=self.join())  # someone joined the new term
        self.client.force_login(self.owner)
        response = self.post("ai-undo", {"undo": undo})
        self.assertEqual(response.status_code, 409)
        self.assertIn("detail", response.json())
        # All or nothing: the rename and the move stay.
        self.assertEqual(MindmapNode.objects.get(pk=self.energy).text, "Energie")
        self.assertEqual(MindmapNode.objects.get(pk=self.wind).parent_id, new.pk)

    def test_bad_input(self):
        body = self.optimize(self.ops()).json()
        for bad in (
            {"proposal": body["proposal"], "selected": [99]},
            {"proposal": body["proposal"], "selected": ["0"]},
            {"proposal": body["proposal"], "selected": [True]},
            {"proposal": body["proposal"] + "x", "selected": [0]},
            {"proposal": 1, "selected": [0]},
        ):
            self.assertEqual(self.post("ai-apply", bad).status_code, 400, bad)
            if bad["selected"] != [99]:  # preview ignores unknown indices
                self.assertEqual(self.post("ai-preview", bad).status_code, 400, bad)
        for bad in ([], [{"type": "move", "data": {"node": "1"}}], "x",
                    [{"type": "merge", "data": "forged"}], [{"type": "drop", "data": {}}]):
            self.assertEqual(self.post("ai-undo", {"undo": bad}).status_code, 400, bad)
        self.assertTrue(MindmapNode.objects.filter(pk=self.windkraft).exists())

    def test_proposal_bound_to_question(self):
        body = self.optimize(self.ops()).json()
        other = base.Question.objects.create(
            question_set=self.question_set, kind="mindmap", text_de="<p>X</p>", position=9
        )
        response = self.post(
            "ai-apply", {"proposal": body["proposal"], "selected": [0]}, question=other
        )
        self.assertEqual(response.status_code, 400)

    def test_preview_endpoint_resimulates_selection(self):
        body = self.optimize(self.ops()).json()
        response = self.post("ai-preview", {"proposal": body["proposal"], "selected": [2, 4]})
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertEqual(data["active"], [4])
        self.assertEqual(data["dropped"], 1)
        self.assertEqual(len(data["ops"]), 5)

    def test_non_owner_404_everywhere(self):
        eve = User.objects.create_user(username="eve")
        for op in ("ai-optimize", "ai-preview", "ai-apply", "ai-undo"):
            with override_settings(**base.AI_ON), patch(CHAT) as chat:
                self.assertEqual(self.post(op, {}, user=eve).status_code, 404, op)
            chat.assert_not_called()

    def test_rating_stage_refused(self):
        body = self.optimize(self.ops()).json()
        self.mq.mindmap_rating_mode = "points"
        self.mq.save()
        MindmapPhase.objects.create(run=self.run, question=self.mq, stage=MindmapPhase.Stage.RATE)
        response = self.optimize(self.ops())
        self.assertEqual(response.status_code, 409)
        self.chat.assert_not_called()
        self.assertEqual(self.apply(body["proposal"], [0]).status_code, 409)
        self.assertTrue(MindmapNode.objects.filter(pk=self.windkraft).exists())

    def test_needs_three_visible_terms(self):
        MindmapNode.objects.filter(pk__in=[self.wind, self.windkraft, self.solar]).update(
            hidden=True
        )
        response = self.optimize(self.ops())
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "At least 3 terms are needed.")
        self.chat.assert_not_called()

    def test_ai_error_502(self):
        with override_settings(**base.AI_ON), patch(CHAT, side_effect=ai_module.AIError("boom")):
            response = self.post("ai-optimize")
        self.assertEqual(response.status_code, 502)
        self.assertIn("boom", response.json()["detail"])

    def test_ai_off_and_switch_off(self):
        with override_settings(**base.AI_OFF), patch(CHAT) as chat:
            self.assertEqual(self.post("ai-optimize").status_code, 503)
        chat.assert_not_called()
        self.mq.wordcloud_ai_enabled = False
        self.mq.save()
        response = self.optimize(self.ops())
        self.assertEqual(response.status_code, 400)
        self.chat.assert_not_called()

    def test_presenter_payload_carries_settings(self):
        question = base.build_payloads(self.room)["presenter"]["question"]
        self.assertEqual(
            question["mindmap_ai"],
            {"merge": True, "translate": True, "target_lang": "de", "restructure": True},
        )
        self.assertNotIn("mindmap_ai", base.build_payloads(self.room)["participant"]["question"])


class MindmapAiFixRoundTests(MindmapAiTestCase):
    """Review fix round 1: consistent preview reads, AI-added terms usable
    by later ops, apply/preview agreement, skipped counts."""

    def ops(self):
        return [
            {"type": "add", "ref": "n1", "parent": None, "text": "Erneuerbare"},
            {"type": "move", "node": self.wind, "parent": "n1"},
            {"type": "rename", "node": self.energy, "text": "Energie"},
        ]

    def _preview_with_change_between_reads(self, change):
        body = self.optimize(self.ops()).json()
        real = mindmap.build_tree

        def racing_build_tree(*args, **kwargs):
            change()
            return real(*args, **kwargs)

        with patch("live.mindmap.build_tree", side_effect=racing_build_tree):
            return self.post("ai-preview", {"proposal": body["proposal"], "selected": [0, 1, 2]})

    def test_preview_survives_term_added_between_reads(self):
        def add():
            node = MindmapNode.objects.create(
                run=self.run, question=self.mq, text="Neu", text_key="neu"
            )
            MindmapContribution.objects.create(
                node=node, token=ParticipantToken.objects.get(key=self.t1)
            )

        response = self._preview_with_change_between_reads(add)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["active"], [0, 1, 2])

    def test_preview_survives_term_withdrawn_between_reads(self):
        def withdraw():
            MindmapNode.objects.filter(pk=self.solar).delete()

        response = self._preview_with_change_between_reads(withdraw)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIsNone(self.preview_node(response.json()["preview"], "Solar"))

    def test_ai_added_terms_stay_usable_by_later_ops(self):
        ops = [
            {"type": "add", "ref": "n1", "parent": None, "text": "Erneuerbare"},
            {"type": "add", "ref": "n2", "parent": None, "text": "Energiequellen"},
            {"type": "move", "node": "n1", "parent": "n2"},
            {"type": "move", "node": self.wind, "parent": "n1"},
            {"type": "move", "node": self.speicher, "parent": "n2"},  # fixed: drops
        ]
        result = self.simulate(ops)
        self.assertEqual([op["index"] for op in result["ops"]], [0, 1, 2, 3])
        self.assertEqual(result["dropped"], 1)
        self.assertEqual(result["ops"][2]["node"], "n1")
        self.assertEqual(result["ops"][3]["requires"], [0])
        sources = self.preview_node(result["preview"], "Energiequellen")
        self.assertEqual([c["text"] for c in sources["children"]], ["Erneuerbare"])

        before = self.shape()
        body = self.optimize(ops).json()
        result = self.post("ai-apply", {"proposal": body["proposal"], "selected": [0, 1, 2, 3]}).json()
        self.assertEqual((result["applied"], result["skipped"]), (4, 0))
        n1 = MindmapNode.objects.get(run=self.run, text="Erneuerbare")
        self.assertEqual(n1.parent.text, "Energiequellen")
        self.assertEqual(MindmapNode.objects.get(pk=self.wind).parent_id, n1.pk)
        self.assertEqual(self.post("ai-undo", {"undo": result["undo"]}).status_code, 200)
        self.assertEqual(self.shape(), before)

    def test_requires_is_transitive(self):
        result = self.simulate([
            {"type": "add", "ref": "n1", "parent": None, "text": "Erneuerbare"},
            {"type": "add", "ref": "n2", "parent": "n1", "text": "Wetter"},
            {"type": "move", "node": self.wind, "parent": "n2"},
        ])
        self.assertEqual([op["requires"] for op in result["ops"]], [[], [0], [0, 1]])

    def test_add_of_term_that_appeared_meanwhile_is_not_skipped(self):
        body = self.optimize(self.ops()).json()
        existing = self.owner_mod("add", parent=None, text="Erneuerbare").json()["node_id"]
        result = self.post("ai-apply", {"proposal": body["proposal"], "selected": [0, 1, 2]}).json()
        self.assertEqual((result["applied"], result["skipped"]), (2, 0))
        self.assertEqual([item["type"] for item in result["undo"]], ["move", "rename"])
        self.assertEqual(MindmapNode.objects.get(pk=self.wind).parent_id, existing)

    def test_apply_ignores_ops_the_full_simulation_dropped(self):
        ops = [
            {"type": "add", "ref": "n1", "parent": None, "text": "Solar"},  # exists → alias
            {"type": "merge", "source": self.speicher, "target": self.wind},  # fixed: drops
        ]
        body = self.optimize(ops).json()
        self.assertEqual(body["ops"], [])
        result = self.post("ai-apply", {"proposal": body["proposal"], "selected": [1]}).json()
        self.assertEqual((result["applied"], result["skipped"]), (0, 1))
        self.assertTrue(MindmapNode.objects.filter(pk=self.speicher).exists())

    def test_dropped_counts_entries_beyond_the_cap(self):
        ops = [{"type": "explode"}] * (mindmap.AI_OPS_MAX + 5)
        self.assertEqual(self.optimize(ops).json()["dropped"], mindmap.AI_OPS_MAX + 5)
