---
title: Installation
description: Abstimmbar an der eigenen Einrichtung betreiben — Docker Compose, Caddy, OIDC und LTI 1.3.
docs_include: true
---

# Installation

Abstimmbar ist freie Software (Apache-2.0) und läuft als
**Docker-Compose-Stack** auf einem eigenen Linux-Server: PostgreSQL, Django
(uvicorn) und Caddy als Reverse Proxy mit automatischem HTTPS. Die Anmeldung
der Lehrenden läuft über den Identity Provider Ihrer Einrichtung (OIDC, z. B.
Keycloak); Teilnehmende brauchen kein Konto.

!!! info "Quelle dieser Seite"
    Der folgende Text ist die Betriebsanleitung aus dem Repository
    ([`docs/deployment.md`](https://github.com/virtUOS/abstimmbar/blob/main/docs/deployment.md))
    und wird bei jedem Website-Build von dort übernommen. Die Einbindung in
    Moodle oder Stud.IP beschreibt die Seite
    [LMS-Einbindung (LTI 1.3)](lti.md).

--8<-- "docs/deployment.md:2"
