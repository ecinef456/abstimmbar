# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**Abstimmbar** — an open-source audience response system (ARS) for
universities: live quizzes/polls in lectures, anonymous participation via
QR/short URL, LTI 1.3 integration into LMS, OIDC login for staff. Successor
to the Stud.IP plugin Cliqr; feature scope oriented at ARSnova/Particify.

**Status: M0–M3 done = MVP** — management UI (rooms, question sets, TipTap
editor), full live loop (runs, anonymous votes, SSE, presenter view,
participant pages; load-tested at 1000 participants), results view with
run deletion and CSV export, set duplication across rooms, JSON
export/import (sanitized on import), full-text search — plus **M4: LTI 1.3**
(pylti1p3; platform registration via Django admin, context↔room links,
deep linking; see docs/lti.md and ADR-0005). Pending: manual acceptance
against real Moodle/Stud.IP. Next: v2 features.
Authoritative documents:

- `docs/concept.md` — Funktionsumfang & Domänenmodell (German)
- `docs/roadmap.md` — milestones M0–M4, v2, Ausblick; review decisions
- `docs/decisions/` — ADRs (0001 tech stack, 0002 app structure)
- `website/` — project website (GitHub Pages; see website/README.md):
  German at the root, English twin in `website/en/`. **Keep EN in sync:**
  a change to a German page, to `docs/deployment.md` or `docs/lti.md`
  (included on the German site) needs the matching edit in `website/en/`.

## Language convention

Code in **English** (variables, models, tables, API endpoints, comments).
Concept documents in `docs/` are in **German** (review audience). UI is
bilingual DE/EN (#33): React strings via **i18next** — the English source
string is the lookup key, `de/translation.json` maps it to German (only
plural/context-suffixed keys need `en/translation.json`); the framework-free
participant page (`live/templates/`) via **Django gettext** (`{% trans %}`,
`LocaleMiddleware`, `locale/de/LC_MESSAGES`, `?lang=`/`django_language`
cookie/`Accept-Language`; note: the `.mo` catalog is cached in-process, so
`docker compose restart backend` after `compilemessages`). Signed-in users'
choice persists via `POST /api/whoami/language/`. **Content-i18n** (authored
fields — room/set/section titles, descriptions, question & option text, info
pages) via `django-modeltranslation`: per-language `*_de`/`*_en` columns,
canonical language `CONTENT_DEFAULT_LANGUAGE` (default `de`). Because the SSE
hub broadcasts one payload to all participants, translated fields are exposed
as `{de,en}` **maps** everywhere (REST, SSE/presenter payloads, results) and
resolved client-side (`contentLang.ts localizedText`, and a `locText` helper
in the participant template); the editor edits each language via
`TranslatableField` (language tabs) with an optional LibreTranslate
pre-fill (`translation_service`, `POST /api/translate/`, off unless
`CONTENT_TRANSLATION_PROVIDER=libretranslate` + `LIBRETRANSLATE_URL`).
Never write content via the bare `obj.title` accessor (it follows the active
UI language, which diverges from the canonical) — set `*_de`/`*_en`
explicitly, and resolve to canonical for CSV/AI prompts (`resolve_translated_text`).

## Branching workflow (since July 2026)

Simplified Gitflow (GitLab Flow): **no direct pushes to `main`** — it is
protected (push: no one; merge: maintainers). Work on `feature/<slug>`
branches, open a Merge Request, merge requires a green pipeline; the
source branch is auto-deleted on merge. Reference issues in the MR
description (`Closes #<n>`). No `develop` branch until there is a
production deployment.

## Tech stack (decided, ADR-0001)

- **Backend:** Django 5 (Python 3.12) + Django REST Framework, PostgreSQL 16
- **Frontend:** React + Vite + TypeScript + Tailwind — management UI and
  presenter view; the **participant page is a separate ultra-light bundle**
- **Realtime:** SSE (async Django view + in-process hub, ADR-0003); votes
  are plain POSTs; backend runs under **uvicorn** (not runserver). DB
  connections are capped by the psycopg pool (settings.py) — long-lived
  streams must release connections (`connections.close_all()` pattern in
  `live/views.py`/`live/state.py`). Load test:
  `docker compose exec backend sh -c "pip install -q aiohttp && python scripts/loadtest.py --participants 1000"`
- **Participant pages** are Django templates (`live/templates/live/`),
  deliberately framework-free (`/p/`, `/p/<code>/`)
- **Auth:** OIDC via Keycloak (`mozilla-django-oidc`); LTI 1.3 via `pylti1p3`
- **Runtime:** Docker Compose (colima on this machine, no Docker Desktop)
- Frontend dependency policy: ruthless minimum, no UI-kit libraries; every
  new dependency needs a justification.

## Running the project

```bash
colima start                  # container VM (after a reboot)
docker compose up -d          # db + keycloak + backend + frontend
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py test
```

Host ports are shifted so **Ausleihbar can run in parallel**:

- Frontend: http://localhost:5174
- Backend / Django admin: http://localhost:8002 (host 8002 → container 8000)
- Keycloak: http://localhost:8081 (admin/admin; realm `abstimmbar`,
  demo users `demo`/`demo` and `admin-demo`/`demo` — the latter is in the
  `abstimmbar-admins` group and gets Django admin on login)
- PostgreSQL: localhost:5433

OIDC login flow: visit `http://localhost:8002/oidc/authenticate/`. The
browser reaches Keycloak at `localhost:8081`; the backend reaches it via
`host.docker.internal:8081` (keeps the issuer consistent). Check session
with `GET /api/whoami/`. Back-channel logout: `POST /oidc/backchannel-logout/`.

Django apps (ADR-0002): `common`, `accounts`, `rooms` (authoring: Room,
QuestionSet, Section, Question, AnswerOption), `live` (Run, Vote,
ParticipantToken, SSE), later `lti`.

## Sibling project

`/Users/rrolf/dev/ausleihbar` — same organisation (virtUOS), same stack.
Reuse its proven patterns: OIDC setup incl. backchannel logout, Compose
layout, Keycloak dev realm, design tokens (Tailwind, OKLCH), i18n approach,
ADR process. Abstimmbar follows Ausleihbar's design language with its own
accent color.

## Explicit non-goals

No LTI 1.1 fallback. No native LMS plugins. Anonymity by design for
participants (no account, no IP logging in votes). Kahoot-style gamification
(points, leaderboards, nicknames) is deliberately deferred — possibly a
later optional feature, not in scope now.

## Key review decisions (July 2026)

Word cloud is part of the MVP (no LLM; case variants merged). Question
editor is a lean WYSIWYG with drag-and-drop images (library choice:
ADR-0007). Correct-answer reveal is configurable (immediately / after
closing / never). Any OIDC-authenticated person may create rooms by
default, including students. Rooms are reusable across semesters/groups.
