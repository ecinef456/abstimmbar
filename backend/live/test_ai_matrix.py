# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Matrix stage 2: AI grouping — prompt and strict reply parsing. No LLM is
called here (the prompt is only built, the reply is a literal)."""
from django.test import SimpleTestCase

from . import ai_matrix
from . import matrix as mxs
from . import tests as base
from .models import MatrixCard


class MatrixAiParseTests(SimpleTestCase):
    def parse(self, data):
        return ai_matrix.parse_reply(data)

    def test_levels(self):
        self.assertEqual(ai_matrix.LEVELS, ("spelling", "same", "similar"))

    def test_well_formed(self):
        groups, hints, malformed = self.parse({
            "groups": [{"cards": [3, 5, 3], "title": "  Wind   power ",
                        "description": "d", "reason": " same  thing "}],
            "hints": [{"cards": [1, 2], "reason": "r"}],
        })
        self.assertEqual(malformed, 0)
        self.assertEqual(groups, [{"index": 0, "cards": [3, 5], "title": "Wind power",
                                   "description": "d", "reason": "same thing"}])
        self.assertEqual(hints, [{"index": 0, "cards": [1, 2], "reason": "r"}])

    def test_garbage_reply(self):
        for data in (None, [], "x", {}, {"groups": "x", "hints": {}}):
            self.assertEqual(self.parse(data), ([], [], 0))

    def test_malformed_entries_counted(self):
        groups, hints, malformed = self.parse({
            "groups": [
                "nope",
                {"cards": [1], "title": "one card"},
                {"cards": [1, 1], "title": "same id twice"},
                {"cards": [1, "2"], "title": "string id"},
                {"cards": [1, True], "title": "bool id"},
                {"cards": [1, 2.0], "title": "float id"},
                {"cards": [1, 2]},                       # no title
                {"cards": [1, 2], "title": "   "},       # blank title
                {"cards": [1, 2], "title": 7},
                {"cards": "1,2", "title": "t"},
                {"cards": [1, 2], "title": "ok"},
            ],
            "hints": [{"cards": [1]}, {"cards": [1, "x"]}, {"cards": [4, 5]}],
        })
        self.assertEqual([g["title"] for g in groups], ["ok"])
        self.assertEqual(groups[0]["index"], 0)
        self.assertEqual([h["cards"] for h in hints], [[4, 5]])
        self.assertEqual(malformed, 12)

    def test_limits(self):
        groups, _, _ = self.parse({"groups": [{
            "cards": [1, 2], "title": "t" * 100, "description": "d" * 300,
            "reason": "r" * 300,
        }]})
        self.assertEqual(len(groups[0]["title"]), 60)
        self.assertEqual(len(groups[0]["description"]), 200)
        self.assertEqual(len(groups[0]["reason"]), 200)

    def test_optional_fields_default_empty(self):
        groups, hints, _ = self.parse({
            "groups": [{"cards": [1, 2], "title": "t", "description": 5, "reason": None}],
            "hints": [{"cards": [1, 2]}],
        })
        self.assertEqual(groups[0]["description"], "")
        self.assertEqual(groups[0]["reason"], "")
        self.assertEqual(hints[0]["reason"], "")

    def test_at_most_50_each(self):
        entry = {"cards": [1, 2], "title": "t"}
        groups, hints, malformed = self.parse(
            {"groups": [entry] * 60, "hints": [{"cards": [1, 2]}] * 55}
        )
        self.assertEqual(len(groups), 50)
        self.assertEqual(len(hints), 50)
        self.assertEqual([g["index"] for g in groups], list(range(50)))
        self.assertEqual(malformed, 15)


class MatrixAiPromptTests(base.MatrixTestCase):
    def setUp(self):
        super().setUp()
        self.configure(
            text="<p>Wo steht <b>Energie</b></p>",
            matrix_x_from_de="billig", matrix_x_to_de="teuer",
            matrix_y_from_de="langsam", matrix_y_to_de="schnell",
            matrix_x_from_en="cheap", matrix_x_to_en="expensive",
            matrix_y_from_en="slow", matrix_y_to_en="fast",
            matrix_descriptions=True, matrix_category_mode="named",
            matrix_categories=[
                {"key": "blue", "name": {"de": "Idee", "en": "Idea"}},
                {"key": "red", "name": {"de": "Risiko", "en": "Risk"}},
            ],
        )
        self.wind = self.add(title="Windkraft", description="Rotoren", category="blue")
        self.wind2 = self.add(title="Windenergie", category="blue", token=self.tok2)
        self.solar = self.add(title="Solar", zone="q3", category="red")
        self.spam = self.add(title="Geheimer Spam", category="red")
        MatrixCard.objects.filter(pk=self.spam.pk).update(hidden=True)
        self.member = self.add(title="Windrad", category="blue")
        mxs.stack_card(self.run, self.xq, self.member.pk, self.wind.pk)

    def prompt(self, level="same"):
        return ai_matrix.build_prompt(self.run, self.xq, level)

    def test_user_content(self):
        _, user = self.prompt()
        self.assertIn("Wo steht Energie", user)
        for text in ("billig", "teuer", "langsam", "schnell", "Windkraft", "Rotoren",
                     "Windenergie", "Solar", "Idee", "Risiko", "Windrad"):
            self.assertIn(text, user)
        # Zone names: x part first, like the participant page.
        self.assertIn("teuer & schnell", user)
        self.assertIn("billig & langsam", user)
        self.assertIn(f'"id": {self.wind.pk}', user)
        self.assertNotIn("Geheimer Spam", user)
        # A member is context of its top, not a top of its own.
        self.assertNotIn(f'"id": {self.member.pk}', user)

    def test_descriptions_only_when_enabled(self):
        self.configure(matrix_descriptions=False)
        _, user = self.prompt()
        self.assertNotIn("Rotoren", user)
        self.assertNotIn('"description"', user)

    def test_canonical_language(self):
        from django.utils import translation

        with translation.override("en"):
            _, user = self.prompt()
        self.assertIn("teuer", user)
        self.assertNotIn("expensive", user)
        self.assertNotIn("Idea", user)

    def test_no_tokens(self):
        system, user = self.prompt()
        for token in (self.tok, self.tok2):
            self.assertNotIn(token.key, user)
            self.assertNotIn(token.key, system)
        self.assertNotIn("token", user.lower())

    def test_system_rules_and_levels(self):
        system, _ = self.prompt("spelling")
        self.assertIn('"groups"', system)
        self.assertIn('"hints"', system)
        self.assertIn("60", system)
        self.assertIn("Schreibweise", system)
        self.assertNotIn("Thema", system)
        same, _ = self.prompt("same")
        self.assertIn("Schreibweise", same)
        self.assertIn("anderen Worten", same)
        similar, _ = self.prompt("similar")
        self.assertIn("anderen Worten", similar)
        self.assertIn("Thema", similar)

    def test_unknown_level(self):
        with self.assertRaises(ValueError):
            self.prompt("wild")

    def test_card_texts_are_data(self):
        system, _ = self.prompt()
        self.assertIn("keine Anweisungen", system)

    def test_summary_cards_marked(self):
        MatrixCard.objects.filter(pk=self.wind.pk).update(summary=True)
        system, user = self.prompt()  # descriptions on (setUp)
        self.assertIn('"summary"', system)
        self.assertIn(f'"id": {self.wind.pk}, "title": "Windkraft", "zone": "q1", '
                      '"description": "Rotoren", "category": "Idee", "stack": ["Windrad"], '
                      '"summary": true', user)
        self.assertEqual(user.count('"summary": true'), 1)
