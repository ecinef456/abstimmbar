---
title: LMS integration (LTI 1.3)
description: Integrate Abstimmbar into Moodle or Stud.IP via LTI 1.3.
---

# LMS integration (LTI 1.3)

Abstimmbar is an LTI 1.3 tool (there is no 1.1 fallback). Architecture and
data-model decisions:
[ADR-0005](https://github.com/virtUOS/abstimmbar/blob/main/docs/decisions/0005-lti-integration.md).
Platforms are now registered through the **web admin** (see below). ADR-0005
originally named the Django admin for this; it still works, but it is no
longer the recommended way.

## Tool endpoints { #tool-endpoints }

| Purpose | URL |
| --- | --- |
| OIDC initiation ("Initiate login URL") | `https://<host>/lti/login/` |
| Launch/redirect ("Tool URL", also used for deep linking) | `https://<host>/lti/launch/` |
| Public keyset (JWKS) | `https://<host>/lti/jwks/` |
| Tool icon (SVG) | `https://<host>/lti/icon.svg` |

## Registering a platform in Abstimmbar (web admin) { #registering-a-platform-in-abstimmbar-web-admin }

**Manage website → LTI platforms → "Add platform"** (visible to admin
accounts only).

At the top, the section shows a **Tool endpoints** panel with the four URLs
from the table above (Initiate login URL, Launch URL, Keyset URL, Icon URL)
as read-only fields for copying. You need them for the counterpart
registration in the LMS (see the instructions below).

In the "Add platform" form, enter the details provided by the LMS:

- **Name**: any label you like (e.g. "Moodle Uni Osnabrück").
- **Issuer** and **Client ID**: assigned by the LMS when the tool is
  registered. The issuer (`iss`) is the identifier the LMS uses for itself;
  Abstimmbar maps a launch to a platform by **issuer + client ID**. In Moodle
  this field is called **"Platform ID"** (in the tool's configuration
  details, see below). Copy the value **exactly** (pitfall: a trailing `/`
  causes a mismatch, even if the URL otherwise looks identical).
- **Auth login URL**: the LMS's authentication URL (Moodle:
  `…/mod/lti/auth.php`). This is a standard endpoint **of Moodle itself**,
  not a value configured by Abstimmbar.
- **Auth token URL**: from the LMS documentation (Moodle:
  `…/mod/lti/token.php`). Also Moodle's own endpoint.
- **Keyset URL**: from the LMS documentation (Moodle:
  `…/mod/lti/certs.php`). Also Moodle's own endpoint.
- **Deployment IDs (comma-separated)**: assigned by the LMS **only after the
  tool has been saved** (see the Moodle instructions below), e.g. `1` or
  `1, 2`. Often it is simply `1`.
