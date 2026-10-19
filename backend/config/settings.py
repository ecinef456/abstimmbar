# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Universität Osnabrück (virtUOS)

"""Django settings for Abstimmbar (audience response system)."""
import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_list(name, default):
    """Comma-separated env var → list, dropping blanks.

    An empty or trailing-comma value (e.g. CORS_ALLOWED_ORIGINS unset in
    docker-compose) yields [] rather than [''], which would otherwise fail
    Django's system checks (e.g. corsheaders.E013).
    """
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


def _int_or_default(name, default):
    """Env var → int; a blank or malformed value falls back to the default
    (so a typo in the AI config can't crash Django at startup)."""
    try:
        return int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def _float_or_default(name, default):
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


_DEV_SECRET_KEY = "dev-insecure-secret-key-change-me"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", _DEV_SECRET_KEY)

DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"

if not DEBUG and SECRET_KEY == _DEV_SECRET_KEY:
    raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG=0")

ALLOWED_HOSTS = _env_list(
    "DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,0.0.0.0,backend"
)

INSTALLED_APPS = [
    "modeltranslation",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.postgres",
    # Third-party
    "rest_framework",
    "corsheaders",
    "mozilla_django_oidc",
    "basicbar_auth",
    "basicbar_integrations",
    # Local apps (ADR-0002)
    "common",
    "accounts",
    "rooms",
    "live",
    "basicbar_lti",
    "lti",
]

