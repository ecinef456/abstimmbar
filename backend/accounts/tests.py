# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

import importlib

from django.apps import apps as django_apps
from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from rooms.models import Question, Room

User = get_user_model()


# Force the translation provider off explicitly (#33 MR2) — the dev
# container's real .env configures LibreTranslate, so without this override
# these tests would depend on out-of-band environment state.
LT_OFF = {"CONTENT_TRANSLATION_PROVIDER": "none", "LIBRETRANSLATE_URL": ""}


class WhoamiTests(TestCase):
    @override_settings(**LT_OFF)
    def test_anonymous(self):
        response = self.client.get("/api/whoami/")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["authenticated"])
        # An authoritative CSRF token is returned so the SPA can send unsafe
        # requests reliably (esp. cross-origin in dev).
        self.assertTrue(payload["csrf_token"])
        # App-specific cookie names (basicbar#22): no shared "csrftoken".
        self.assertIn("abstimmbar_csrftoken", response.cookies)
        self.assertNotIn("csrftoken", response.cookies)
        # Content-i18n config (#33 MR2): the canonical authoring language and
        # whether machine-translation drafts are available.
        self.assertEqual(
            payload["content_default_language"], settings.MODELTRANSLATION_DEFAULT_LANGUAGE
        )
        self.assertFalse(payload["content_translation_enabled"])

    @override_settings(**LT_OFF)
    def test_authenticated(self):
        user = User.objects.create_user(
            username="frank", email="frank@uni-osnabrueck.de", subject="abc-123"
        )
        self.client.force_login(user)
        payload = self.client.get("/api/whoami/").json()
        self.assertTrue(payload["authenticated"])
        self.assertEqual(payload["username"], "frank")
        self.assertEqual(payload["subject"], "abc-123")
        self.assertFalse(payload["is_staff"])
        self.assertEqual(
            payload["content_default_language"], settings.MODELTRANSLATION_DEFAULT_LANGUAGE
        )
        self.assertFalse(payload["content_translation_enabled"])
        self.assertEqual(
            payload["ai_generate_max_questions"], settings.AI_GEN_MAX_QUESTIONS
        )

    @override_settings(
        CONTENT_TRANSLATION_PROVIDER="libretranslate", LIBRETRANSLATE_URL="http://lt"
    )
    def test_content_translation_enabled_reflects_provider_config(self):
        payload = self.client.get("/api/whoami/").json()
        self.assertTrue(payload["content_translation_enabled"])


class OnboardingSeedOnWhoamiTests(TestCase):
    """First-login example room seeding (#78), guarded by User.onboarded."""

    @override_settings(**LT_OFF)
    def test_fresh_user_gets_seeded_exactly_once(self):
        user = User.objects.create_user(username="fresh")
        self.assertFalse(user.onboarded)
        self.client.force_login(user)

        self.client.get("/api/whoami/")

        user.refresh_from_db()
        self.assertTrue(user.onboarded)
        rooms = Room.objects.filter(owners=user)
        self.assertEqual(rooms.count(), 1)
        room = rooms.get()
        question_set = room.question_sets.get()
        kinds = set(question_set.questions.values_list("kind", flat=True))
        self.assertEqual(kinds, set(Question.Kind.values))

    @override_settings(**LT_OFF)
    def test_second_whoami_does_not_duplicate_the_room(self):
        user = User.objects.create_user(username="fresh2")
        self.client.force_login(user)

        self.client.get("/api/whoami/")
        self.client.get("/api/whoami/")

        self.assertEqual(Room.objects.filter(owners=user).count(), 1)

    @override_settings(**LT_OFF)
    def test_existing_user_with_onboarded_false_is_seeded_too(self):
        # Simulates an account created before #78: onboarded defaults to
        # False, so it is seeded on its next whoami just like a new user.
        existing = User.objects.create_user(username="veteran")
        self.assertFalse(existing.onboarded)
        self.client.force_login(existing)

        self.client.get("/api/whoami/")

        existing.refresh_from_db()
        self.assertTrue(existing.onboarded)
        self.assertEqual(Room.objects.filter(owners=existing).count(), 1)

    @override_settings(**LT_OFF)
    def test_already_onboarded_user_is_not_seeded_again(self):
        user = User.objects.create_user(username="done", onboarded=True)
        self.client.force_login(user)

        self.client.get("/api/whoami/")

        self.assertEqual(Room.objects.filter(owners=user).count(), 0)

    @override_settings(**LT_OFF)
    def test_anonymous_whoami_seeds_nothing(self):
        before = Room.objects.count()
        response = self.client.get("/api/whoami/")
        self.assertFalse(response.json()["authenticated"])
        self.assertEqual(Room.objects.count(), before)


class SetLanguageTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="lena", password="x"
        )

    def test_sets_supported_language(self):
        self.client.force_login(self.user)
        resp = self.client.post(
            "/api/whoami/language/",
            data={"language": "en"},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.language, "en")

    def test_rejects_unknown_language(self):
        self.client.force_login(self.user)
        resp = self.client.post(
            "/api/whoami/language/",
            data={"language": "fr"},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_requires_authentication(self):
        resp = self.client.post(
            "/api/whoami/language/",
            data={"language": "de"},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_rejects_non_dict_body(self):
        self.client.force_login(self.user)
        resp = self.client.post(
            "/api/whoami/language/",
            data="[]",
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_rejects_non_string_language_without_error(self):
        self.client.force_login(self.user)
        resp = self.client.post(
            "/api/whoami/language/",
            data={"language": 123},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)


class EasyModeTests(TestCase):
    """Per-user Easy/Pro mode preference.

    ``easy_mode`` is tri-state (None = not chosen yet). The *effective*
    value falls back to a role default when unset: non-staff start simple,
    staff start pro — but staff may explicitly opt into simple mode too
    (admins' default stays Pro, it is no longer a hard mask)."""

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="lena", password="x"
        )
        self.staff = get_user_model().objects.create_user(
            username="chef", password="x", is_staff=True
        )

    def test_effective_easy_mode_property(self):
        u = User(is_staff=False)
        u.easy_mode = None
        self.assertTrue(u.effective_easy_mode)  # non-staff default = simple
        u.is_staff = True
        self.assertFalse(u.effective_easy_mode)  # staff default = pro
        u.easy_mode = True
        self.assertTrue(u.effective_easy_mode)  # explicit wins (staff simple)
        u.easy_mode = False
        self.assertFalse(u.effective_easy_mode)
        u = User(is_staff=False)
        u.easy_mode = True
        self.assertTrue(u.effective_easy_mode)  # explicit non-staff simple
        u.easy_mode = False
        self.assertFalse(u.effective_easy_mode)  # explicit non-staff pro

    def test_whoami_reflects_effective_easy_mode_for_regular_user(self):
        self.client.force_login(self.user)
        payload = self.client.get("/api/whoami/").json()
        # The underlying field defaults to None (not chosen); non-staff
        # fall back to the simple role default, so effective easy_mode is
        # True.
        self.assertTrue(payload["easy_mode"])

    def test_whoami_effective_easy_mode_is_false_for_staff(self):
        self.client.force_login(self.staff)
        payload = self.client.get("/api/whoami/").json()
        # Staff default to Pro when they haven't made an explicit choice
        # (easy_mode is None) — this is the role default, not a hard mask:
        # staff can still opt into simple mode explicitly (see below).
        self.assertFalse(payload["easy_mode"])

    def test_whoami_non_staff_defaults_simple(self):
        u = User.objects.create_user(username="novize3")  # easy_mode default None
        self.client.force_login(u)
        self.assertTrue(self.client.get("/api/whoami/").json()["easy_mode"])

    def test_whoami_admin_defaults_pro_but_can_enable_simple(self):
        admin = User.objects.create_user(username="chef2", is_staff=True)  # easy_mode default None
        self.client.force_login(admin)
        self.assertFalse(self.client.get("/api/whoami/").json()["easy_mode"])  # default pro
        r = self.client.post(
            "/api/whoami/mode/",
            data='{"easy_mode": true}',
            content_type="application/json",
        )
        self.assertTrue(r.json()["easy_mode"])  # admin may enable simple
        admin.refresh_from_db()
        self.assertTrue(admin.easy_mode)  # stored explicitly
        self.assertTrue(self.client.get("/api/whoami/").json()["easy_mode"])

    def test_set_mode_toggles_easy_mode(self):
        self.client.force_login(self.user)
        resp = self.client.post(
            "/api/whoami/mode/",
            data={"easy_mode": False},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["easy_mode"])
        self.user.refresh_from_db()
        self.assertFalse(self.user.easy_mode)

    def test_set_mode_staff_can_enable_simple_mode(self):
        # Reversed from the old behavior (formerly
        # test_set_mode_effective_value_stays_false_for_staff, which
        # asserted the effective value stayed False for staff regardless of
        # the posted value — the old "admins can't enable simple" rule).
        # The whole point of this change is that admins MAY opt into simple
        # mode explicitly.
        self.client.force_login(self.staff)
        resp = self.client.post(
            "/api/whoami/mode/",
            data={"easy_mode": True},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["easy_mode"])
        self.staff.refresh_from_db()
        self.assertTrue(self.staff.easy_mode)
        payload = self.client.get("/api/whoami/").json()
        self.assertTrue(payload["easy_mode"])

    def test_set_mode_requires_authentication(self):
        resp = self.client.post(
            "/api/whoami/mode/",
            data={"easy_mode": False},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 403)


class EasyModeMigrationTests(TestCase):
    """Covers accounts.migrations.0003_easy_mode_nullable's data migration,
    which resets the old, for-them-unswitchable easy_mode=True default back
    to None for staff (so the role default applies again), while leaving
    non-staff choices and explicit staff opt-outs untouched."""

    def _run(self):
        mod = importlib.import_module("accounts.migrations.0003_easy_mode_nullable")
        mod.clear_stale_admin_default(django_apps, None)

    def test_stale_admin_default_reset_to_none(self):
        admin = User.objects.create_user(username="stale_admin", is_staff=True)
        # force the pre-migration stale default explicitly
        User.objects.filter(pk=admin.pk).update(easy_mode=True)
        self._run()
        admin.refresh_from_db()
        self.assertIsNone(admin.easy_mode)  # reset to role default (pro)

    def test_non_staff_choice_untouched(self):
        u = User.objects.create_user(username="ns_true")
        User.objects.filter(pk=u.pk).update(easy_mode=True)
        self._run()
        u.refresh_from_db()
        self.assertTrue(u.easy_mode)  # non-staff simple choice preserved

    def test_staff_explicit_false_untouched(self):
        a = User.objects.create_user(username="admin_pro", is_staff=True)
        User.objects.filter(pk=a.pk).update(easy_mode=False)
        self._run()
        a.refresh_from_db()
        self.assertFalse(a.easy_mode)  # staff explicit pro preserved


class DailyModeSessionTests(TestCase):
    @override_settings(**LT_OFF)
    def test_whoami_records_session_for_authenticated_user(self):
        from accounts.models import DailyModeSession
        from django.utils import timezone
        user = User.objects.create_user(username="stat", is_staff=True)  # staff → pro default
        self.client.force_login(user)
        self.client.get("/api/whoami/")
        row = DailyModeSession.objects.get()
        self.assertEqual(row.date, timezone.localdate())
        self.assertEqual(row.mode, "pro")

    @override_settings(**LT_OFF)
    def test_whoami_is_idempotent_per_session_and_day(self):
        from accounts.models import DailyModeSession
        user = User.objects.create_user(username="stat2")
        self.client.force_login(user)
        self.client.get("/api/whoami/")
        self.client.get("/api/whoami/")
        self.assertEqual(DailyModeSession.objects.count(), 1)

    @override_settings(**LT_OFF)
    def test_anonymous_whoami_records_nothing(self):
        from accounts.models import DailyModeSession
        self.client.get("/api/whoami/")
        self.assertEqual(DailyModeSession.objects.count(), 0)

    @override_settings(**LT_OFF)
    def test_mode_reflects_effective_mode(self):
        from accounts.models import DailyModeSession
        user = User.objects.create_user(username="stat3")  # non-staff → easy default
        self.client.force_login(user)
        self.client.get("/api/whoami/")
        self.assertEqual(DailyModeSession.objects.get().mode, "easy")

    @override_settings(**LT_OFF)
    def test_stores_hash_not_raw_session_key(self):
        # Privacy: the raw session key is a live credential — we store only a
        # one-way SHA-256 hash so the stats table can never re-authenticate a
        # session, while (hash, date) stays unique for the per-day count.
        import hashlib

        from accounts.models import DailyModeSession
        user = User.objects.create_user(username="stat4")
        self.client.force_login(user)
        self.client.get("/api/whoami/")
        raw_key = self.client.session.session_key
        stored = DailyModeSession.objects.get().session_hash
        self.assertNotEqual(stored, raw_key)
        self.assertEqual(stored, hashlib.sha256(raw_key.encode()).hexdigest())
        self.assertEqual(len(stored), 64)


class OidcCallbackReplayTests(TestCase):
    """A Back press right after login replays the spent code/state, which
    mozilla-django-oidc raises SuspiciousOperation for (a 400 page).
    basicbar-auth's SafeOIDCCallbackView (via basicbar_auth.urls) redirects
    to the SPA instead — pinned here because the SPA relies on it."""

    def test_replayed_callback_redirects_instead_of_erroring(self):
        # A consumed state: oidc_states present in the session but without this
        # state — exactly the state after the code was already exchanged once.
        session = self.client.session
        session["oidc_states"] = {}
        session.save()
        response = self.client.get("/oidc/callback/?code=abc&state=stale")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], settings.LOGIN_REDIRECT_URL)

    def test_callback_without_states_uses_failure_redirect(self):
        # No oidc_states at all → mozilla's own login_failure() redirect; still
        # a redirect (never a 400/error page).
        response = self.client.get("/oidc/callback/?code=abc&state=stale")
        self.assertEqual(response.status_code, 302)


