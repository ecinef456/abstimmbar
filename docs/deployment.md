# Produktiv-Deployment

Abstimmbar läuft produktiv als Docker-Compose-Stack nach dem Vorbild von
AusleihBar: **PostgreSQL + Django (uvicorn/ASGI) + Caddy** als
TLS-terminierender Reverse Proxy. Kein Keycloak im Stack — OIDC zeigt auf
den institutionellen IdP.

```
Browser ── https ──> Caddy ──> /api, /admin, /oidc, /lti, /p → uvicorn (Django)
                        │        /static, /media → Volumes (file_server)
                        │        alles andere     → SPA-Build (Volume frontend_data)
                        └── automatisches TLS (Let's Encrypt) oder eigene Zertifikate
```

Das `app`-Image (Dockerfile im Repo-Root) bringt die fertig gebaute SPA
bereits mit (mehrstufiger Build: Node baut das Frontend, die Stufe danach
enthält Django) — beim Start kopiert der Container sie ins Volume
`frontend_data`, aus dem Caddy sie direkt ausliefert. Ein separater
Frontend-Build-Schritt auf dem Host entfällt dadurch.

Der erste Teil ist eine **vollständige Schritt-für-Schritt-Anleitung für
Rocky Linux 9**, dem folgen Keycloak-/LTI-Konfiguration, Betriebshinweise,
Alltagskommandos, Updates, Zertifikate und Backup.

---

## Installation auf Rocky Linux 9 — Schritt für Schritt

Eine komplette Anleitung für einen frischen **Rocky-Linux-9-Server**, so
geschrieben, dass sie ohne Linux-Vorerfahrung nachvollziehbar ist. Kopieren
Sie jeden Befehl exakt.

**Wie es zusammenspielt (einmal lesen):** Auf dem Server wird nur eine
Sache installiert — **Docker**. Docker lädt und betreibt alle Bausteine als
*Container*: die Datenbank (**PostgreSQL**), die Anwendung (**Django**) und
den Webserver mit HTTPS (**Caddy**). PostgreSQL und Caddy werden **nicht**
von Hand installiert, und Caddy besorgt sich das HTTPS-Zertifikat von
Let's Encrypt automatisch. Alles ist unter einer Adresse erreichbar, z. B.
`https://abstimmbar.example.org` — Teilnehmende nutzen
`https://abstimmbar.example.org/p/` bzw. den QR-Code aus dem
Präsentationsmodus.

**Vorher benötigt:**

- Ein Server mit Rocky Linux 9 und ein Benutzer mit `sudo`-Rechten (oder
  `root` — dann das `sudo` vor den Befehlen weglassen).
- Ein **Domainname** (z. B. `abstimmbar.example.org`), für den Sie einen
  DNS-Eintrag anlegen können. HTTPS braucht eine echte Domain.
- Die **öffentliche IP-Adresse** des Servers.
- Ein **OIDC-Client** im institutionellen Keycloak (Details unten; kann
  auch nachgereicht werden, der Stack startet ohne funktionierenden Login).

> Notation: Zeilen mit `sudo` werden im Terminal des Servers ausgeführt.
> Im Editor `nano` speichern Sie mit **Strg+O**, **Enter** und verlassen ihn
> mit **Strg+X**.

### Schritt 1 — Am Server anmelden

Vom eigenen Rechner aus:

```bash
ssh BENUTZER@SERVER-IP            # z. B. ssh admin@203.0.113.10
```

### Schritt 2 — System aktualisieren und Grundwerkzeuge installieren

```bash
sudo dnf -y update
sudo dnf -y install git nano dnf-plugins-core
```

