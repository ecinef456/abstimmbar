# Changelog

Alle nennenswerten Änderungen an Abstimmbar stehen in dieser Datei. Das Format
folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die
Versionsnummern folgen [Semantic Versioning](https://semver.org/lang/de/).
Die Zahlen in Klammern verweisen auf Pull Requests im
[GitHub-Repository](https://github.com/virtUOS/abstimmbar/pulls?q=is%3Apr).

## [1.0.0] – 2026-10-22

Die erste stabile Version. Abstimmbar ist damit für den regulären Einsatz in
der Lehre freigegeben.

> ### Hinweise für den Betrieb
>
> Bitte lesen Sie diese Punkte vor dem Update einer bestehenden Installation.
> Die Anleitung „Bestehende Installation aktualisieren“ im
> Installationskapitel beschreibt den Ablauf Schritt für Schritt.
>
> - **OIDC-Abgleich per Benutzername ist jetzt standardmäßig aus.**
>   `OIDC_MATCH_BY_USERNAME_FALLBACK` war bisher an. Wenn Ihre Installation
>   darauf angewiesen ist (etwa weil der Identity Provider Subjects neu
>   vergibt), setzen Sie `OIDC_MATCH_BY_USERNAME_FALLBACK=1`. Auch dann
>   übernimmt der Abgleich nie Konten ohne OIDC-Subject, also weder lokale
>   Notfall-Administratorkonten noch LTI-Konten (basicbar-auth ≥ 0.2.2)
>   (#212, #213).
> - **Kein Start mit Platzhalter-Schlüssel.** Bei `DJANGO_DEBUG=0` verweigert
>   Abstimmbar den Start, wenn `DJANGO_SECRET_KEY` noch den Entwicklungs-
>   bzw. Beispielwert aus `.env.prod.example` trägt (fehlt der Schlüssel
>   ganz, bricht bereits Docker Compose ab). Erzeugen Sie vor dem Update
>   einen eigenen Schlüssel, z. B. mit `openssl rand -base64 48` (#212, #223).
> - **Caddyfile ohne lokale Anpassungen.** Domain, ACME-Kontakt und erlaubte
>   LMS-Origins für die Einbettung kommen jetzt aus `PUBLIC_BASE_URL`,
>   `ACME_EMAIL` und `ABSTIMMBAR_FRAME_ANCESTORS` (leer = nur die eigene
>   Seite; mehrere Origins durch Leerzeichen getrennt). Haben Sie die
>   Caddyfile bisher selbst angepasst, übertragen Sie die Werte in die `.env`
>   und setzen Sie die Datei mit `git checkout -- Caddyfile` zurück. Eigene
>   Zertifikate und die IP-Einschränkung für `/metrics` bleiben
>   dokumentierte Ausnahmen (#223).
> - **Caddy leitet `/c/*` an Django weiter.** Links und QR-Codes der
>   Lernkontrolle sowie die LTI-Weiterleitung für Lernende funktionieren
>   damit in der Standardkonfiguration. Wer einen eigenen Reverse-Proxy
>   betreibt, findet die Liste der weiterzuleitenden Pfade in der
>   Installationsanleitung (#212).
> - **Das Image startet uvicorn.** Der Standardbefehl des Images ist jetzt
>   uvicorn (ASGI) statt des Django-Entwicklungsservers; eigene
>   Compose-Dateien ohne ausdrückliches `command` erhalten damit die
>   Live-Übertragung zuverlässig (#212).
> - **Größere Uploads im JSON-Format.** `DATA_UPLOAD_MAX_MEMORY_SIZE` liegt
>   jetzt bei 10 MiB, damit auch große Fragenset-Importe angenommen werden;
>   größere Anfragen werden sauber abgelehnt (#214).
> - **Alte API-Teile entfernt:** der Endpunkt `reorder-sections` und der
>   Parameter `reset` beim Start einer Durchführung (siehe „Entfernt“)
>   (#216).
> - **Neue bzw. jetzt durchgereichte Variablen** in der Produktions-Compose:
>   `OIDC_MATCH_BY_USERNAME_FALLBACK`, `ACME_EMAIL`,
>   `ABSTIMMBAR_FRAME_ANCESTORS` (Caddy), `VITE_GUIDE_URL` und
>   `VITE_GUIDE_URL_EN` (Ziel des Menüpunkts „Anleitung“, wirken beim
>   Bauen des Images) (#210, #211, #212, #223).
> - **Plattform-Updates:** Django 5.2 LTS, Node 24, Pillow 12, pypdf 6,
>   react-router 7. Die Datenbank-Migrationen laufen beim Start
>   automatisch (#214, #220).

### Fragetypen

- Mindmap: Beim Ziehen eines Begriffs zeigen alle Begriffe ihre Lasche
  „Hier einhängen“; so lässt sich ein Begriff gezielt als Unterbegriff
  einhängen statt mit einem anderen zusammengeführt zu werden (#218).
- Mindmap: Zusammenführen, Verschieben, Umbenennen und übernommene
  KI-Vorschläge werden protokolliert und lassen sich einzeln zurücksetzen,
  auch nach einem Neuladen des Beamers (#209).
- Mindmap: Die Zahl der Stimmen berücksichtigt jetzt auch Teilnehmende, die
  nur bewertet haben (#215).
- Mindmap: Der Bewertungsmodus lässt sich nach Beginn der Bewertungsphase
  nicht mehr umstellen, wie bei der Vier-Felder-Matrix (#215).
- Frageneditor: Eingaben im Textfeld gehen bei langsamer Verbindung nicht
  mehr verloren, der Editor springt beim Laden nicht mehr, und beim
  schnellen Weiterklicken überschreiben veraltete Daten keine Änderungen
  mehr (#205, #206).
- Frageneditor: Zahlenfelder bei Mindmap und Wortwolke springen beim Leeren
  nicht mehr auf 1 (#215).

### Präsentation

- Mindmap und Vier-Felder-Matrix bleiben nach dem Ende der Abstimmung am
  Beamer sichtbar, auch wenn der Timer abgelaufen ist oder Sie die
  Präsentation verlassen und wieder betreten haben (#217).
- Der Zähler unten links ist jetzt eine Füllpille: Er zeigt Verbundene und
  Antwortende und bei Wortwolke, Mindmap und Matrix zusätzlich, wie viele
  Beiträge bzw. Punkte von der möglichen Gesamtzahl schon vergeben sind
  (#219).

### Oberfläche und Anleitung

- Neue Projekt-Website mit Anleitung für Lehrende und Installationsanleitung,
  auf Deutsch und Englisch: https://virtuos.github.io/abstimmbar/ (#210,
  #211).
- Der Menüpunkt „Anleitung“ im Hilfemenü öffnet die Anleitung in der
  Sprache der Oberfläche (#210, #211).
- Beim Umschalten zwischen einfachem und Experten-Modus erscheint ein
  kurzer Hinweis, und neu eingeblendete Bedienelemente werden kurz
  hervorgehoben (#222).
- Die Versionsnummer steht dezent in der Fußzeile und im Admin-Bereich
  (#224).
- App und Teilnahmeseite haben ein Favicon und ein Icon für den
  Startbildschirm von Smartphones (#221).
- Fehlermeldungen des Servers erscheinen durchgängig in der gewählten
  Sprache (#215).

### KI

- Vier-Felder-Matrix: Die KI schlägt vor, ähnliche Karten zu Sammelkarten
  zusammenzufassen (wählbar: nur Schreibweise, inhaltlich gleich,
  konzeptionell ähnlich). Sie prüfen jeden Vorschlag, können Titel und
  Kategorie anpassen und das Übernehmen rückgängig machen. An die KI gehen
  nur Karteninhalte, keine Daten über Teilnehmende (#207, #208).
- Fragen aus Dokumenten: Ist das Material ungeeignet, nennt die KI jetzt
  den Grund, statt einfach keine Fragen zu liefern (#216).
- Antworten in Aufzeichnungen werden jetzt ebenfalls von der KI bewertet
  und bleiben nicht mehr auf „wird bewertet“ stehen (#215).
- Auf der Ergebnisseite erscheinen KI-Funktionen nur, wenn die KI für die
  jeweilige Frage eingeschaltet ist (#215).

### Teilnahme

- Wortwolken- und Freitextantworten mit unsichtbaren Steuerzeichen führen
  nicht mehr zu einem Fehler; zusammengesetzte Emoji bleiben erhalten
  (#215).
- Links und QR-Codes der Lernkontrolle funktionieren in der
  Standardinstallation (#212).

### Ergebnisse und Export

- Im CSV-Export stehen Matrix-Koordinaten als echte Zahlen, und
  Kategorienamen der Matrix fallen bei fehlender Übersetzung auf die
  Hauptsprache zurück (#212, #215).

### Sicherheit

- **Für den Betrieb relevant:** Der OIDC-Abgleich per Benutzername ist
  standardmäßig aus und übernimmt nie lokale oder LTI-Konten; eine
  Namenskollision führt zu einer sauberen Ablehnung statt zu einem
  Serverfehler. Setzen Sie bei Bedarf `OIDC_MATCH_BY_USERNAME_FALLBACK=1`
  (#212, #213).
- **Für den Betrieb relevant:** Ohne eigenen `DJANGO_SECRET_KEY` startet
  eine Produktionsinstallation nicht mehr (#212).
- CSV-Export: Alle Textzellen sind gegen Formel-Injektion in
  Tabellenkalkulationen geschützt, auch Frage- und Antworttexte aus
  importierten oder geteilten Sets (#212).
- LTI: „Nutzende per E-Mail verknüpfen“ ist für neu angelegte Plattformen
  standardmäßig aus (#212).
- Abhängigkeiten mit bekannten Sicherheitslücken aktualisiert, u. a.
  Django 5.2 LTS, Pillow 12, pypdf 6 und react-router 7 (#214, #220).

### Deployment und Betrieb

- Die Caddyfile wird vollständig über Variablen in der `.env` konfiguriert;
  ein `git pull` bleibt nicht mehr an lokalen Änderungen hängen (#223).
- Installationsanleitung: neuer Pflichtschritt „Secret Key erzeugen“ und
  neues Kapitel „Bestehende Installation aktualisieren“ (#223).
- Die Installationsanleitung nennt die Pfade, die ein eigener
  Reverse-Proxy an Django weitergeben muss (#212).
- Das Image startet standardmäßig uvicorn; Caddy leitet `/c/*` an Django
  weiter (#212).
- Fragenset-Importe bis 10 MiB werden angenommen (#214).
- Laufzeit auf Node 24 LTS und Django 5.2 LTS angehoben; ungenutzte
  Abhängigkeiten entfernt (#214).
- Release-Images tragen die Versionsnummer aus dem Git-Tag und werden
  sowohl als `1.0.0` als auch als `v1.0.0` (und `latest`) veröffentlicht;
  für `ABSTIMMBAR_VERSION` eignet sich damit der Name des Git-Tags (#224).

### Barrierefreiheit

- Die Schaltflächen „Wieder einblenden“ bzw. „Wieder anzeigen“ in Mindmap,
  Wortwolke und Matrix haben Namen, die mit dem sichtbaren Text
  übereinstimmen (#218).
- Die Lasche „Hier einhängen“ der Mindmap hat einen zugänglichen Namen
  (#218).
- Die Füllpille am Beamer hat Screenreader-Beschriftungen je Zahl und
  verzichtet bei reduzierter Bewegung auf Animationen (#219).
- Die Rangliste der Mindmap wird als nummerierte Liste ausgegeben; Kontraste
  in Rangliste und Hinweisbannern verbessert (#215).
- Deaktivierte Bewertungsknöpfe der Matrix auf der Teilnahmeseite nennen
  den Grund, wie bei der Mindmap (#215).
- Nach einer Moderationsaktion springt der Fokus nicht mehr auf deaktivierte
  Knöpfe (#215).
- Selbst verfasste Tabellen, etwa in der Datenschutzerklärung, scrollen auf
  dem Smartphone in einem eigenen, per Tastatur erreichbaren Rahmen (#222).

### Entfernt

- API-Endpunkt `POST question-sets/<id>/reorder-sections/`; verwenden Sie
  `reorder-outline` (#216).
- Parameter `reset` beim Start einer Durchführung (`start-run`): Er wird
  ignoriert, maßgeblich ist allein `existing`. Ältere Skripte mit
  `reset: true` setzen eine Durchführung damit fort, statt sie zu löschen
  (#216).
- Interne Aufräumarbeiten: ungenutzter Code, verwaiste Übersetzungen und
  Datenbankfelder sowie die Abhängigkeit gunicorn (#214, #216).

## Vor 1.0

Abstimmbar entstand ab Juli 2026 bei virtUOS (Universität Osnabrück) als
Nachfolger des Stud.IP-Plugins Cliqr. Bis zur Version 1.0 wurde in diesen
Etappen entwickelt:

- **Fundament (M0):** Docker-Compose-Setup, Anmeldung per OpenID Connect mit
  Back-Channel-Logout, Oberfläche in React mit eigenem Erscheinungsbild.
- **Verwalten (M1):** Räume, Fragensets und Fragen mit WYSIWYG-Editor und
  Bildern; Einzel- und Mehrfachauswahl, Ja/Nein, Wortwolke; einstellbar,
  wann richtige Antworten gezeigt werden.
- **Durchführen (M2):** Live-Abstimmung mit Präsentationsmodus, QR-Code und
  Kurz-URL, anonyme Teilnahmeseite ohne Konto, Live-Ergebnisse; im Lasttest
  mit 1000 gleichzeitigen Teilnehmenden geprüft.
- **Auswerten (M3):** Ergebnisansicht, CSV-Export, Duplizieren und Kopieren
  von Fragensets, JSON-Export/-Import, Volltextsuche.
- **LTI 1.3 (M4):** Einbindung in Lernplattformen mit Kursraum-Verknüpfung
  und Deep Linking.
- **Weiterer Ausbau:** Likert-Skalen, Freitext, Sortierung, Prioritäten,
  Mindmap und Vier-Felder-Matrix mit Bewertungsphase; Countdown-Timer,
  Abschnitte, Bilder als Antwortoptionen; Set-Arten Live-Umfrage,
  Quiz-Block und Lernkontrolle; Teilen von Räumen und Sets; Zweisprachigkeit
  DE/EN für Oberfläche und Inhalte; optionale KI-Funktionen (Fragen aus
  Dokumenten, Wortwolken-, Freitext- und Mindmap-Auswertung);
  Statistikseite mit Prometheus-Export; geführter Rundgang mit Beispielraum;
  Mobilansicht und Kontraste nach WCAG AA.

## [0.1.2] – 2026-10-16

- Umfangreicher Funktionsstand vor 1.0: Set-Arten mit Lernkontrolle,
  Mindmap und Vier-Felder-Matrix mit Bewertung, neue Präsentationsansicht,
  geführter Rundgang, Statistikseite, KI-Funktionen, Mobilansicht und
  WCAG-AA-Kontraste.
- Automatisierte Ende-zu-Ende-Tests mit Playwright.

## [0.1.1] – 2026-08-07

- Aktualisierte gemeinsame Oberflächenbibliothek (@basicbar/ui 0.3.0).

## [0.1.0] – 2026-08-07

- Erste veröffentlichte Version mit automatisch gebautem Release-Image.
- Gemeinsame basicbar-Pakete werden aus den GitHub-Repositories bezogen.

[1.0.0]: https://github.com/virtUOS/abstimmbar/compare/v0.1.2...v1.0.0
[0.1.2]: https://github.com/virtUOS/abstimmbar/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/virtUOS/abstimmbar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/virtUOS/abstimmbar/releases/tag/v0.1.0
