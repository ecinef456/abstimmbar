# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Site-content API: public reads (branding, landing text, footer pages,
data-collection registry) and staff-only management."""
import hmac
from typing import ClassVar

from django.conf import settings
from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework import parsers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsAdmin

from .data_collection import COLLECTED, NOT_COLLECTED
from .models import Page, SiteConfig
from .serializers import (
    PageDetailSerializer,
    PageLinkSerializer,
    PageManageSerializer,
    SiteConfigSerializer,
)

MAX_LOGO_BYTES = 5 * 1024 * 1024


# --- public reads (no auth) --------------------------------------------------


class SiteView(APIView):
    """Branding + landing text for any visitor (header logo, pre-login page)."""

    permission_classes: ClassVar = []

    def get(self, request):
        return Response(SiteConfigSerializer(SiteConfig.load(), context={"request": request}).data)


class FooterPagesView(APIView):
    permission_classes: ClassVar = []

    def get(self, request):
        pages = Page.objects.filter(is_published=True, show_in_footer=True)
        return Response(PageLinkSerializer(pages, many=True).data)


class PageDetailView(APIView):
    permission_classes: ClassVar = []

    def get(self, request, slug):
        page = get_object_or_404(Page, slug=slug, is_published=True)
        return Response(PageDetailSerializer(page).data)


class DataCollectionView(APIView):
    """The privacy page's auto-generated data inventory (from code)."""

    permission_classes: ClassVar = []

    def get(self, request):
        return Response({"collected": COLLECTED, "not_collected": NOT_COLLECTED})


# --- staff management --------------------------------------------------------