- **"Link users by email"**: checkbox, **default: on**. See the section
  [Account linking](#account-linking) below for the security note, which
  the form also displays while the option is enabled.
- **Active**: only active platforms may perform a launch. To disable a
  platform without deleting it, just untick the box (or use the
  "Deactivate" button in the list).

**Multiple LMSs** (e.g. Moodle and Stud.IP, or several Moodle instances)
each get their **own platform entry**. Issuer and client ID are unique per
LMS instance; the Tool endpoints panel is the same for all of them.

## Instructions for Moodle administrators { #instructions-for-moodle-administrators }

1. Open web admin → LTI platforms and copy the four URLs from the **Tool
   endpoints** panel (Initiate login URL, Launch URL, Keyset URL, Icon URL).
2. In Moodle: Site administration → Plugins → Activity modules → External
   tool → "Manage tools" → "configure a tool manually":
    - Tool URL: the copied **Launch URL** (`/lti/launch/`)
    - LTI version: **LTI 1.3**
    - Public key type: **Keyset URL** → the copied **Keyset URL**
      (`/lti/jwks/`)
    - Initiate login URL: the copied **Initiate login URL** (`/lti/login/`)
    - Redirection URI(s): the same Launch URL
    - **Icon URL** (or "Secure icon URL"): the copied **Icon URL**
      (`/lti/icon.svg`), an SVG served by Abstimmbar (`image/svg+xml`).
      Alternatively, you can enter your own image URL here, e.g. if you
      want a different icon.
    - **"Supports Deep Linking (Content-Item Message)"**: enable
    - Default launch container: **New window** (see
      [Cookies & iframes](#cookies-iframes))
    - **Privacy** (important for the displayed name, #57): set "**Share
      launcher's name with tool**" and "**Share launcher's email with
      tool**" to **"Always"**. Without this, Abstimmbar receives no name or
      email claims: the person then only appears as the technical handle
      `lti-<platform>-<sub>`, and email linking as described in
      [issue #1](#account-linking) cannot take effect.
3. Save. Moodle assigns the deployment ID **only now**, not before.
4. Under **"Manage tools"** → the tool you just created → menu → **"View
   configuration details"**, Moodle shows the **Platform ID** (= issuer,
   copy it exactly), **Client ID** and **Deployment ID** together.
5. Enter these values in the web admin for the platform, together with the
   three Moodle URLs (Auth login URL, Auth token URL, Keyset URL: Moodle's
   own standard endpoints, see above), and save.

## Instructions for teachers { #instructions-for-teachers }

1. In the Moodle course, choose "Add an activity or resource" →
   **"External tool"** → select the Abstimmbar connection set up by your
   administrators.
2. **"Select content"** (deep linking) opens the Abstimmbar selection page:
   **choose an existing question set** or **create a new one**.
3. The first launch from this course automatically creates a **room**
   (title = course title); the teacher who launches it becomes the room's
   **owner** and lands directly in the selected question set.

## Behaviour on launch { #behaviour-on-launch }

- **Teachers** (Instructor/Administrator role): on the first launch from a
  course, a room is created automatically (title = course title) and linked
  to the course; the teacher becomes its owner and lands in the management
  UI (or directly in the question set chosen via deep linking).
- **Students** (Learner role): are sent, without an account, to the
  anonymous participant page `/p/<code>/`. LTI does not change anything
  about the anonymity of voting.

## Account linking LTI ↔ OIDC (issue #1) { #account-linking }

The LTI `sub` is local to the platform and never matches the OIDC subject;
without linking, the same teacher would end up with two accounts. For this,
each platform has the option **"Link users by email"** (`link_by_email`, set
on the platform in the web admin, **default: on**): on the first launch of
an unknown LTI `sub`, an existing account with the same email address is
reused, provided the match is unique (exactly one account; otherwise a new
LTI account is created as before). The resolved mapping is stored
permanently in `LtiUserLink`, so later email changes in the LMS can no
longer redirect an account once it has been linked. For linked OIDC
accounts, the IdP remains the source of name and email; the launch does not
overwrite the profile.

**Security trade-off:** with this option, the LMS becomes the authority for
account matching. An email address manipulated in the LMS could take over
someone else's account that has not been linked yet. So only enable it for
your own, trusted platforms (your university's Stud.IP/Moodle, whose
addresses come from the identity management system). The web admin also
shows this note directly in the form while the option is enabled.

## Cookies & iframes { #cookies-iframes }

LTI tools often run inside an iframe in the LMS. Session cookies are then
third-party cookies, and for security reasons (`X-Frame-Options: DENY` /
CSP `frame-ancestors`) most pages may not be embedded in an iframe at all by
default. There are two ways to operate:

1. **"New window"** (recommended; Moodle: launch container "New window").
   No further configuration is needed: the tool runs as a standalone page
   and cookies are first-party.
2. **iframe embedding**, which requires two things:
    - `SESSION_COOKIE_SAMESITE=None` (environment variable; forces secure
      cookies, i.e. HTTPS). Otherwise the session cookie does not survive
      the third-party context.
    - The LMS origin must be allowed to frame the tool. Abstimmbar sets
      `Content-Security-Policy: frame-ancestors` **automatically** for the
      **registered, active platforms**, but only on pages served by Django
      (participant page `/p/...` and `/lti/...`). The SPA (management
      UI/presenter) is served by **Caddy**, which does not know about the
      platforms registered in the web admin. For it, the LMS origin must be
      added **once in the Caddyfile**, in the `frame-ancestors` line of the
      SPA `handle` block:
      ```
      header Content-Security-Policy "frame-ancestors 'self' https://moodle.example.org"
      ```
      Without a registered platform (Django pages) or without the Caddyfile
      entry (SPA), framing remains blocked (`frame-ancestors 'self'`).
      Browsers that block third-party cookies may still cause problems
      despite both settings.

## Django admin as a fallback { #django-admin-as-a-fallback }

The Django admin (**LTI platforms**) remains usable and additionally shows
fields that the web admin deliberately does not expose (e.g. the tool key
pair). For day-to-day registration of new LMS instances, the web admin (see
above) is the recommended way: no server access needed, right from the
management UI.

## Stud.IP { #studip }

Integration requires an LTI 1.3 consumer in Stud.IP (roadmap M4: test
against the university's Stud.IP as soon as its LTI 1.3 support is in
place). Registration follows the same pattern as for Moodle: enter the
details from the Tool endpoints panel in the web admin and add the values
returned by Stud.IP (client ID, deployment ID).

---

*This page is the English version of
[`docs/lti.md`](https://github.com/virtUOS/abstimmbar/blob/main/docs/lti.md)
in the repository (German).*