AUTH_USER_MODEL = "accounts.User"

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.locale.LocaleMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "basicbar_lti.middleware.LtiFrameAncestorsMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "django.template.context_processors.i18n",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
# The SSE channel (app `live`, milestone M2) runs on the ASGI application.
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("POSTGRES_DB", "abstimmbar"),
        "USER": os.environ.get("POSTGRES_USER", "abstimmbar"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", "abstimmbar"),
        "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
        "PORT": os.environ.get("POSTGRES_PORT", "5432"),
        # Native psycopg connection pool (Django 5.1). Under ASGI every
        # concurrent request context would otherwise open its own PostgreSQL
        # connection — a 1000-participant vote burst exceeds the server's
        # connection limit. The pool caps us at max_size; request threads
        # briefly wait instead of failing (verified by scripts/loadtest.py).
        "OPTIONS": {
            "pool": {"min_size": 2, "max_size": 20, "timeout": 10},
        },
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en"
TIME_ZONE = "Europe/Berlin"
USE_I18N = True
USE_TZ = True

LANGUAGES = [("en", "English"), ("de", "German")]
LOCALE_PATHS = [BASE_DIR / "locale"]

# Authored-content i18n (django-modeltranslation, #33 MR2): per-language
# columns for authoring fields (Room.title etc.), distinct from the UI-i18n
# above. The canonical/default language is the one existing rows are
# backfilled into (see rooms/common migrations).
MODELTRANSLATION_LANGUAGES = tuple(code for code, _ in LANGUAGES)
MODELTRANSLATION_DEFAULT_LANGUAGE = os.environ.get("CONTENT_DEFAULT_LANGUAGE", "de")
if MODELTRANSLATION_DEFAULT_LANGUAGE not in MODELTRANSLATION_LANGUAGES:
    raise ValueError(
        f"CONTENT_DEFAULT_LANGUAGE={MODELTRANSLATION_DEFAULT_LANGUAGE!r} is not one "
        f"of the supported languages {MODELTRANSLATION_LANGUAGES}."
    )
MODELTRANSLATION_FALLBACK_LANGUAGES = (
    MODELTRANSLATION_DEFAULT_LANGUAGE,
    *(c for c in MODELTRANSLATION_LANGUAGES if c != MODELTRANSLATION_DEFAULT_LANGUAGE),
)

STATIC_URL = "static/"
# Target for `collectstatic` in production (served by the reverse proxy).
STATIC_ROOT = BASE_DIR / "staticfiles"

# Uploaded media (images in question texts, milestone M1).
MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

# Uploaded image normalization (WebP re-encode + downscale on upload).
# Safe defaults; override via env only if needed (no prod change required).
IMAGE_MAX_EDGE = int(os.environ.get("IMAGE_MAX_EDGE", "1600"))
IMAGE_WEBP_QUALITY = int(os.environ.get("IMAGE_WEBP_QUALITY", "80"))

# App-specific cookie names: browsers share cookies per host regardless of
# port, so other tools on the same host (e.g. several -bar tools on localhost
# in development) would overwrite "sessionid"/"csrftoken" and log each other out.
SESSION_COOKIE_NAME = "abstimmbar_sessionid"
CSRF_COOKIE_NAME = "abstimmbar_csrftoken"

# Behind a TLS-terminating reverse proxy in production: trust its forwarded
# host/scheme so absolute URLs use https, and require secure cookies.
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    USE_X_FORWARDED_HOST = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# HTML surfaces the registered LMS platforms may embed in an iframe
# (basicbar_lti's frame-ancestors middleware): the LTI endpoints and the
# anonymous participant pages.
LTI_FRAME_PATH_PREFIXES = ("/lti/", "/p/")

# LTI launches may run inside an LMS iframe; the session cookie then needs
# SameSite=None (+ Secure, i.e. HTTPS). Default stays Lax — recommend
# configuring the LMS tool to open in a new window instead (docs/lti.md).
SESSION_COOKIE_SAMESITE = os.environ.get("SESSION_COOKIE_SAMESITE", "Lax")
if SESSION_COOKIE_SAMESITE == "None":
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SAMESITE = "None"
    CSRF_COOKIE_SECURE = True

# Allow the React/Vite dev server to call the API during development.
CORS_ALLOWED_ORIGINS = _env_list(
    "CORS_ALLOWED_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174"
)
# The SPA calls the API with the session cookie (same-site localhost).
CORS_ALLOW_CREDENTIALS = True
# Cross-origin POSTs from the SPA carry the CSRF token; trust its origin.
CSRF_TRUSTED_ORIGINS = _env_list(
    "CSRF_TRUSTED_ORIGINS", "http://localhost:5174,http://localhost:8002"
)

REST_FRAMEWORK = {
    # Session auth only. DRF's default also enables BasicAuthentication, which
    # would expose every endpoint to password guessing against the break-glass
    # superuser (ModelBackend) — without rate limiting and bypassing CSRF.
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PAGINATION_CLASS": "common.pagination.StandardPagination",
    "PAGE_SIZE": 25,
}

# Optional AI features via a LiteLLM proxy (see common/ai.py). Off unless
# fully configured; "enabled" is derived from these, not a separate flag.
# Env is read at startup — changing it needs a container recreate.
AI_PROVIDER = os.environ.get("AI_PROVIDER", "none")  # "none" | "litellm"
AI_BASE_URL = os.environ.get("AI_BASE_URL", "")       # e.g. https://litellm.example.org/v1
AI_API_KEY = os.environ.get("AI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "")
AI_TIMEOUT = _int_or_default("AI_TIMEOUT", 30)
AI_MAX_TOKENS = _int_or_default("AI_MAX_TOKENS", 2000)
AI_DISABLE_THINKING = os.environ.get("AI_DISABLE_THINKING", "1") == "1"
# Chunked async question generation over long documents (see rooms.GenerationJob).
# The whole document is processed in chunks (superseding the old single-shot
# AI_DOC_MAX_CHARS cap), so the effective ceiling is AI_CHUNK_CHARS * (AI_GEN_MAX_CHUNKS + 1).
AI_CHUNK_CHARS = _int_or_default("AI_CHUNK_CHARS", 12000)
AI_GEN_MAX_CHUNKS = _int_or_default("AI_GEN_MAX_CHUNKS", 40)
AI_GEN_MAX_QUESTIONS = _int_or_default("AI_GEN_MAX_QUESTIONS", 150)
AI_GEN_DEFAULT_DENSITY = _float_or_default("AI_GEN_DEFAULT_DENSITY", 1.0)

# Bearer token protecting the Prometheus metrics endpoint (admin stats).
# Empty by default (disabled); set in production to enable scraping.
METRICS_TOKEN = os.environ.get("METRICS_TOKEN", "")

# Optional machine translation for authored content (see
# common/translation_service.py). Off by default; an institution can
# self-host LibreTranslate (Apache-2.0) and point LIBRETRANSLATE_URL at it.
CONTENT_TRANSLATION_PROVIDER = os.environ.get(
    "CONTENT_TRANSLATION_PROVIDER", "none"
)  # "none" | "libretranslate"
LIBRETRANSLATE_URL = os.environ.get("LIBRETRANSLATE_URL", "")
LIBRETRANSLATE_API_KEY = os.environ.get("LIBRETRANSLATE_API_KEY", "")

# Public base URL of the SPA, used for links (e.g. short URLs, QR targets).
FRONTEND_BASE_URL = os.environ.get("FRONTEND_BASE_URL", "http://localhost:5174")

# --- Authentication / OIDC ---
# OIDC is the primary login for lecturers/admins; Django's ModelBackend stays
# as a local dev / break-glass fallback (bootstrap superuser). Participants
# never log in (anonymity by design, concept §9).
AUTHENTICATION_BACKENDS = [
    "basicbar_auth.oidc.OIDCBackend",
    "django.contrib.auth.backends.ModelBackend",
]

OIDC_RP_CLIENT_ID = os.environ.get("OIDC_RP_CLIENT_ID", "")
OIDC_RP_CLIENT_SECRET = os.environ.get("OIDC_RP_CLIENT_SECRET", "")
OIDC_RP_SIGN_ALGO = "RS256"
# Keep the ID token in the session so logout can send it as id_token_hint.
OIDC_STORE_ID_TOKEN = True

# Endpoints: set them explicitly, or set OIDC_OP_ISSUER to derive them from the
# provider's discovery document. Explicit values always win (needed for the
# local browser/backchannel split). Switching provider = change these env vars.
OIDC_OP_ISSUER = os.environ.get("OIDC_OP_ISSUER", "")
OIDC_OP_AUTHORIZATION_ENDPOINT = os.environ.get("OIDC_OP_AUTHORIZATION_ENDPOINT", "")
OIDC_OP_TOKEN_ENDPOINT = os.environ.get("OIDC_OP_TOKEN_ENDPOINT", "")
OIDC_OP_USER_ENDPOINT = os.environ.get("OIDC_OP_USER_ENDPOINT", "")
OIDC_OP_JWKS_ENDPOINT = os.environ.get("OIDC_OP_JWKS_ENDPOINT", "")
OIDC_OP_LOGOUT_ENDPOINT = os.environ.get("OIDC_OP_LOGOUT_ENDPOINT", "")

if OIDC_OP_ISSUER and not OIDC_OP_AUTHORIZATION_ENDPOINT:
    from basicbar_auth.discovery import discover_endpoints

    _discovered = discover_endpoints(OIDC_OP_ISSUER)
    OIDC_OP_AUTHORIZATION_ENDPOINT = _discovered.get("authorization_endpoint", "")
    OIDC_OP_TOKEN_ENDPOINT = OIDC_OP_TOKEN_ENDPOINT or _discovered.get("token_endpoint", "")
    OIDC_OP_USER_ENDPOINT = OIDC_OP_USER_ENDPOINT or _discovered.get("userinfo_endpoint", "")
    OIDC_OP_JWKS_ENDPOINT = OIDC_OP_JWKS_ENDPOINT or _discovered.get("jwks_uri", "")
    OIDC_OP_LOGOUT_ENDPOINT = OIDC_OP_LOGOUT_ENDPOINT or _discovered.get("end_session_endpoint", "")

OIDC_OP_LOGOUT_URL_METHOD = "basicbar_auth.oidc.provider_logout_url"

# Claim mapping (provider-agnostic; defaults are standard OIDC claim names).
OIDC_CLAIM_USERNAME = os.environ.get("OIDC_CLAIM_USERNAME", "preferred_username")
OIDC_CLAIM_EMAIL = os.environ.get("OIDC_CLAIM_EMAIL", "email")
OIDC_CLAIM_FIRST_NAME = os.environ.get("OIDC_CLAIM_FIRST_NAME", "given_name")
OIDC_CLAIM_LAST_NAME = os.environ.get("OIDC_CLAIM_LAST_NAME", "family_name")
# Group/role claim, and the group that grants Django admin (empty = disabled,
# admins then managed manually via Django admin / a createsuperuser account).
OIDC_GROUPS_CLAIM = os.environ.get("OIDC_GROUPS_CLAIM", "groups")
OIDC_ADMIN_GROUP = os.environ.get("OIDC_ADMIN_GROUP", "")
# Heal re-issued IdP subjects (re-imported dev realm, realm migration) by
# matching on the username. Opt-in (default off): only enable it for IdPs that
# assign usernames centrally and never re-assign them to different people —
# otherwise an IdP account could adopt a local account of the same username.
# basicbar-auth >= 0.2.2 additionally never adopts accounts without an OIDC
# subject (e.g. the local break-glass superuser). See its operator notes.
OIDC_MATCH_BY_USERNAME_FALLBACK = (
    os.environ.get("OIDC_MATCH_BY_USERNAME_FALLBACK", "0") == "1"
)

# Where to send the browser after login/logout (the SPA).
LOGIN_REDIRECT_URL = os.environ.get("OIDC_LOGIN_REDIRECT_URL", "http://localhost:5174/")
LOGOUT_REDIRECT_URL = os.environ.get("OIDC_LOGOUT_REDIRECT_URL", "http://localhost:5174/")
# On a failed/declined login (incl. a silent prompt=none attempt with no IdP
# session) send the browser back to the SPA with a marker, so the landing page
# shows instead of erroring and does not retry the silent login.
LOGIN_REDIRECT_URL_FAILURE = LOGIN_REDIRECT_URL.rstrip("/") + "/?sso=failed"