class PruneModeSessionsCommandTests(TestCase):
    """The ``prune_mode_sessions`` retention command drops stats rows older
    than the cutoff so the table never grows unbounded (one row per session
    per day)."""

    def _make(self, days_ago, suffix):
        from datetime import timedelta

        from django.utils import timezone

        from accounts.models import DailyModeSession
        return DailyModeSession.objects.create(
            session_hash=f"hash-{suffix}",
            date=timezone.localdate() - timedelta(days=days_ago),
            mode="pro",
        )

    def test_deletes_rows_older_than_default_cutoff(self):
        from django.core.management import call_command

        from accounts.models import DailyModeSession
        self._make(401, "old")     # beyond default 400-day window → pruned
        self._make(399, "recent")  # inside the window → kept
        call_command("prune_mode_sessions")
        remaining = list(DailyModeSession.objects.values_list("session_hash", flat=True))
        self.assertEqual(remaining, ["hash-recent"])

    def test_boundary_row_at_cutoff_is_kept(self):
        from django.core.management import call_command

        from accounts.models import DailyModeSession
        self._make(400, "edge")  # exactly N days old → kept (strictly older is pruned)
        call_command("prune_mode_sessions")
        self.assertEqual(DailyModeSession.objects.count(), 1)

    def test_days_option_overrides_default(self):
        from django.core.management import call_command

        from accounts.models import DailyModeSession
        self._make(31, "old")
        self._make(29, "recent")
        call_command("prune_mode_sessions", days=30)
        remaining = list(DailyModeSession.objects.values_list("session_hash", flat=True))
        self.assertEqual(remaining, ["hash-recent"])


class SetTourSeenTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="tia", password="x")

    def test_defaults_false_and_reported_by_whoami(self):
        self.client.force_login(self.user)
        resp = self.client.get("/api/whoami/")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["onboarding_tour_seen"])

    def test_marks_seen_idempotently(self):
        self.client.force_login(self.user)
        for _ in range(2):
            resp = self.client.post("/api/whoami/tour-seen/", content_type="application/json")
            self.assertEqual(resp.status_code, 200)
            self.assertTrue(resp.json()["onboarding_tour_seen"])
        self.user.refresh_from_db()
        self.assertTrue(self.user.onboarding_tour_seen)

    def test_requires_authentication(self):
        resp = self.client.post("/api/whoami/tour-seen/", content_type="application/json")
        self.assertEqual(resp.status_code, 403)


class ExampleRoomTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="ex", password="x")
        self.client.force_login(self.user)

    def test_whoami_ids_after_seed(self):
        resp = self.client.get("/api/whoami/")  # first whoami seeds (#78)
        data = resp.json()
        self.assertIsNotNone(data["example_room_id"])
        self.assertIsNotNone(data["example_set_id"])
        from rooms.models import Room
        room = Room.objects.get(pk=data["example_room_id"])
        self.assertTrue(room.is_example)
        self.assertEqual(room.owner, self.user)

    def test_whoami_ids_null_when_missing_or_incomplete(self):
        from rooms.models import Question, Room
        self.client.get("/api/whoami/")
        Room.objects.filter(owner=self.user, is_example=True).delete()
        self.assertIsNone(self.client.get("/api/whoami/").json()["example_room_id"])
        # incomplete: room + set exist but the set has no questions
        room = self.client.post(
            "/api/whoami/example-room/", content_type="application/json"
        ).json()
        Question.objects.filter(question_set_id=room["example_set_id"]).delete()
        data = self.client.get("/api/whoami/").json()
        self.assertIsNone(data["example_room_id"])
        self.assertIsNone(data["example_set_id"])

    def test_restore_creates_when_missing_and_is_idempotent(self):
        from rooms.models import Room
        self.client.get("/api/whoami/")
        Room.objects.filter(owner=self.user, is_example=True).delete()
        first = self.client.post("/api/whoami/example-room/", content_type="application/json")
        self.assertEqual(first.status_code, 200)
        second = self.client.post("/api/whoami/example-room/", content_type="application/json")
        self.assertEqual(first.json(), second.json())
        self.assertEqual(Room.objects.filter(owner=self.user, is_example=True).count(), 1)
        # The restored room carries the mind map incl. its example contributions.
        from live.models import MindmapContribution
        qset = Room.objects.get(owner=self.user, is_example=True).question_sets.get()
        self.assertTrue(qset.questions.filter(kind=Question.Kind.MINDMAP).exists())
        self.assertGreaterEqual(
            MindmapContribution.objects.filter(node__run__question_set=qset).count(), 12
        )

    def test_restore_requires_auth(self):
        self.client.logout()
        resp = self.client.post("/api/whoami/example-room/", content_type="application/json")
        self.assertEqual(resp.status_code, 403)

    def test_whoami_ids_null_when_room_has_no_set(self):
        from rooms.models import QuestionSet, Room
        self.client.get("/api/whoami/")
        room = Room.objects.get(owner=self.user, is_example=True)
        QuestionSet.objects.filter(room=room).delete()
        data = self.client.get("/api/whoami/").json()
        self.assertIsNone(data["example_room_id"])
        self.assertIsNone(data["example_set_id"])

    def test_0048_backfill_flags_seeded_title_only(self):
        mod = importlib.import_module("rooms.migrations.0048_room_is_example")
        seeded = Room.objects.create(
            owner=self.user, title_de="Beispielraum – zum Ausprobieren", title_en="Example"
        )
        other = Room.objects.create(owner=self.user, title_de="Beispielraum", title_en="Other")
        Room.objects.filter(pk__in=[seeded.pk, other.pk]).update(is_example=False)
        mod.backfill(django_apps, None)
        seeded.refresh_from_db()
        other.refresh_from_db()
        self.assertTrue(seeded.is_example)
        self.assertFalse(other.is_example)


