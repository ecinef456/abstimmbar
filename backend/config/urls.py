# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Root URL configuration."""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from accounts.views import (
    ensure_example_room,
    record_tour_event,
    set_mode,
    set_tour_seen,
    whoami,
)
from common.views import MetricsView
from live.urls import api_urlpatterns as live_api
from live.urls import page_urlpatterns as live_pages
from lti.api_urls import urlpatterns as lti_api

urlpatterns = [
    path("admin/", admin.site.urls),
    # Top-level, not under /api/ — a Prometheus scrape target, not an app API
    # route. Token-guarded inside the view itself (see MetricsView).
    path("metrics", MetricsView.as_view()),
    # OIDC login/logout/silent/back-channel, the Back-tolerant callback and
    # api/whoami/language/ — all from basicbar-auth.
    path("", include("basicbar_auth.urls")),
    path("api/whoami/", whoami),
    path("api/whoami/mode/", set_mode),
    path("api/whoami/tour-seen/", set_tour_seen),
    path("api/whoami/tour-event/", record_tour_event),
    path("api/whoami/example-room/", ensure_example_room),
    path("api/", include((live_api, "live"))),
    path("api/", include("rooms.urls")),
    path("api/", include("common.urls")),
    path("api/lti/", include((lti_api, "lti-api"))),
    path("api/quizbar/", include("quizbar.urls")),
    path("", include("lti.urls")),
    *live_pages,
]

# Serve uploaded media and static files during local development. (Static
# needs explicit wiring because we run uvicorn, not `manage.py runserver`.)
if settings.DEBUG:
    from django.contrib.staticfiles.urls import staticfiles_urlpatterns

    urlpatterns += staticfiles_urlpatterns()
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