Hat `dnf update` einen neuen Kernel installiert (typisch bei einer frischen
VM), dann **jetzt einmal neu starten**, damit der neue Kernel samt passender
Module läuft — sonst kann Docker in Schritt 3 seine Netzwerk-Regeln nicht
setzen (siehe [Troubleshooting](#troubleshooting)):

```bash
sudo reboot
```

### Schritt 3 — Docker installieren

```bash
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo docker --version            # gibt eine Version aus → Docker läuft
```

(Optional, um das `sudo` vor `docker` loszuwerden:
`sudo usermod -aG docker $USER`, dann ab- und wieder anmelden. Diese
Anleitung behält `sudo` bei, damit sie so oder so funktioniert.)

### Schritt 4 — Firewall für Web-Verkehr öffnen

Caddy braucht Port **80** (für das Zertifikat und die Umleitung auf HTTPS)
und **443** (HTTPS).

Rocky nutzt **firewalld**; bei einer Minimalinstallation fehlt es unter
Umständen. Erst installieren/aktivieren (ohne Wirkung, falls schon da):

```bash
sudo dnf -y install firewalld
sudo systemctl enable --now firewalld
```

Dann die beiden Web-Ports öffnen und neu laden:

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --list-services      # muss 'http' und 'https' enthalten
```

> **Hinweis:** Manche Server (v. a. Cloud-/Rechenzentrums-VMs) haben keine
> Host-Firewall, sondern filtern über eine externe **Security Group /
> Netz-Firewall**. Wenn `firewall-cmd` trotz der Schritte oben
> `FirewallD is not running` meldet — oder Sie bewusst kein firewalld
> nutzen — überspringen Sie diesen Schritt und lassen Sie stattdessen die
> Ports **80** und **443** in der externen Firewall freischalten.

### Schritt 5 — Domain auf den Server zeigen lassen (DNS)

Beim DNS-Verantwortlichen (an der Uni: das Rechenzentrum) einen
**A-Record** der Domain auf die öffentliche IP des Servers anlegen lassen
(und einen **AAAA-Record**, falls IPv6 vorhanden). Danach vom Server aus
prüfen:

```bash
sudo dnf -y install bind-utils        # liefert den Befehl 'dig'
dig +short abstimmbar.example.org     # muss die IP des Servers ausgeben
```

Nicht weitermachen, bevor hier die richtige IP erscheint — Let's Encrypt
prüft genau das.

### Schritt 6 — Anwendung herunterladen

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone git@gitlab.uni-osnabrueck.de:virtuos/digitale-dienste/abstimmbar.git
cd abstimmbar
```

(Für das interne Repo braucht der Server einen SSH-Key mit Lesezugriff
oder Sie nutzen die HTTPS-URL mit Zugangsdaten.)

### Schritt 7 — Konfigurationsdatei anlegen

```bash
sudo cp .env.prod.example .env
openssl rand -base64 48              # Ausgabe kopieren — das wird der Secret Key
sudo nano .env
```

In `nano` mindestens diese Werte setzen (jedes `...` und die
Beispiel-Domain ersetzen; den eben erzeugten Secret Key einfügen):

```dotenv
# Öffentliche Adresse der Instanz (zweimal derselbe Wert)
PUBLIC_BASE_URL=https://abstimmbar.example.org
CSRF_TRUSTED_ORIGINS=https://abstimmbar.example.org

# Django
DJANGO_SECRET_KEY=HIER-DEN-ERZEUGTEN-SECRET-KEY-EINFUEGEN
DJANGO_ALLOWED_HOSTS=abstimmbar.example.org

# Datenbank — ein langes Zufallspasswort wählen (z. B. openssl rand -base64 24)
POSTGRES_PASSWORD=hier-ein-starkes-passwort

# Login (OIDC) — institutioneller Keycloak. OIDC_OP_ISSUER genügt, die
# Endpunkte kommen per Discovery; Details im Abschnitt "Keycloak-Client".
OIDC_RP_CLIENT_ID=abstimmbar
OIDC_RP_CLIENT_SECRET=...
OIDC_OP_ISSUER=https://sso.example.org/realms/example
# Mitglieder dieser IdP-Gruppe bekommen beim Login Django-Admin (leer = aus).
OIDC_ADMIN_GROUP=abstimmbar-admins
```

Speichern mit **Strg+O**, **Enter**, beenden mit **Strg+X**.

### Schritt 8 — Webserver (Caddy) konfigurieren

**Wie Caddy installiert wird:** gar nicht per `dnf` — Caddy läuft als
Docker-Container aus dem offiziellen `caddy:2`-Image, das Docker beim
Start des Stacks (Schritt 10) automatisch lädt. Definiert ist es in
`docker-compose.prod.yml` (Service `caddy`); dort öffnet es die Ports
80/443 und legt seine Zertifikate im Volume `caddy_data` ab.

**Wo die Konfiguration liegt:** in der Datei `Caddyfile` im Projektordner,
also `/opt/abstimmbar/Caddyfile`. Das Compose-File hängt sie **read-only in
den Container** — Sie bearbeiten sie auf dem Host, nichts muss kopiert
werden.

Zwei Dinge ändern: die Domain in der Zeile `abstimmbar.example.org {` und
die `email`-Adresse oben (Let's Encrypt schickt dorthin Ablauf-Hinweise):

```bash
cd /opt/abstimmbar
sudo nano Caddyfile
```

Zertifikate richten Sie **nicht** von Hand ein — Caddy besorgt und
erneuert das Let's-Encrypt-Zertifikat automatisch, sobald Domain und Ports
stimmen. Spätere Änderungen am Caddyfile übernehmen Sie mit
`sudo docker compose -f docker-compose.prod.yml restart caddy`.

### Schritt 9 — Dateien für SELinux freigeben

Rocky Linux hat SELinux aktiviert; ohne Label darf ein Container keine vom
Host gemounteten Dateien lesen. Den Pfad freigeben, den Caddy liest
(`frontend/dist` gibt es nicht mehr — die SPA liegt jetzt in einem
Docker-Volume, das keine Host-Freigabe braucht):

```bash
sudo chcon -Rt container_file_t Caddyfile
```

### Schritt 10 — Alles starten

Entweder aus dem Quellcode bauen (Node baut die SPA, Django-Image
entsteht direkt danach — kein separater Frontend-Build-Schritt mehr
nötig):

```bash
sudo docker compose -f docker-compose.prod.yml up -d --build
```

… oder ein veröffentlichtes Release-Image laden (kein lokaler Build nötig,
schneller; `ABSTIMMBAR_VERSION` z. B. `v1.2.0` in der `.env` setzen, sonst
wird `latest` verwendet):

```bash
sudo docker compose -f docker-compose.prod.yml pull
sudo docker compose -f docker-compose.prod.yml up -d
```

Das lädt PostgreSQL und Caddy, führt die Datenbank-Migrationen aus und
startet alle Dienste. Caddy holt das HTTPS-Zertifikat (dauert bis zu einer
Minute). Logs beobachten:

```bash
sudo docker compose -f docker-compose.prod.yml logs -f      # Strg+C beendet die Anzeige
```

Danach `https://abstimmbar.example.org` im Browser öffnen — die
Startseite der Verwaltung erscheint; `https://abstimmbar.example.org/p/`
zeigt die Code-Eingabe für Teilnehmende.

### Schritt 11 — Erstes Admin-Konto anlegen

Ein lokales Break-Glass-Konto, unabhängig vom IdP (nützlich, falls OIDC
mal nicht erreichbar ist):

```bash
sudo docker compose -f docker-compose.prod.yml exec app python manage.py createsuperuser
```

Den Eingaben folgen (Benutzername, E-Mail, Passwort); Login danach unter
`https://abstimmbar.example.org/admin/`. Lehrende melden sich regulär per
Uni-Login (OIDC) auf der Startseite an; Mitglieder der Gruppe aus
`OIDC_ADMIN_GROUP` bekommen dabei automatisch Django-Admin-Rechte.

### Übersteht das einen Server-Neustart?

Ja — das Setup ist reboot-sicher:

- Docker startet beim Boot (`systemctl enable docker`, Schritt 3).
- Alle Dienste haben `restart: unless-stopped` — Datenbank, Backend und
  Caddy kommen nach einem Reboot von selbst wieder hoch (außer Sie haben
  den Stack bewusst mit `… down` gestoppt).
- Alle Daten liegen in persistenten Volumes: Datenbank (`postgres_data`),
  hochgeladene Bilder (`media_data`), Zertifikate (`caddy_data`). Beim
  Start laufen Migrationen und `collectstatic` automatisch erneut.
- Die Firewall-Regeln wurden mit `--permanent` gespeichert (Schritt 4).

Prüfen:

```bash
sudo reboot
# nach dem Neustart wieder anmelden, dann:
cd /opt/abstimmbar
sudo docker compose -f docker-compose.prod.yml ps     # alle Dienste "running"
```

---

## Keycloak-Client (institutioneller IdP)

Client-Einstellungen (Confidential Client, Standard Flow):

- **Redirect URI:** `https://<domain>/oidc/callback/`
- **Post-Logout-Redirect URI:** `https://<domain>/`
- **Backchannel-Logout-URL:** `https://<domain>/oidc/backchannel-logout/`
- Group-Membership-Mapper auf den Claim `groups` (für `OIDC_ADMIN_GROUP`)

In `.env` reicht `OIDC_OP_ISSUER` (Endpunkte kommen per Discovery);
abweichende Endpunkte lassen sich per `OIDC_OP_*` explizit setzen.

## LTI (Moodle/Stud.IP)

Registrierung der LMS-Plattformen wie in [lti.md](lti.md) beschrieben; die
Tool-Endpunkte liegen unter `https://<domain>/lti/…`. Empfohlen ist der
Start im **neuen Fenster**. Nur für iframe-Betrieb in `.env`
`SESSION_COOKIE_SAMESITE=None` setzen (erzwingt Secure-Cookies).

## Monitoring (Prometheus/Grafana)

Die Nutzungskennzahlen der Admin-Statistik stehen optional unter
`https://<domain>/metrics` für Prometheus bereit (aus, solange
`METRICS_TOKEN` nicht gesetzt ist). Einrichtung, Kennzahlen und
Beispielabfragen: [monitoring.md](monitoring.md).

## Betriebshinweise

- **Ein Backend-Prozess, kein Scale-out:** Der SSE-Hub (ADR-0003) lebt im
  Prozessspeicher. Mehrere uvicorn-Worker oder Replikas würden die
  Verbindungen aufteilen — Stimmen aus Worker A kämen nie bei Geräten an,
  die mit Worker B verbunden sind. Ein Prozess trägt ≥1000 Teilnehmende
  (Lasttest `scripts/loadtest.py`); mehr braucht erst einen externen
  Broker (z. B. Redis Pub/Sub) — bewusst aufgeschoben.
- **Dateideskriptoren:** SSE hält pro Teilnehmergerät einen Socket offen;
  das Compose-File setzt `nofile` auf 65536.
- **Graceful Shutdown:** `--timeout-graceful-shutdown 5` ist gesetzt, weil
  offene SSE-Streams nie von selbst enden — ohne das Flag hinge jeder
  Neustart.
- **DB-Verbindungen:** Der psycopg-Pool (settings.py) deckelt bei 20
  Verbindungen; PostgreSQLs Default (100) braucht keine Anpassung.
- **Modus-Statistik (Datenschutz):** Für die Kennzahl „Sitzungen pro Tag
  nach Easy/Pro-Modus“ legt `whoami` je Sitzung und Tag eine Zeile in
  `DailyModeSession` an — gespeichert wird nur ein SHA-256-Hash des
  Session-Keys (nie der rohe Key), passend zur Anonymitäts-Zusage. Die
  Tabelle wächst dadurch pro Tag um grob eine Zeile je aktiver Sitzung;
  siehe „Retention“ unten.
- **Rundgang-Statistik (Datenschutz):** Starts, Abschlüsse und Abbrüche des
  Rundgangs werden nur als Tageszähler in `TourDailyCount` erfasst (Tag,
  Modus, Startquelle bzw. Abbruchschritt, Anzahl) — ohne Personen- oder
  Sitzungsbezug und ohne Zeitstempel. Die Tabelle bleibt klein (wenige
  Zeilen pro Tag). Beispielräume zählen nicht in die Nutzungszahlen.

## Retention der Modus-Statistik

Die Tabelle `DailyModeSession` wächst kontinuierlich. Ein
Management-Command löscht Zeilen, die älter als N Tage sind (Default 400,
also gut ein akademisches Jahr Vorlauf):

```bash
cd /opt/abstimmbar
P="sudo docker compose -f docker-compose.prod.yml"
$P exec app python manage.py prune_mode_sessions            # Default: 400 Tage
$P exec app python manage.py prune_mode_sessions --days 180 # kürzeres Fenster
```

Empfohlen als wöchentlicher Cron-Job auf dem Host, z. B. in
`/etc/cron.d/abstimmbar-prune` (Sonntag 03:30):

```cron
30 3 * * 0 root cd /opt/abstimmbar && docker compose -f docker-compose.prod.yml exec -T app python manage.py prune_mode_sessions >/dev/null 2>&1
```

Der Job ist optional — er hält nur die Tabelle klein; ohne ihn bleibt die
Anwendung funktionsfähig, sammelt aber unbegrenzt (gehashte) Zeilen.

## Alltagskommandos

Alle im Ordner `/opt/abstimmbar` ausführen:

```bash
P="sudo docker compose -f docker-compose.prod.yml"
$P ps                 # was läuft
$P logs -f            # Live-Logs (Strg+C beendet)
$P restart            # Anwendung neu starten
$P down               # alles stoppen
$P up -d --build      # starten / Änderungen übernehmen
```

Einen periodischen Job gibt es: die optionale Retention der
Modus-Statistik (siehe Abschnitt „Retention der Modus-Statistik“). Sonst
braucht Abstimmbar keine geplanten Wartungsaufgaben.

## Updates einspielen

Aus dem Quellcode bauen:

```bash
cd /opt/abstimmbar
sudo git pull
sudo docker compose -f docker-compose.prod.yml up -d --build    # Build + Migrationen + Neustart automatisch
```

Oder ein veröffentlichtes Release-Image einspielen (kein lokaler Build,
`ABSTIMMBAR_VERSION` in der `.env` auf die gewünschte Version setzen, z. B.
`v1.3.0`):

```bash
cd /opt/abstimmbar
sudo docker compose -f docker-compose.prod.yml pull
sudo docker compose -f docker-compose.prod.yml up -d             # Migrationen + Neustart automatisch
```

### Neue Konfigurations-Variable? An drei Stellen nachziehen

`docker-compose.prod.yml` nutzt **kein `env_file`** — jede Variable wird
einzeln unter `environment:` mit `${VAR}` durchgereicht. Eine Variable, die
nur in der `.env` steht, aber **nicht** im `environment:`-Block, erreicht den
Container nie. Bringt ein Update also eine neue Einstellung mit, an drei
Stellen ergänzen:

1. **`docker-compose.prod.yml`** → `environment:` des `app`-Service
   (die leicht vergessene Stelle),
2. **`.env.prod.example`** (Doku),
3. die echte **`.env`** auf dem Server, dann `up -d app`.

**`VITE_API_BASE_URL`** ist ein Sonderfall und im Normalfall **nicht
nötig**: die SPA nutzt standardmäßig relative URLs (gleicher Origin wie die
API, hinter Caddy). Nur für einen bewusst abweichenden Aufbau (SPA und API
auf unterschiedlichen Origins) setzen. Vite backt den Wert dann **zur
Buildzeit** fest ins Bundle — das funktioniert nur, wenn Sie selbst bauen
(`up -d --build`); ein veröffentlichtes Release-Image wurde bereits mit dem
Standardwert gebaut und lässt sich nicht nachträglich umkonfigurieren.

**`VITE_GUIDE_URL`** (optional) ist das Ziel des Menüpunkts „Anleitung“ im
„?“-Menü der App bei deutscher Oberfläche; Standard ist die öffentliche
Projekt-Website (`https://virtuos.github.io/abstimmbar/anleitung/`).
**`VITE_GUIDE_URL_EN`** (optional) ist dasselbe für die englische Oberfläche
(Standard `https://virtuos.github.io/abstimmbar/en/guide/`). Wie
`VITE_API_BASE_URL` werden beide Werte zur **Buildzeit** festgelegt
(Build-Argumente im `app`-Service, nur mit `up -d --build` wirksam).

Gegenprüfen, was im laufenden Container ankommt:

```bash
sudo docker compose -f docker-compose.prod.yml exec app env \
  | grep -oE "^(DJANGO_|OIDC_|POSTGRES_|AI_|CSRF|FRONTEND|SESSION)[A-Z_]*" | sort
```

## HTTPS-Zertifikate (Caddy), im Klartext

- Caddy besorgt und **erneuert automatisch** ein kostenloses
  Let's-Encrypt-Zertifikat für die Domain im `Caddyfile`. Nichts von Hand
  zu tun. Voraussetzungen: Ports **80 und 443** aus dem Internet
  erreichbar, korrektes **DNS** (Schritt 5) und eine gültige `email` im
  `Caddyfile`.
- Die Zertifikate liegen im Docker-Volume `caddy_data` — **mitsichern**,
  damit sie einen Neuaufbau überleben (sonst stellt Caddy sie einfach neu
  aus, was aber den Let's-Encrypt-Rate-Limits unterliegt).
- Keine öffentliche Domain (rein interner Host)? Im `Caddyfile` innerhalb
  des Site-Blocks die Zeile `tls internal` ergänzen — Caddy nutzt dann
  seine eigene lokale CA statt Let's Encrypt.

### Eigenes Zertifikat (z. B. HARICA) statt Let's Encrypt

Wenn die Hochschule das Zertifikat ausstellt (HARICA, DFN, interne CA …),
zeigt Caddy auf die Dateien statt auf automatisches HTTPS:

1. Die beiden PEM-Dateien auf dem Host ablegen, außerhalb des Repos, damit
   der **private Schlüssel nie committet wird**, z. B. unter
   `/etc/abstimmbar/certs/`:
   - `abstimmbar.pem` — Serverzertifikat **mit Zwischenzertifikat(en)**
     (Leaf zuerst, dann die CA-Kette), PEM-Format.
   - `abstimmbar.key` — der passende **private Schlüssel**, PEM, **ohne
     Passphrase** (Caddy kann keine abfragen).
2. Das Verzeichnis in den Caddy-Container mounten —
   `docker-compose.prod.yml` enthält die (auskommentierte) Zeile dafür:
   ```yaml
   - /etc/abstimmbar/certs:/etc/caddy/certs:ro
   ```
3. Im `Caddyfile`-Site-Block das automatische Verhalten durch eine
   `tls`-Zeile mit den **Container**-Pfaden ersetzen (Zertifikat zuerst,
   dann Schlüssel):
   ```
   tls /etc/caddy/certs/abstimmbar.pem /etc/caddy/certs/abstimmbar.key
   ```
4. Das Verzeichnis für SELinux labeln (Rocky), damit der Container lesen
   darf:
   ```bash
   sudo chcon -Rt container_file_t /etc/abstimmbar/certs
   ```
5. Übernehmen mit `sudo docker compose -f docker-compose.prod.yml up -d`
   (oder `restart caddy`). Die Erneuerung ist in diesem Modus **manuell**:
   Dateien vor Ablauf ersetzen, dann `restart caddy`. Die globale `email`
   wird dabei nicht genutzt.

## Backup

Die Daten liegen in den Volumes `postgres_data` (Datenbank) und
`media_data` (hochgeladene Bilder); `caddy_data` (Zertifikate) ist
verzichtbar, erspart aber Neuausstellungen:

```bash
cd /opt/abstimmbar
sudo docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U abstimmbar abstimmbar | gzip > abstimmbar-$(date +%F).sql.gz
sudo docker run --rm -v abstimmbar_media_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/abstimmbar-media-$(date +%F).tar.gz -C /data .
```

Die Dumps regelmäßig (z. B. per Cron) erzeugen und auf ein anderes System
kopieren.

## Troubleshooting

### Docker startet nicht: fehlende Netfilter-Kernel-Module

**Symptom.** `sudo systemctl enable --now docker` schlägt fehl; in
`sudo journalctl -u docker --no-pager` stehen Zeilen wie:

```
iptables ... -m addrtype ... Warning: Extension addrtype revision 0 not supported, missing kernel module?
iptables ... RULE_APPEND failed (No such file or directory)
failed to start daemon: Error initializing network controller ...
```

**Ursache.** Docker legt beim Start seine NAT-Regeln an und braucht dafür
Kernel-Module wie `xt_addrtype`, `br_netfilter` und `nf_nat`. Auf
Minimal- oder Cloud-Images (z. B. OpenStack/Nova) fehlt oft das Paket
`kernel-modules`, oder `dnf update` (Schritt 2) hat einen neuen Kernel
installiert, ohne dass neu gebootet wurde — dann passt das laufende
Kernel-Verzeichnis nicht zu den vorhandenen Modulen.

**Prüfen.** Bestätigt die Diagnose, wenn hier „Module not found" erscheint:

```bash
sudo modprobe xt_addrtype
```

**Beheben.** Passende Kernel-Module nachinstallieren und neu starten (der
Reboot bringt zugleich den nach dem Update aktuellen Kernel ans Laufen):

```bash
sudo dnf -y install "kernel-modules-$(uname -r)" iptables-nft
sudo reboot
```

Nach dem Reboot die fehlgeschlagene Startsperre lösen und Docker starten:

```bash
sudo systemctl reset-failed docker.service
sudo systemctl enable --now docker
sudo docker run --rm hello-world      # muss "Hello from Docker!" ausgeben
```

Meldet `dnf`, `kernel-modules-$(uname -r)` sei bereits installiert oder es
gebe keinen Treffer, liegt es rein am Kernel/Modul-Versatz nach dem Update —
dann genügt der **Reboot** allein (das `dnf install` überspringen).

### Kein HTTPS: `ERR_SSL_PROTOCOL_ERROR` / Let's-Encrypt-Timeout (Firewall)

**Symptom.** Der Browser meldet `ERR_SSL_PROTOCOL_ERROR`, und in den
Caddy-Logs scheitert die Zertifikatsausstellung:

```bash
sudo docker compose -f docker-compose.prod.yml logs caddy | grep -iE "challenge|obtain|error"
```
```
challenge failed ... "detail":"<IP>: Timeout during connect (likely firewall problem)"
could not get certificate from issuer ... acme:error:connection
```

**Ursache.** Let's Encrypt validiert per `http-01` (eingehend Port 80) bzw.
`tls-alpn-01` (eingehend Port 443). Beide Challenges müssen den Server **aus
dem öffentlichen Internet** erreichen. Kommt das Timeout, ist eingehend
80/443 geblockt. Ohne Zertifikat kann Caddy auf 443 kein gültiges TLS
ausliefern → `ERR_SSL_PROTOCOL_ERROR`. Auf OpenStack-VMs gibt es dafür
**zwei** mögliche Sperren: die **Security-Group** der Instanz (Standard
lässt oft nur SSH/22 zu) und den **Perimeter-Firewall** des Rechenzentrums.

**Prüfen.** DNS zeigt auf eine öffentliche IP (`dig +short <domain>`), die
Ports lauschen lokal (`sudo ss -tlnp | grep -E ':80|:443'`) — aber ein Test
von außerhalb des Uni-Netzes (z. B. Handy im Mobilfunknetz) läuft ins Leere.

**Beheben.**
1. **Security-Group** öffnen (in Horizon: Netzwerk → Sicherheitsgruppen →
   Regel hinzufügen — Ingress TCP 80 und 443 aus `0.0.0.0/0`; optional
   UDP 443 für HTTP/3), oder per CLI:
   ```bash
   openstack security group rule create --proto tcp --dst-port 80  --remote-ip 0.0.0.0/0 <sg>
   openstack security group rule create --proto tcp --dst-port 443 --remote-ip 0.0.0.0/0 <sg>
   ```
2. Bleibt es zu, den **Perimeter-Firewall** durch das Netz-Team eingehend
   für TCP 80+443 auf die Server-IP freigeben lassen.
3. Danach einen frischen Versuch anstoßen und mitlesen:
   ```bash
   sudo docker compose -f docker-compose.prod.yml restart caddy
   sudo docker compose -f docker-compose.prod.yml logs -f caddy | grep -iE "obtain|certificate|error"
   ```
   Erfolg: `certificate obtained successfully`.

> Hinweis: Wiederholte Fehlversuche zählen auf Let's Encrypts Limit
> „5 fehlgeschlagene Validierungen pro Konto/Hostname/Stunde". Erst die
> Freigabe klären, dann neu starten — nicht in Schleife, solange 80/443
> noch dicht sind. Bei `rateLimited` ~1 Stunde warten.
>
> Kann der Dienst gar nicht öffentlich erreichbar sein, ist statt Let's
> Encrypt ein **HARICA-Zertifikat** der Weg (siehe unten) — es braucht
> keinen eingehenden Internet-Zugriff.

## Sicherheits-Checkliste

- [ ] `DJANGO_DEBUG` ist im Prod-Compose fest auf `0`; starker
      `DJANGO_SECRET_KEY`; echtes `DJANGO_ALLOWED_HOSTS`.
- [ ] `PUBLIC_BASE_URL` und `CSRF_TRUSTED_ORIGINS` zeigen auf die echte
      `https://`-Domain (`VITE_API_BASE_URL` nur bei bewusst abweichendem
      Aufbau, siehe „Neue Konfigurations-Variable?").
- [ ] Starkes `POSTGRES_PASSWORD`; alle Geheimnisse nur in `.env` (wird
      nie committet).
- [ ] OIDC zeigt auf den institutionellen IdP; `/oidc/callback/` und die
      Backchannel-Logout-URL sind dort registriert.
- [ ] Regelmäßige Backups von `postgres_data` und `media_data`.
- [ ] Nur die Ports 80/443 sind offen; die Services `db` und `app` sind
      nicht veröffentlicht (`expose` statt `ports`).
- [ ] Einmal geprüft, dass der Stack nach `sudo reboot` von selbst
      wiederkommt.