class TourEventTests(TestCase):
    """POST /api/whoami/tour-event/ — anonymous guided-tour usage, counted in
    per-day TourDailyCount buckets."""

    URL = "/api/whoami/tour-event/"

    def setUp(self):
        self.user = get_user_model().objects.create_user(username="tomas", password="x")

    def post(self, payload):
        import json

        return self.client.post(self.URL, json.dumps(payload), content_type="application/json")

    def test_requires_authentication(self):
        self.assertEqual(self.post({"kind": "started", "mode": "pro", "source": "help"}).status_code, 403)

    def test_records_start_with_source(self):
        from django.utils import timezone

        from accounts.models import TourDailyCount

        self.client.force_login(self.user)
        resp = self.post({"kind": "started", "mode": "easy", "source": "welcome"})
        self.assertEqual(resp.status_code, 201)
        row = TourDailyCount.objects.get()
        self.assertEqual(
            (row.date, row.kind, row.mode, row.source, row.step, row.n),
            (timezone.localdate(), "started", "easy", "welcome", "", 1),
        )

    def test_records_abort_with_step_and_drops_source(self):
        from accounts.models import TourDailyCount

        self.client.force_login(self.user)
        resp = self.post({"kind": "aborted", "mode": "pro", "source": "help", "step": "q.word_cloud"})
        self.assertEqual(resp.status_code, 201)
        row = TourDailyCount.objects.get()
        self.assertEqual((row.kind, row.source, row.step, row.n), ("aborted", "", "q.word_cloud", 1))

    def test_completed_drops_step(self):
        from accounts.models import TourDailyCount

        self.client.force_login(self.user)
        self.assertEqual(self.post({"kind": "completed", "mode": "pro", "step": "final"}).status_code, 201)
        row = TourDailyCount.objects.get()
        self.assertEqual((row.step, row.n), ("", 1))

    def test_same_event_twice_increments_one_bucket(self):
        from accounts.models import TourDailyCount

        self.client.force_login(self.user)
        for _ in range(2):
            self.assertEqual(self.post({"kind": "started", "mode": "pro", "source": "help"}).status_code, 201)
        row = TourDailyCount.objects.get()
        self.assertEqual(row.n, 2)
        # A different bucket (other source) gets its own row.
        self.post({"kind": "started", "mode": "pro", "source": "welcome"})
        self.assertEqual(TourDailyCount.objects.count(), 2)

    def test_rejects_invalid_input(self):
        from accounts.models import TourDailyCount

        self.client.force_login(self.user)
        for payload in (
            {"kind": "bogus", "mode": "pro"},
            {"kind": "completed", "mode": "admin"},
            {"kind": "started", "mode": "pro", "source": "email"},
            {"kind": "started", "mode": "pro"},
            {"kind": "aborted", "mode": "pro"},
            {"kind": "aborted", "mode": "pro", "step": "<script>"},
            {"kind": "aborted", "mode": "pro", "step": "x" * 61},
        ):
            self.assertEqual(self.post(payload).status_code, 400, payload)
        self.assertEqual(
            self.client.post(self.URL, "not json", content_type="application/json").status_code, 400
        )
        self.assertEqual(TourDailyCount.objects.count(), 0)

    def test_event_has_no_user_reference(self):
        from django.db import models

        from accounts.models import TourDailyCount

        fields = TourDailyCount._meta.get_fields()
        field_names = {f.name for f in fields}
        self.assertFalse(field_names & {"user", "owner", "created_by", "session", "session_hash"})
        # Only a day, never a timestamp — events must not be linkable in time.
        self.assertFalse([f.name for f in fields if isinstance(f, models.DateTimeField)])

