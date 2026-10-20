# LTI 1.3 — Einbindung in Lernmanagementsysteme

Abstimmbar ist ein LTI-1.3-Tool (kein 1.1-Fallback). Architektur- und
Modell-Entscheidungen: [ADR-0005](decisions/0005-lti-integration.md).
Die Plattform-Registrierung erfolgt inzwischen über den **Web-Admin**
(siehe unten) — ADR-0005 nannte dafür ursprünglich den Django-Admin, der
weiterhin funktioniert, aber nicht mehr der empfohlene Weg ist.

## Endpunkte des Tools

| Zweck | URL |
| --- | --- |
| OIDC-Initiation („Initiate login URL") | `https://<host>/lti/login/` |
| Launch/Redirect („Tool URL", auch Deep-Linking) | `https://<host>/lti/launch/` |
| Public Keyset (JWKS) | `https://<host>/lti/jwks/` |
| Tool-Icon (SVG) | `https://<host>/lti/icon.svg` |

## Plattform in Abstimmbar registrieren (Web-Admin)

**Manage website → „Website verwalten" → LTI-Plattformen → „Plattform
hinzufügen"** (nur für Admin-Konten sichtbar).

Der Abschnitt zeigt oben ein **Tool-Endpunkte-Panel** mit den vier
URLs aus der Tabelle oben (Initiate-Login-URL, Launch-URL, Keyset-URL,
Icon-URL) als schreibgeschützte Felder zum Kopieren — die braucht man für
die Gegenregistrierung im LMS (siehe Anleitungen unten).

Im Formular „Plattform hinzufügen" werden die Angaben des LMS eingetragen:

- **Name**: frei wählbare Bezeichnung (z. B. „Moodle Uni Osnabrück").
- **Issuer** und **Client-ID**: vergibt das LMS bei der Tool-Registrierung.
  Der Issuer (`iss`) ist die Kennung, unter der sich das LMS selbst
  ausweist; Abstimmbar ordnet einen Launch anhand von **Issuer +
  Client-ID** einer Plattform zu. In Moodle heißt das Feld **„Platform
  ID"** (in den Konfigurationsdetails des Tools, siehe unten) — den Wert
  **wörtlich** kopieren (Stolperfalle: ein angehängter `/` führt zu
  einem Mismatch, auch wenn die URL sonst identisch aussieht).
- **Auth-Login-URL**: die Authentifizierungs-URL des LMS (Moodle:
  `…/mod/lti/auth.php`) — ein Standard-Endpunkt **von Moodle selbst**,
  kein von Abstimmbar konfigurierter Wert.
- **Auth-Token-URL**: aus der LMS-Dokumentation (Moodle:
  `…/mod/lti/token.php`) — ebenfalls Moodles eigener Endpunkt.
- **Keyset-URL**: aus der LMS-Dokumentation (Moodle:
  `…/mod/lti/certs.php`) — ebenfalls Moodles eigener Endpunkt.
- **Deployment-IDs (kommagetrennt)**: vergibt das LMS **erst nach dem
  Speichern** des Tools (siehe Moodle-Anleitung unten), z. B. `1` oder
  `1, 2` — häufig einfach `1`.
- **„Nutzende per E-Mail verknüpfen"**: Checkbox, **Standard: aus** (nur für Plattformen aktivieren,
  die E-Mail-Änderungen bestätigen); siehe
  Abschnitt [Konto-Verknüpfung](#konto-verknüpfung-lti--oidc-issue-1)
  unten für den Sicherheitshinweis, der auch im Formular eingeblendet
  wird, solange die Option aktiv ist.
- **Aktiv**: nur aktive Plattformen dürfen einen Launch durchführen;
  zum Deaktivieren ohne Löschen einfach den Haken entfernen (oder den
  Button „Deaktivieren" in der Liste).

**Mehrere LMS** (z. B. Moodle und Stud.IP, oder mehrere Moodle-Instanzen)
bekommen jeweils eine **eigene Plattform-Zeile** — Issuer/Client-ID sind je
LMS-Instanz eindeutig, das Tool-Endpunkte-Panel bleibt für alle gleich.

## Anleitung für Moodle-Administrator:innen

1. Web-Admin → LTI-Plattformen öffnen und die vier URLs aus dem
   **Tool-Endpunkte-Panel** kopieren (Initiate-Login-, Launch-, Keyset-,
   Icon-URL).
2. In Moodle: Website-Administration → Plugins → Externe Tools →
   „Tools verwalten" → „Tool manuell konfigurieren":
   - Tool-URL: die kopierte **Launch-URL** (`/lti/launch/`)
   - LTI-Version: **LTI 1.3**
   - Public-Key-Typ: **Keyset-URL** → die kopierte **Keyset-URL**
     (`/lti/jwks/`)
   - Initiate-Login-URL: die kopierte **Initiate-Login-URL** (`/lti/login/`)
   - Redirection-URIs: dieselbe Launch-URL
   - **Icon-URL** (bzw. „Sicheres Icon-URL"): die kopierte **Icon-URL**
     (`/lti/icon.svg`) — ein von Abstimmbar ausgeliefertes SVG
     (`image/svg+xml`); alternativ kann hier auch eine eigene Bild-URL
     eingetragen werden, falls z. B. ein anderes Icon gewünscht ist.
   - **„Content-Item-Auswahl unterstützen"** (Deep Linking): aktivieren
   - Standard-Startcontainer: **Neues Fenster** (siehe
     [Cookies & iframes](#cookies--iframes))
   - **Datenschutz** (wichtig für den angezeigten Namen, #57):
     „**Namen der Nutzer/innen an das Tool weitergeben**" und „**E-Mail-Adressen
     der Nutzer/innen an das Tool weitergeben**" auf **„Immer"** stellen.
     Ohne diese Freigabe erhält Abstimmbar keine Namens-/E-Mail-Claims: die
     Person erscheint dann nur als technisches Kürzel `lti-<Plattform>-<sub>`,
     und die E-Mail-Verknüpfung nach
     [Issue #1](#konto-verknüpfung-lti--oidc-issue-1) kann nicht greifen.
3. Speichern — die Deployment-ID vergibt Moodle **erst jetzt**, nicht
   vorher.
4. Unter **„Tools verwalten"** → das gerade angelegte Tool → Menü →
   **„Konfigurationsdetails anzeigen"** zeigt Moodle **Platform ID**
   (= Issuer, wörtlich übernehmen), **Client-ID** und **Deployment-ID**
   gemeinsam an.
5. Diese Werte zusammen mit den drei Moodle-URLs (Auth-Login-,
   Auth-Token-, Keyset-URL — Moodles eigene Standard-Endpunkte, siehe
   oben) im Web-Admin bei der Plattform eintragen und speichern.

## Anleitung für Lehrende

1. Im Moodle-Kurs „Aktivität/Material hinzufügen" → **„Externes Tool"**
   → die von der Administration angelegte Abstimmbar-Verbindung wählen.
2. Über **„Inhalt auswählen"** (Deep Linking) öffnet sich die
   Abstimmbar-Auswahlseite: ein bestehendes **Fragenset wählen** oder ein
   **neues anlegen**.
3. Der erste Launch aus diesem Kurs legt automatisch einen **Raum** an
   (Titel = Kurstitel); die startende Lehrperson wird **Owner** des Raums
   und landet direkt im gewählten Fragenset.

## Verhalten beim Launch

- **Lehrende** (Instructor/Administrator-Rolle): Beim ersten Launch aus
  einem Kurs wird automatisch ein Raum angelegt (Titel = Kurstitel) und
  mit dem Kurs verknüpft; die Lehrperson wird Owner und landet in der
  Verwaltung (bzw. direkt im per Deep Linking gewählten Fragenset).
- **Studierende** (Learner-Rolle): werden ohne Konto auf die anonyme
  Teilnehmer-Seite `/p/<code>/` geleitet — LTI ändert nichts an der
  Anonymität der Stimmabgabe.

## Konto-Verknüpfung LTI ↔ OIDC (Issue #1)

Die LTI-`sub` ist plattform-lokal und stimmt nie mit dem OIDC-Subject
überein — ohne Verknüpfung bekäme dieselbe Lehrperson zwei Konten. Pro
Plattform gibt es dafür die Option **„Nutzende per E-Mail verknüpfen"**
(`link_by_email`, im Web-Admin bei der Plattform, **Standard: aus**; nur für Plattformen aktivieren, die
E-Mail-Änderungen bestätigen): Beim
ersten Launch einer unbekannten LTI-`sub` wird ein bestehendes Konto mit
derselben E-Mail-Adresse wiederverwendet, sofern der Treffer eindeutig ist
(genau ein Konto; sonst wird wie bisher ein neues LTI-Konto angelegt). Die
aufgelöste Zuordnung wird dauerhaft in `LtiUserLink` gespeichert —
spätere E-Mail-Änderungen im LMS können ein einmal verknüpftes Konto
nicht mehr umleiten. Für verknüpfte OIDC-Konten bleibt der IdP die Quelle
für Name/E-Mail; der Launch überschreibt das Profil nicht.

**Sicherheitsabwägung:** Mit der Option wird das LMS zur Autorität für
die Konto-Zuordnung — eine im LMS manipulierte E-Mail-Adresse könnte
sich ein fremdes, noch nicht verknüpftes Konto aneignen. Daher ist die Option
standardmäßig aus und sollte nur für eigene, vertrauenswürdige
Plattformen aktiviert werden, die E-Mail-Änderungen bestätigen (z. B.
Moodle mit E-Mail-Änderungsbestätigung; Adressen aus dem IdM). Andernfalls
könnte eine Lehrperson im LMS, die ihre eigene E-Mail-Adresse ändern kann,
ein nicht verknüpftes Konto übernehmen. Der Web-Admin zeigt
diesen Hinweis auch direkt im Formular an, solange die Option aktiv ist.

## Cookies & iframes

LTI-Tools laufen im LMS oft in einem iframe; Session-Cookies sind dort
Third-Party-Cookies, und ein iframe darf von den meisten Seiten aus
Sicherheitsgründen (`X-Frame-Options: DENY` / CSP `frame-ancestors`)
standardmäßig gar nicht eingebettet werden. Zwei Betriebsvarianten:

1. **„Neues Fenster"** (empfohlen, Moodle: Startcontainer „Neues Fenster")
   — keine weitere Konfiguration nötig, das Tool läuft als eigenständige
   Seite und Cookies sind First-Party.
2. **iframe-Embed** — dafür sind zwei Dinge nötig:
   - `SESSION_COOKIE_SAMESITE=None` (Env-Variable, erzwingt
     Secure-Cookies, also HTTPS) — sonst überlebt das Session-Cookie den
     Third-Party-Kontext nicht.
   - Die LMS-Origin muss framen dürfen. Abstimmbar setzt
     `Content-Security-Policy: frame-ancestors` **automatisch** für die
     **registrierten, aktiven Plattformen** — aber nur auf den von Django
     ausgelieferten Seiten (Teilnehmer-Seite `/p/...` und `/lti/...`). Die
     SPA (Verwaltung/Presenter) wird von **Caddy** ausgeliefert, das die im
     Web-Admin registrierten Plattformen nicht kennt; dafür muss die
     LMS-Origin **einmalig im Caddyfile** eingetragen werden, in der
     `frame-ancestors`-Zeile im SPA-`handle`-Block:
     ```
     header Content-Security-Policy "frame-ancestors 'self' https://moodle.example.org"
     ```
     Ohne registrierte Plattform (Django-Seiten) bzw. ohne Caddyfile-Eintrag
     (SPA) bleibt Framen blockiert (`frame-ancestors 'self'`). Browser mit
     blockierten Third-Party-Cookies können trotz beider Einstellungen noch
     Probleme machen.

## Django-Admin als Fallback

Der Django-Admin (**LTI platforms**) bleibt nutzbar und zeigt zusätzlich
Felder, die der Web-Admin bewusst nicht exponiert (z. B. das
Tool-Schlüsselpaar). Für die alltägliche Registrierung neuer LMS-Instanzen
ist der Web-Admin (siehe oben) der empfohlene Weg — kein Server-Zugriff
nötig, direkt aus der Verwaltungsoberfläche.

## Stud.IP

Die Anbindung setzt einen LTI-1.3-Consumer in Stud.IP voraus (Roadmap M4:
gegen das Uni-Stud.IP testen, sobald dessen LTI-1.3-Unterstützung steht).
Die Registrierung folgt demselben Muster wie bei Moodle: die Angaben aus
dem Tool-Endpunkte-Panel im Web-Admin eintragen und die von Stud.IP
zurückgelieferten Werte (Client-ID, Deployment-ID) ergänzen.
