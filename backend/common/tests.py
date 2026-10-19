# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

import os
import subprocess
import sys
from unittest.mock import MagicMock, patch
from urllib import error

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import translation

from .markdown import render_markdown
from .models import Page, SiteConfig

User = get_user_model()

def _mock_response(body):
    """A urlopen() context manager whose .read() yields the given JSON body."""
    cm = MagicMock()
    cm.__enter__.return_value.read.return_value = body.encode("utf-8")
    return cm


class PublicSiteTests(TestCase):
    """Branding, footer pages, page detail and the data registry are public."""

    def test_seeded_legal_pages_are_drafts(self):
        # The seed migration creates them unpublished, so not in the footer.
        self.assertTrue(Page.objects.filter(slug="impressum").exists())
        self.assertTrue(Page.objects.filter(slug="datenschutz").exists())
        footer = self.client.get("/api/pages/").json()
        self.assertEqual(footer, [])

    def test_published_page_shows_in_footer_and_detail(self):
        # Outside a request, the active language is LANGUAGE_CODE ("en"), not
        # the content-canonical MODELTRANSLATION_DEFAULT_LANGUAGE ("de") —
        # override so this fixture's title/body land in the _de columns like
        # real authored content would (#33 MR2).
        with translation.override("de"):
            Page.objects.create(slug="ueber-uns", title="Über uns", body="# Hallo")
        footer = self.client.get("/api/pages/").json()
        self.assertEqual([p["slug"] for p in footer], ["ueber-uns"])
        # title/body are {"de", "en"} maps (#33 MR2), resolved client-side.
        self.assertEqual(footer[0]["title"], {"de": "Über uns", "en": ""})
        detail = self.client.get("/api/pages/ueber-uns/").json()
        self.assertEqual(detail["title"], {"de": "Über uns", "en": ""})
        self.assertEqual(detail["body"], {"de": "# Hallo", "en": ""})

    def test_unpublished_page_detail_404(self):
        Page.objects.create(slug="entwurf", title="Entwurf", is_published=False)
        self.assertEqual(self.client.get("/api/pages/entwurf/").status_code, 404)

    def test_site_returns_landing_and_logo(self):
        SiteConfig.load()  # ensure singleton
        payload = self.client.get("/api/site/").json()
        self.assertIn("landing_text", payload)
        # landing_text/closing_info are {"de", "en"} maps (#33 MR2).
        self.assertEqual(payload["landing_text"], {"de": "", "en": ""})
        self.assertIsNone(payload["logo"])

    def test_data_collection_registry(self):
        payload = self.client.get("/api/data-collection/").json()
        self.assertTrue(len(payload["collected"]) >= 1)
        self.assertIn("category", payload["collected"][0])
        self.assertTrue(len(payload["not_collected"]) >= 1)


class MarkdownRenderTests(TestCase):
    """Server-side Markdown for the participant closing screen (#24)."""

    def test_links_and_images_survive_scripts_stripped(self):
        html = render_markdown(
            "**Hallo** [Link](https://e.com) ![Bild](https://e.com/i.png)\n\n"
            "<script>alert(1)</script>"
        )
        self.assertIn("<strong>Hallo</strong>", html)
        self.assertIn('<img', html)
        self.assertIn('href="https://e.com"', html)
        # Shared allowlist (#49) forces rel="noopener" only (not "noopener
        # noreferrer" as the old standalone markdown allowlist did).
        self.assertIn('rel="noopener"', html)
        self.assertNotIn("<script", html)

    def test_empty_is_empty(self):
        self.assertEqual(render_markdown(""), "")


class ManageSiteTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="chef", is_staff=True)
        self.plain = User.objects.create_user(username="hans")

    def test_manage_requires_staff(self):
        self.assertEqual(self.client.get("/api/manage/site/").status_code, 403)
        self.client.force_login(self.plain)
        self.assertEqual(self.client.get("/api/manage/site/").status_code, 403)
        self.client.force_login(self.admin)
        self.assertEqual(self.client.get("/api/manage/site/").status_code, 200)

    def test_admin_edits_landing_text(self):
        self.client.force_login(self.admin)
        # A plain (legacy) string is written to the canonical language only.
        response = self.client.put(
            "/api/manage/site/", {"landing_text": "Willkommen!"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SiteConfig.load().landing_text_de, "Willkommen!")
        self.assertEqual(response.json()["landing_text"], {"de": "Willkommen!", "en": ""})

    def test_beta_label_defaults_off_and_public_exposes_it(self):
        public = self.client.get("/api/site/").json()
        self.assertIs(public["beta_label_enabled"], False)
        self.assertEqual(public["beta_notice"], {"de": "", "en": ""})

    def test_admin_enables_beta_label_with_bilingual_notice(self):
        self.client.force_login(self.admin)
        response = self.client.put(
            "/api/manage/site/",
            {
                "beta_label_enabled": True,
                "beta_notice": {"de": "  Testbetrieb.  ", "en": "Trial operation."},
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        config = SiteConfig.load()
        self.assertTrue(config.beta_label_enabled)
        self.assertEqual(config.beta_notice_de, "Testbetrieb.")
        self.assertEqual(config.beta_notice_en, "Trial operation.")
        self.client.logout()
        public = self.client.get("/api/site/").json()
        self.assertIs(public["beta_label_enabled"], True)
        self.assertEqual(public["beta_notice"], {"de": "Testbetrieb.", "en": "Trial operation."})

    def test_beta_notice_is_plain_text(self):
        self.client.force_login(self.admin)
        self.client.put(
            "/api/manage/site/",
            {"beta_notice": {"de": "<b>Test</b><script>x()</script>", "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(SiteConfig.load().beta_notice_de, "Testx()")

    def test_beta_label_requires_staff_to_change(self):
        self.client.force_login(self.plain)
        response = self.client.put(
            "/api/manage/site/", {"beta_label_enabled": True}, content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertFalse(SiteConfig.load().beta_label_enabled)

    def test_admin_edits_ai_notice_bilingually_and_public_reads_it(self):
        self.client.force_login(self.admin)
        response = self.client.put(
            "/api/manage/site/",
            {
                "ai_notice": {"de": "Externes Modell.", "en": "External model."},
                "ai_notice_url": "https://uni.example/datenschutz",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        config = SiteConfig.load()
        self.assertEqual(config.ai_notice_de, "Externes Modell.")
        self.assertEqual(config.ai_notice_en, "External model.")
        self.assertEqual(config.ai_notice_url, "https://uni.example/datenschutz")
        # The public site endpoint exposes it (the SPA reads it there).
        self.client.logout()
        public = self.client.get("/api/site/").json()
        self.assertEqual(public["ai_notice"], {"de": "Externes Modell.", "en": "External model."})
        self.assertEqual(public["ai_notice_url"], "https://uni.example/datenschutz")

    def test_self_check_ai_per_minute_defaults_and_roundtrips(self):
        self.assertEqual(SiteConfig.load().self_check_ai_per_minute, 30)
        self.client.force_login(self.admin)
        response = self.client.put(
            "/api/manage/site/",
            {"self_check_ai_per_minute": 0},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["self_check_ai_per_minute"], 0)
        self.assertEqual(SiteConfig.load().self_check_ai_per_minute, 0)

    def test_ai_notice_empty_by_default(self):
        self.assertEqual(self.client.get("/api/site/").json()["ai_notice"], {"de": "", "en": ""})

    def test_ai_notice_can_link_an_internal_page_by_slug(self):
        Page.objects.get_or_create(slug="ds-eigen", defaults={"title": "Datenschutz"})
        self.client.force_login(self.admin)
        response = self.client.put(
            "/api/manage/site/",
            {"ai_notice_page": "ds-eigen"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SiteConfig.load().ai_notice_page.slug, "ds-eigen")
        # Exposed as the slug on the public endpoint (the banner links to it).
        self.assertEqual(self.client.get("/api/site/").json()["ai_notice_page"], "ds-eigen")

    def test_ai_notice_page_null_by_default(self):
        self.assertIsNone(self.client.get("/api/site/").json()["ai_notice_page"])

    def test_admin_edits_landing_text_via_map(self):
        self.client.force_login(self.admin)
        response = self.client.put(
            "/api/manage/site/",
            {"landing_text": {"de": "Willkommen!", "en": "Welcome!"}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        config = SiteConfig.load()
        self.assertEqual(config.landing_text_de, "Willkommen!")
        self.assertEqual(config.landing_text_en, "Welcome!")
        self.assertEqual(
            response.json()["landing_text"], {"de": "Willkommen!", "en": "Welcome!"}
        )

    def test_admin_edits_closing_info(self):
        self.client.force_login(self.admin)
        response = self.client.put(
            "/api/manage/site/",
            {"landing_text": "Hi", "closing_info": "# Danke\n[Feedback](https://e.com)"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("Danke", SiteConfig.load().closing_info_de)

    def test_admin_edits_landing_text_only_leaves_closing_info_untouched(self):
        self.client.force_login(self.admin)
        self.client.put(
            "/api/manage/site/",
            {"landing_text": "Hi", "closing_info": "Bleib"},
            content_type="application/json",
        )
        response = self.client.put(
            "/api/manage/site/", {"landing_text": "Neu"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SiteConfig.load().closing_info_de, "Bleib")

    def test_admin_page_crud_and_reorder(self):
        self.client.force_login(self.admin)
        a = self.client.post(
            "/api/manage/pages/", {"slug": "a", "title": "A"},
            content_type="application/json",
        ).json()
        b = self.client.post(
            "/api/manage/pages/", {"slug": "b", "title": "B"},
            content_type="application/json",
        ).json()
        # New pages append to the end.
        self.assertLess(a["footer_order"], b["footer_order"])
        # Reorder swaps them.
        self.client.post(
            "/api/manage/pages/reorder/", {"order": [b["id"], a["id"]]},
            content_type="application/json",
        )
        self.assertEqual(Page.objects.get(pk=b["id"]).footer_order, 0)
        self.assertEqual(Page.objects.get(pk=a["id"]).footer_order, 1)

    def test_plain_user_cannot_create_page(self):
        self.client.force_login(self.plain)
        response = self.client.post(
            "/api/manage/pages/", {"slug": "x", "title": "X"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_landing_text_html_sanitized_on_write(self):
        # The editor now sends HTML (#49); validate_landing_text must run
        # it through the shared allowlist, stripping <script>.
        self.client.force_login(self.admin)
        response = self.client.put(
            "/api/manage/site/",
            {"landing_text": {"de": '<p>hi<script>x()</script></p>', "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SiteConfig.load().landing_text_de, "<p>hi</p>")

    def test_page_body_html_sanitized_on_write(self):
        # h1 is not in the shared allowlist and gets unwrapped to text (see
        # HtmlSanitizeTests.test_allows_headings_h2_h3_but_drops_h1); h2 survives.
        self.client.force_login(self.admin)
        response = self.client.post(
            "/api/manage/pages/",
            {"slug": "x", "title": "T", "body": {"de": "<h1>no</h1><h2>yes</h2>", "en": ""}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        page = Page.objects.get(slug="x")
        self.assertNotIn("<h1", page.body_de)
        self.assertIn("<h2>yes</h2>", page.body_de)


class DocumentExtractionTests(TestCase):
    """Text extraction + format dispatch for the document AI feature."""

    def test_pptx_extraction(self):
        import io

        from pptx import Presentation
        from pptx.util import Inches

        from common.documents import extract_text

        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
        box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
        box.text_frame.text = "Photosynthese Grundlagen"
        buf = io.BytesIO()
        prs.save(buf)
        buf.seek(0)
        self.assertIn("Photosynthese", extract_text(buf, "folien.pptx"))

    def test_unsupported_extension_raises(self):
        import io

        from common.documents import DocumentTextError, extract_text

        with self.assertRaises(DocumentTextError):
            extract_text(io.BytesIO(b"plain"), "notes.txt")

    def test_empty_document_raises(self):
        import io

        from pptx import Presentation

        from common.documents import DocumentTextError, extract_text

        prs = Presentation()  # no slides, no text
        buf = io.BytesIO()
        prs.save(buf)
        buf.seek(0)
        with self.assertRaises(DocumentTextError):
            extract_text(buf, "leer.pptx")

    def test_extract_document_returns_text_and_slide_count(self):
        import io

        from pptx import Presentation
        from pptx.util import Inches

        from common.documents import extract_document

        prs = Presentation()
        for i in range(3):
            slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
            box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
            box.text_frame.text = f"Folie {i} Inhalt"
        buf = io.BytesIO()
        prs.save(buf)
        buf.seek(0)
        text, pages = extract_document(buf, "folien.pptx")
        self.assertIn("Folie 1", text)
        self.assertEqual(pages, 3)

    def test_extract_text_still_returns_only_text(self):
        import io

        from pptx import Presentation
        from pptx.util import Inches

        from common.documents import extract_text

        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
        box.text_frame.text = "Nur Text"
        buf = io.BytesIO()
        prs.save(buf)
        buf.seek(0)
        result = extract_text(buf, "folien.pptx")
        self.assertIsInstance(result, str)
        self.assertIn("Nur Text", result)


LT_ON = {"CONTENT_TRANSLATION_PROVIDER": "libretranslate", "LIBRETRANSLATE_URL": "http://lt"}
LT_OFF = {"CONTENT_TRANSLATION_PROVIDER": "none", "LIBRETRANSLATE_URL": ""}


class TranslateEndpointTests(TestCase):
    """POST /api/translate/ (#33 MR2)."""

    def setUp(self):
        self.user = User.objects.create_user(username="frank")

    def test_unauthenticated_forbidden(self):
        response = self.client.post(
            "/api/translate/",
            {"text": "Hallo", "source": "de", "target": "en"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    @override_settings(**LT_OFF)
    def test_disabled_returns_503(self):
        self.client.force_login(self.user)
        response = self.client.post(
            "/api/translate/",
            {"text": "Hallo", "source": "de", "target": "en"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 503)

    @override_settings(**LT_ON)
    def test_success_returns_translated_text(self):
        self.client.force_login(self.user)
        body = '{"translatedText": "Hello"}'
        with patch(
            "basicbar_integrations.translation_service.request.urlopen",
            return_value=_mock_response(body),
        ):
            response = self.client.post(
                "/api/translate/",
                {"text": "Hallo", "source": "de", "target": "en"},
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"translated": "Hello"})

    @override_settings(**LT_ON)
    def test_upstream_error_returns_502_not_stacktrace(self):
        self.client.force_login(self.user)
        with patch(
            "basicbar_integrations.translation_service.request.urlopen",
            side_effect=error.URLError("boom"),
        ):
            response = self.client.post(
                "/api/translate/",
                {"text": "Hallo", "source": "de", "target": "en"},
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 502)
        self.assertIn("detail", response.json())

    @override_settings(**LT_ON)
    def test_html_result_is_sanitized(self):
        self.client.force_login(self.user)
        body = '{"translatedText": "<p>Hi</p><script>alert(1)</script>"}'
        with patch(
            "basicbar_integrations.translation_service.request.urlopen",
            return_value=_mock_response(body),
        ):
            response = self.client.post(
                "/api/translate/",
                {"text": "<p>Hallo</p>", "source": "de", "target": "en", "format": "html"},
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 200)
        translated = response.json()["translated"]
        self.assertIn("<p>Hi</p>", translated)
        self.assertNotIn("<script", translated)

    @override_settings(**LT_ON)
    def test_unknown_language_rejected(self):
        self.client.force_login(self.user)
        response = self.client.post(
            "/api/translate/",
            {"text": "Hallo", "source": "de", "target": "fr"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    @override_settings(**LT_ON)
    def test_same_language_returns_text_unchanged(self):
        self.client.force_login(self.user)
        # No urlopen mock needed — translate() short-circuits before any call.
        response = self.client.post(
            "/api/translate/",
            {"text": "Hallo", "source": "de", "target": "de"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"translated": "Hallo"})

    @override_settings(**LT_ON)
    def test_blank_text_returns_unchanged(self):
        self.client.force_login(self.user)
        response = self.client.post(
            "/api/translate/",
            {"text": "", "source": "de", "target": "en"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"translated": ""})


class RenderMarkdownAllowlistTests(TestCase):
    def test_markdown_link_gets_rel_noopener(self):
        out = render_markdown("[x](https://example.org)")
        self.assertIn('rel="noopener"', out)
        self.assertIn('href="https://example.org"', out)

    def test_markdown_heading_normalizes_to_allowed_subset(self):
        # '#' -> <h1>, which is not in the shared allowlist -> unwrapped to text.
        out = render_markdown("# Title\n\nBody")
        self.assertNotIn("<h1", out)
        self.assertIn("Title", out)

    def test_markdown_list_survives(self):
        out = render_markdown("- a\n- b")
        self.assertIn("<ul>", out)
        self.assertIn("<li>a</li>", out)

    def test_markdown_empty_returns_empty(self):
        self.assertEqual(render_markdown(""), "")


class StatsTotalsTests(TestCase):
    """common.stats.totals() — current counts across the domain models."""

    def test_totals_counts(self):
        from basicbar_lti.models import LtiPlatform
        from lti.models import LtiContextLink
        from live.models import ParticipantToken, Run, Vote
        from rooms.models import Question, QuestionSet, Room

        from common import stats

        lti_room = Room.objects.create(title="LTI room")
        plain_room = Room.objects.create(title="Plain room")

        platform = LtiPlatform.objects.create(
            name="LMS", issuer="https://lms.example.org", client_id="c",
            auth_login_url="https://lms.example.org/auth",
            auth_token_url="https://lms.example.org/token",
            key_set={"keys": []}, deployment_ids=["d1"],
        )
        LtiContextLink.objects.create(platform=platform, context_id="ctx1", room=lti_room)

        User.objects.create_user(username="lecturer")

        live_set = QuestionSet.objects.create(
            room=lti_room, title="Live set", type=QuestionSet.SetType.LIVE_POLL
        )
        # A SECOND live_poll set + an extra single_choice question + a second
        # live_poll run, so the per-type/kind counts are > 1. This guards
        # against the Meta.ordering GROUP BY trap (which collapses every group
        # to a count of 1) — a 1-per-group seed would not catch it.
        live_set_2 = QuestionSet.objects.create(
            room=lti_room, title="Live set 2", type=QuestionSet.SetType.LIVE_POLL
        )
        QuestionSet.objects.create(
            room=plain_room, title="Self-paced set", type=QuestionSet.SetType.SELF_PACED
        )

        questions = {}
        for kind in Question.Kind.values:
            questions[kind] = Question.objects.create(
                question_set=live_set, kind=kind, text=f"Question ({kind})"
            )
        Question.objects.create(
            question_set=live_set, kind=Question.Kind.SINGLE_CHOICE, text="Second SC"
        )

        run = Run.objects.create(question_set=live_set)
        Run.objects.create(question_set=live_set_2)  # second live_poll run

        # Vote has no uniqueness constraint (live.0006 removed it — recording
        # viewers may vote on the same question twice), so the seed must make
        # the distinct-vs-raw distinction actually matter:
        #  - token_a votes twice (two different questions) -> counted ONCE
        #    as a participant, but contributes two rows to questions_run.
        #  - token_b and token_c both vote on the SAME question -> that
        #    (run, question) pair is counted ONCE in questions_run, but both
        #    tokens count towards participants.
        token_a = ParticipantToken.objects.create(room=lti_room)
        token_b = ParticipantToken.objects.create(room=lti_room)
        token_c = ParticipantToken.objects.create(room=lti_room)

        Vote.objects.create(
            run=run, question=questions[Question.Kind.SINGLE_CHOICE], token=token_a
        )
        Vote.objects.create(
            run=run, question=questions[Question.Kind.MULTIPLE_CHOICE], token=token_a
        )
        Vote.objects.create(
            run=run, question=questions[Question.Kind.WORD_CLOUD], token=token_b
        )
        Vote.objects.create(
            run=run, question=questions[Question.Kind.WORD_CLOUD], token=token_c
        )

        # 4 raw votes; 3 distinct tokens; 3 distinct (run, question) pairs —
        # both distinct expectations below are strictly less than the raw
        # vote count, so a non-distinct implementation would fail here.
        self.assertEqual(Vote.objects.count(), 4)

        t = stats.totals()
        self.assertEqual(t["rooms"], 2)
        self.assertEqual(t["rooms_lti"], 1)
        self.assertEqual(t["users"], 1)
        self.assertEqual(t["sets_by_type"]["live_poll"], 2)
        self.assertEqual(t["sets_by_type"]["self_paced"], 1)
        self.assertEqual(t["sets_by_type"]["self_check"], 0)
        self.assertEqual(set(t["questions_by_kind"]), set(Question.Kind.values))
        self.assertEqual(t["questions_by_kind"]["single_choice"], 2)
        self.assertEqual(t["questions_by_kind"]["word_cloud"], 1)
        self.assertEqual(t["runs_by_type"]["live_poll"], 2)
        self.assertEqual(t["participants"], 3)
        self.assertEqual(t["questions_run"], 3)

    def test_example_rooms_excluded_from_usage(self):
        """Seeded example results (finished runs with invented votes) are not
        real usage — neither in totals() nor in daily()."""
        import datetime

        from django.utils import timezone

        from common import stats
        from live.models import Run, Vote
        from rooms.onboarding import seed_example_room

        seed_example_room(User.objects.create_user(username="newbie"))
        # Guard: the seeder really created runs with votes to exclude.
        self.assertGreater(Run.objects.count(), 0)
        self.assertGreater(Vote.objects.count(), 0)

        t = stats.totals()
        self.assertEqual(t["participants"], 0)
        self.assertEqual(t["questions_run"], 0)
        self.assertEqual(sum(t["runs_by_type"].values()), 0)

        d = stats.daily(timezone.localdate() - datetime.timedelta(days=14))
        self.assertTrue(all(e["n"] == 0 for e in d["participants"]))
        self.assertTrue(all(e["n"] == 0 for e in d["questions_run"]))
        self.assertTrue(all(
            v == 0 for e in d["runs_by_type"] for k, v in e.items() if k != "date"
        ))


class StatsDailyTests(TestCase):
    """common.stats.daily(since) — dense per-day time series."""

    def test_daily_rooms_bucketed_and_dense(self):
        import datetime

        from django.utils import timezone

        from rooms.models import Room

        from common import stats

        Room.objects.create(title="Room A")
        Room.objects.create(title="Room B")

        since = timezone.localdate() - datetime.timedelta(days=6)
        d = stats.daily(since)

        self.assertEqual(len(d["rooms"]), 7)
        self.assertEqual(d["rooms"][-1]["n"], 2)
        self.assertTrue(all("date" in row for row in d["rooms"]))
        self.assertEqual(d["rooms"][-1]["date"], timezone.localdate().isoformat())

    def test_daily_all_series_dense_and_correct_for_today(self):
        import datetime

        from django.utils import timezone

        from accounts.models import DailyModeSession
        from live.models import ParticipantToken, Run, Vote
        from rooms.models import Question, QuestionSet, Room

        from common import stats

        room = Room.objects.create(title="Room")
        live_set = QuestionSet.objects.create(
            room=room, title="Live set", type=QuestionSet.SetType.LIVE_POLL
        )
        self_paced_set = QuestionSet.objects.create(
            room=room, title="Self-paced set", type=QuestionSet.SetType.SELF_PACED
        )

        q1 = Question.objects.create(
            question_set=live_set, kind=Question.Kind.SINGLE_CHOICE, text="Q1"
        )
        q2 = Question.objects.create(
            question_set=live_set, kind=Question.Kind.MULTIPLE_CHOICE, text="Q2"
        )
        q3 = Question.objects.create(
            question_set=live_set, kind=Question.Kind.WORD_CLOUD, text="Q3"
        )

        run_live = Run.objects.create(question_set=live_set)
        Run.objects.create(question_set=self_paced_set)  # bumps runs_by_type only

        # Same distinct-vs-raw scenario as StatsTotalsTests, seeded "today":
        # token_a votes twice (two questions) -> 1 participant, 2 vote rows;
        # token_b/token_c both vote on q3 -> 1 (run, question) pair, 2 tokens.
        token_a = ParticipantToken.objects.create(room=room)
        token_b = ParticipantToken.objects.create(room=room)
        token_c = ParticipantToken.objects.create(room=room)
        Vote.objects.create(run=run_live, question=q1, token=token_a)
        Vote.objects.create(run=run_live, question=q2, token=token_a)
        Vote.objects.create(run=run_live, question=q3, token=token_b)
        Vote.objects.create(run=run_live, question=q3, token=token_c)
        self.assertEqual(Vote.objects.count(), 4)  # raw > both distinct counts below

        today = timezone.localdate()
        DailyModeSession.objects.create(session_hash="s1", date=today, mode="easy")
        DailyModeSession.objects.create(session_hash="s2", date=today, mode="easy")
        DailyModeSession.objects.create(session_hash="s3", date=today, mode="pro")

        since = today - datetime.timedelta(days=6)
        d = stats.daily(since)

        for key in ("participants", "questions_run", "runs_by_type", "sessions_by_mode"):
            self.assertEqual(len(d[key]), 7, key)
            self.assertEqual(d[key][-1]["date"], today.isoformat(), key)

        self.assertEqual(d["participants"][-1]["n"], 3)
        self.assertEqual(d["questions_run"][-1]["n"], 3)
        self.assertEqual(d["runs_by_type"][-1]["live_poll"], 1)
        self.assertEqual(d["runs_by_type"][-1]["self_paced"], 1)
        self.assertEqual(d["runs_by_type"][-1]["self_check"], 0)
        self.assertEqual(d["sessions_by_mode"][-1]["easy"], 2)
        self.assertEqual(d["sessions_by_mode"][-1]["pro"], 1)


class MetricsEndpointTests(TestCase):
    """GET /metrics — token-guarded Prometheus text exporter (top-level, not /api/)."""

    def test_404_without_token_configured(self):
        with override_settings(METRICS_TOKEN=""):
            self.assertEqual(self.client.get("/metrics").status_code, 404)

    def test_401_with_wrong_token(self):
        with override_settings(METRICS_TOKEN="secret"):
            r = self.client.get("/metrics", HTTP_AUTHORIZATION="Bearer nope")
            self.assertEqual(r.status_code, 401)

    def test_200_and_format_with_token(self):
        with override_settings(METRICS_TOKEN="secret"):
            r = self.client.get("/metrics", HTTP_AUTHORIZATION="Bearer secret")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/plain", r["Content-Type"])
        body = r.content.decode()
        self.assertIn("# TYPE abstimmbar_rooms gauge", body)
        self.assertIn('abstimmbar_question_sets{type="live_poll"}', body)

    def test_label_value_escaping(self):
        # Sanity check on the labeled-gauge path: quotes/backslashes in a
        # label value must not break the exposition format.
        with override_settings(METRICS_TOKEN="secret"):
            r = self.client.get("/metrics", HTTP_AUTHORIZATION="Bearer secret")
        body = r.content.decode()
        self.assertIn('abstimmbar_sessions_today{mode="easy"}', body)
        self.assertIn('abstimmbar_sessions_today{mode="pro"}', body)


class AdminStatsEndpointTests(TestCase):
    """GET /api/admin/stats/ — staff-only wrapper around common.stats."""

    def test_requires_staff(self):
        r = self.client.get("/api/admin/stats/")
        self.assertIn(r.status_code, (401, 403))

        user = User.objects.create_user(username="plain")
        self.client.force_login(user)
        self.assertEqual(self.client.get("/api/admin/stats/").status_code, 403)

    def test_staff_gets_totals_and_daily(self):
        staff = User.objects.create_user(username="chef", is_staff=True)
        self.client.force_login(staff)
        body = self.client.get("/api/admin/stats/?days=7").json()
        self.assertIn("totals", body)
        self.assertIn("daily", body)
        self.assertEqual(len(body["daily"]["rooms"]), 7)
        self.assertEqual(body["days"], 7)

    def test_days_clamped_to_max(self):
        staff = User.objects.create_user(username="chef2", is_staff=True)
        self.client.force_login(staff)
        body = self.client.get("/api/admin/stats/?days=9999").json()
        self.assertEqual(body["days"], 365)

    def test_invalid_days_falls_back_to_default(self):
        staff = User.objects.create_user(username="chef3", is_staff=True)
        self.client.force_login(staff)
        body = self.client.get("/api/admin/stats/?days=abc").json()
        self.assertEqual(body["days"], 30)

    def test_explicit_from_to_range(self):
        import datetime
        from django.utils import timezone
        staff = User.objects.create_user(username="chef4", is_staff=True)
        self.client.force_login(staff)
        to = timezone.localdate()
        frm = to - datetime.timedelta(days=9)
        body = self.client.get(
            f"/api/admin/stats/?from={frm.isoformat()}&to={to.isoformat()}"
        ).json()
        self.assertEqual(body["from"], frm.isoformat())
        self.assertEqual(body["to"], to.isoformat())
        self.assertEqual(body["days"], 10)
        self.assertEqual(len(body["daily"]["rooms"]), 10)

    def test_totals_sessions_by_mode(self):
        from accounts.models import DailyModeSession
        from django.utils import timezone
        from common import stats
        today = timezone.localdate()
        DailyModeSession.objects.create(session_hash="a", date=today, mode="easy")
        DailyModeSession.objects.create(session_hash="b", date=today, mode="pro")
        DailyModeSession.objects.create(session_hash="c", date=today, mode="easy")
        self.assertEqual(stats.totals()["sessions_by_mode"], {"easy": 2, "pro": 1})


class TourStatsTests(TestCase):
    """Guided-tour usage in common.stats and the Prometheus export."""

    def setUp(self):
        from django.utils import timezone

        from accounts.models import TourDailyCount

        today = timezone.localdate()

        def make(**bucket):
            TourDailyCount.objects.create(date=today, n=1, **bucket)

        make(kind="started", mode="easy", source="welcome")
        make(kind="started", mode="easy", source="help")
        make(kind="started", mode="pro", source="help")
        make(kind="completed", mode="easy")
        make(kind="aborted", mode="pro", step="q.likert")
        make(kind="aborted", mode="easy", step="q.likert")
        make(kind="aborted", mode="easy", step="set.editor")
        User.objects.create_user(username="seen", onboarding_tour_seen=True)
        User.objects.create_user(username="unseen")

    def test_totals(self):
        from common import stats

        tour = stats.totals()["tour"]
        self.assertEqual(tour["started"], {"easy": 2, "pro": 1})
        self.assertEqual(tour["completed"], {"easy": 1, "pro": 0})
        self.assertEqual(tour["aborted"], {"easy": 2, "pro": 1})
        self.assertEqual(tour["by_source"], {"welcome": 1, "help": 2})
        self.assertEqual(
            tour["aborted_at"], [{"step": "q.likert", "n": 2}, {"step": "set.editor", "n": 1}]
        )
        self.assertEqual(tour["users_seen"], 1)

    def test_daily(self):
        import datetime

        from django.utils import timezone

        from common import stats

        since = timezone.localdate() - datetime.timedelta(days=2)
        series = stats.daily(since)["tour"]
        self.assertEqual(len(series), 3)
        self.assertEqual(series[-1], {"date": timezone.localdate().isoformat(), "started": 3, "completed": 1})
        self.assertEqual(series[0]["started"], 0)

    def test_prometheus(self):
        with override_settings(METRICS_TOKEN="secret"):
            body = self.client.get("/metrics", HTTP_AUTHORIZATION="Bearer secret").content.decode()
        self.assertIn('abstimmbar_tour_events{kind="started",mode="easy"} 2', body)
        self.assertIn('abstimmbar_tour_events{kind="aborted",mode="pro"} 1', body)
        self.assertIn('abstimmbar_tour_starts{source="help"} 2', body)
        self.assertIn("abstimmbar_tour_users_seen 1", body)


class SecretKeyGuardTests(SimpleTestCase):
    """DJANGO_DEBUG=0 must not boot with the insecure dev SECRET_KEY."""

    def _import_settings(self, **env):
        base = {k: v for k, v in os.environ.items() if k != "DJANGO_SECRET_KEY"}
        base.update(DJANGO_SETTINGS_MODULE="config.settings", **env)
        return subprocess.run(
            [sys.executable, "-c", "import config.settings"],
            env=base,
            cwd=settings.BASE_DIR,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )

    def test_prod_without_secret_key_refuses_to_start(self):
        result = self._import_settings(DJANGO_DEBUG="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DJANGO_SECRET_KEY", result.stderr)

    def test_prod_with_secret_key_imports(self):
        result = self._import_settings(DJANGO_DEBUG="0", DJANGO_SECRET_KEY="x" * 50)
        self.assertEqual(result.returncode, 0, result.stderr)