class SiteManageView(APIView):
    permission_classes: ClassVar = [IsAdmin]

    def get(self, request):
        return Response(
            SiteConfigSerializer(SiteConfig.load(), context={"request": request}).data
        )

    def put(self, request):
        config = SiteConfig.load()
        # landing_text/closing_info are {"de", "en"} maps (#33 MR2); the
        # serializer's TranslatedMapMixin also still accepts a legacy plain
        # string (written to the canonical language only).
        serializer = SiteConfigSerializer(
            config, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


class SiteLogoView(APIView):
    permission_classes: ClassVar = [IsAdmin]
    parser_classes: ClassVar = [parsers.MultiPartParser]

    def post(self, request):
        file = request.FILES.get("file")
        if file is None:
            return Response({"detail": "Keine Datei."}, status=400)
        is_image = (file.content_type or "").startswith("image/")
        is_svg = file.name.lower().endswith(".svg")
        if not (is_image or is_svg):
            return Response({"detail": "Only image files (including SVG)."}, status=400)
        if file.size > MAX_LOGO_BYTES:
            return Response({"detail": "The logo exceeds 5 MB."}, status=400)
        config = SiteConfig.load()
        if config.logo:
            config.logo.delete(save=False)
        config.logo = file
        config.save()
        return Response(
            SiteConfigSerializer(config, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )

    def delete(self, request):
        config = SiteConfig.load()
        if config.logo:
            config.logo.delete(save=False)
            config.logo = None
            config.save()
        return Response(status=status.HTTP_204_NO_CONTENT)


class AdminStatsView(APIView):
    """Staff-only JSON metrics for the React admin stats page (task 3 of the
    admin-stats-prometheus feature). Thin wrapper around ``common.stats``."""

    permission_classes: ClassVar = [IsAdmin]

    def get(self, request):
        import datetime

        from django.utils import timezone

        from . import stats

        today = timezone.localdate()

        def _parse(value):
            try:
                return datetime.date.fromisoformat(value)
            except (TypeError, ValueError):
                return None

        # Explicit from/to range wins; otherwise a `days` window ending today.
        frm = _parse(request.query_params.get("from"))
        to = _parse(request.query_params.get("to"))
        if frm:
            until = min(to or today, today)
            since = min(frm, until)
            # Cap the window so a huge range can't hammer the DB.
            since = max(since, until - datetime.timedelta(days=365))
        else:
            try:
                days = int(request.query_params.get("days", 30))
            except (TypeError, ValueError):
                days = 30
            days = max(1, min(365, days))
            until = today
            since = today - datetime.timedelta(days=days - 1)
        return Response({
            "totals": stats.totals(),
            "daily": stats.daily(since, until),
            "from": since.isoformat(),
            "to": until.isoformat(),
            "days": (until - since).days + 1,
        })


def _esc(label_value):
    return str(label_value).replace("\\", "\\\\").replace('"', '\\"')


def render_prometheus():
    """Render the metric layer (``common.stats.totals()`` + today's
    DailyModeSession counts) as Prometheus text exposition format."""
    from django.db.models import Count
    from django.utils import timezone

    from accounts.models import DailyModeSession

    from . import stats

    t = stats.totals()
    lines = []

    def gauge(name, help_text, value, labels=None):
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} gauge")
        if labels is None:
            lines.append(f"{name} {int(value)}")
        else:
            for lbls, v in labels:
                lset = ",".join(f'{k}="{_esc(val)}"' for k, val in lbls.items())
                lines.append(f"{name}{{{lset}}} {int(v)}")

    gauge("abstimmbar_rooms", "Total rooms", t["rooms"])
    gauge("abstimmbar_rooms_lti", "Rooms created via LTI", t["rooms_lti"])
    gauge("abstimmbar_users", "Registered users", t["users"])
    gauge("abstimmbar_question_sets", "Question sets by type", None,
          [({"type": k}, v) for k, v in t["sets_by_type"].items()])
    gauge("abstimmbar_questions", "Questions by kind", None,
          [({"kind": k}, v) for k, v in t["questions_by_kind"].items()])
    gauge("abstimmbar_runs", "Runs (presented sets) by set type", None,
          [({"type": k}, v) for k, v in t["runs_by_type"].items()])
    gauge("abstimmbar_participants", "Distinct participants who voted", t["participants"])
    gauge("abstimmbar_questions_run", "Distinct questions voted on", t["questions_run"])
    tour = t["tour"]
    gauge("abstimmbar_tour_events", "Guided-tour events by kind and mode", None,
          [({"kind": k, "mode": m}, tour[k][m])
           for k in ("started", "completed", "aborted") for m in ("easy", "pro")])
    gauge("abstimmbar_tour_starts", "Guided-tour starts by source", None,
          [({"source": s}, v) for s, v in tour["by_source"].items()])
    gauge("abstimmbar_tour_users_seen", "Users who finished or dismissed the guided tour",
          tour["users_seen"])
    today = timezone.localdate()
    sess = {r["mode"]: r["n"] for r in
            DailyModeSession.objects.filter(date=today).values("mode").annotate(n=Count("id"))}
    gauge("abstimmbar_sessions_today", "Active sessions today by mode", None,
          [({"mode": m}, sess.get(m, 0)) for m in ("easy", "pro")])
    return "\n".join(lines) + "\n"


class MetricsView(APIView):
    """Token-guarded Prometheus text exporter, top-level ``GET /metrics``
    (deliberately outside ``/api/`` — a scrape target, not an app API route).
    Auth is checked manually against a bearer token (``METRICS_TOKEN``), not
    via DRF's session/OIDC auth — a scraper has neither a session nor an
    OIDC token, and DRF auth would also pull in CSRF handling we don't want
    here."""

    permission_classes: ClassVar = []  # token-checked manually
    authentication_classes: ClassVar = []

    def get(self, request):
        token = settings.METRICS_TOKEN
        if not token:
            raise Http404()
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not hmac.compare_digest(header, f"Bearer {token}"):
            return HttpResponse(status=401)
        return HttpResponse(
            render_prometheus(),
            content_type="text/plain; version=0.0.4; charset=utf-8",
        )


class ManagePageViewSet(viewsets.ModelViewSet):
    queryset = Page.objects.all()
    serializer_class = PageManageSerializer
    permission_classes: ClassVar = [IsAdmin]
    pagination_class = None  # small admin list — return a plain array

    def perform_create(self, serializer):
        highest = Page.objects.order_by("-footer_order").first()
        serializer.save(footer_order=(highest.footer_order + 1) if highest else 0)

    @action(detail=False, methods=["post"])
    def reorder(self, request):
        order = request.data.get("order") or []
        for index, page_id in enumerate(order):
            Page.objects.filter(pk=page_id).update(footer_order=index)
        return Response({"status": "ok"})
