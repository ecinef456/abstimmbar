# SPDX-License-Identifier: Apache-2.0
"""Room language and French UI support for participant pages.

The UI languages are de/en (upstream) plus fr (this fork). French is a UI
language only: content stays in the canonical column (content is authored
in one language per room, see components/TranslatableField.tsx), so
settings.LANGUAGES — which also drives modeltranslation's per-language
columns — is deliberately left at de/en.
"""
import re

from django.conf import settings
from django.utils import translation
from django.utils.translation.trans_real import parse_accept_lang_header

from .models import RoomLanguage

CODES = tuple(code for code, _ in RoomLanguage.LANGUAGES)
CHOICES = (("", "Automatic"), *RoomLanguage.LANGUAGES)


def room_language(room):
    """The room's language code, or '' (unset: each viewer's own)."""
    return (
        RoomLanguage.objects.filter(room_id=room.pk).values_list("language", flat=True).first()
        or ""
    )


def set_room_language(room, language):
    if language in CODES:
        RoomLanguage.objects.update_or_create(room=room, defaults={"language": language})
    else:
        RoomLanguage.objects.filter(room=room).delete()


_ROOM_PATHS = (
    (re.compile(r"^/p/([^/]+)/"), "code"),
    (re.compile(r"^/c/([^/]+)/"), "check"),
    (re.compile(r"^/r/([^/]+)/"), "recording"),
)


def _room_language_for_path(path):
    from live.models import Run
    from rooms.models import QuestionSet, Room

    for pattern, kind in _ROOM_PATHS:
        match = pattern.match(path)
        if not match:
            continue
        key = match.group(1)
        if kind == "code":
            room = Room.objects.filter(code=key.strip().lower()).first()
        elif kind == "check":
            qs = QuestionSet.objects.filter(self_check_token=key).select_related("room").first()
            room = qs.room if qs else None
        else:
            run = Run.objects.filter(recording_token=key).select_related(
                "question_set__room"
            ).first()
            room = run.question_set.room if run else None
        return room_language(room) if room else ""
    return ""


class ParticipantLanguageMiddleware:
    """Language of the participant pages (/p/, /c/, /r/), after LocaleMiddleware.

    Order: an explicit ?lang= or language cookie (the participant's own
    pick, now including fr) > the room's language > the browser's preferred
    language among de/en/fr > whatever LocaleMiddleware chose.
    """

    PREFIXES = ("/p/", "/c/", "/r/")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        language, persist = self._pick(request)
        if language:
            translation.activate(language)
            request.LANGUAGE_CODE = language
        response = self.get_response(request)
        if persist:
            response.set_cookie(
                settings.LANGUAGE_COOKIE_NAME, persist, max_age=31536000, samesite="Lax"
            )
        return response

    def _pick(self, request):
        if not request.path.startswith(self.PREFIXES):
            return None, None
        param = request.GET.get("lang")
        if param in CODES:
            # Upstream views persist de/en themselves; fr is ours.
            return param, (param if param == "fr" else None)
        cookie = request.COOKIES.get(settings.LANGUAGE_COOKIE_NAME)
        if cookie in CODES:
            return cookie, None
        language = _room_language_for_path(request.path)
        if language:
            return language, None
        for code, _quality in parse_accept_lang_header(request.META.get("HTTP_ACCEPT_LANGUAGE", "")):
            base = code.split("-")[0].lower()
            if base in CODES:
                return base, None
        return None, None
