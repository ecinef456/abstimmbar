<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Universität Osnabrück (virtUOS)

Anleitung für Betrieb/Monitoring: Prometheus-Endpoint und Grafana.
Bei neuen Kennzahlen (common/stats.py, common/views.py render_prometheus)
die Tabelle unten mitpflegen.
-->

# Monitoring mit Prometheus und Grafana

AbstimmBar stellt seine Nutzungskennzahlen — dieselben Zahlen wie die
Statistikseite im Admin-Bereich — zusätzlich als **Prometheus-Endpoint**
bereit. So lassen sie sich in einem vorhandenen Prometheus sammeln und in
Grafana als Zeitreihe darstellen, alarmieren oder mit anderen Diensten
vergleichen.

Diese Anleitung richtet sich an die Betreuung des Servers. Die Grundinstallation
beschreibt [`deployment.md`](deployment.md).

## Überblick

| | |
|---|---|
| **URL** | `https://<ihre-domain>/metrics` (bewusst außerhalb von `/api/`) |
| **Format** | Prometheus-Textformat (`text/plain; version=0.0.4`) |
| **Schutz** | Bearer-Token: Header `Authorization: Bearer <METRICS_TOKEN>` |
| **Standard** | **aus** — ohne gesetztes `METRICS_TOKEN` antwortet der Endpoint mit `404` |
| **Falsches Token** | `401` |
| **Inhalt** | nur aggregierte, anonyme Zählwerte — keine Personen-, Sitzungs- oder Abstimmungsdaten einzelner Teilnehmender |

## 1. Endpoint aktivieren

1. Ein langes Zufalls-Token erzeugen:

   ```bash
   openssl rand -hex 32
   ```

2. In der `.env.prod` auf dem Server eintragen (die Vorlage
   `.env.prod.example` enthält die Zeile bereits auskommentiert):

   ```bash
   METRICS_TOKEN=<das erzeugte Token>
   ```

   `docker-compose.prod.yml` reicht die Variable schon an den `app`-Container
   durch — dort ist nichts weiter zu tun.

3. Den App-Container neu erstellen, damit er die Variable übernimmt:

   ```bash
   cd /opt/abstimmbar
   sudo docker compose -f docker-compose.prod.yml up -d app
   ```

4. Die Caddy-Konfiguration muss `/metrics` an die App weiterleiten. Das
   mitgelieferte `Caddyfile` enthält dafür den Block

   ```caddy
   handle /metrics {
   	reverse_proxy app:8000
   }
   ```

   Ist der Checkout auf dem Server älter, holt `git pull` den Block (siehe
   [`deployment.md`](deployment.md), „Bestehende Installation
   aktualisieren“); bei einem eigenen Reverse-Proxy ergänzen Sie die
   Weiterleitung dort. Danach Caddy neu laden:

   ```bash
   sudo docker compose -f docker-compose.prod.yml restart caddy
   ```

   Fehlt der Block, liefert `/metrics` die Startseite der Web-App (HTML) statt
   der Kennzahlen, und Prometheus meldet einen Parse-Fehler.

5. Testen:

   ```bash
   curl -s -H "Authorization: Bearer <token>" https://<ihre-domain>/metrics | head
   ```

   Erwartet wird Text wie `# TYPE abstimmbar_rooms gauge` und
   `abstimmbar_rooms 42`. Ohne Header muss `401` kommen:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<ihre-domain>/metrics
   ```

### Optional: Zugriff zusätzlich auf den Prometheus-Server beschränken

Das Token schützt den Endpoint bereits. Wer ihn zusätzlich nur für die
IP-Adresse des Prometheus-Servers öffnen möchte, ersetzt den Block im
`Caddyfile` durch (eine bewusste lokale Änderung — bei Updates mit
`git stash && git pull && git stash pop` mitnehmen, siehe
[`deployment.md`](deployment.md)):

```caddy
handle /metrics {
	@not_prometheus not remote_ip 192.0.2.10/32
	respond @not_prometheus 403
	reverse_proxy app:8000
}
```

(`192.0.2.10` durch die Adresse des Prometheus-Servers ersetzen.)

## 2. Prometheus konfigurieren

Beispiel für `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: abstimmbar
    scheme: https
    metrics_path: /metrics
    scrape_interval: 5m        # die Werte ändern sich langsam; 1–5 min genügen
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/abstimmbar.token   # enthält nur das Token
    static_configs:
      - targets: ["abstimmbar.example.org"]
```

Hinweise:

- Das Token besser per `credentials_file` statt direkt in der YAML hinterlegen
  (Datei nur für den Prometheus-Benutzer lesbar).
- Jeder Abruf zählt die Werte frisch aus der Datenbank. Ein Intervall im
  Minutenbereich ist daher sinnvoll; sekundengenaues Scrapen bringt nichts.
- Nach Änderung Prometheus neu laden und unter *Status → Targets* prüfen, dass
  das Ziel `UP` ist.

## 3. Die Kennzahlen

Alle Werte sind **Gauges** mit dem **aktuellen Gesamtstand** (seit Beginn).
Ausnahme: `abstimmbar_sessions_today` bezieht sich nur auf den heutigen Tag.
Da Inhalte gelöscht werden können, dürfen Werte auch sinken.

| Kennzahl | Labels | Bedeutung |
|---|---|---|
| `abstimmbar_rooms` | — | Räume insgesamt |
| `abstimmbar_rooms_lti` | — | davon mit einer LMS-Verknüpfung (LTI) |
| `abstimmbar_users` | — | registrierte Konten (Lehrende/Admins) |
| `abstimmbar_question_sets` | `type` | Fragensets je Typ |
| `abstimmbar_questions` | `kind` | Fragen je Fragetyp |
| `abstimmbar_runs` | `type` | Durchführungen (präsentierte Sets) je Set-Typ |
| `abstimmbar_participants` | — | verschiedene Teilnehmende, die abgestimmt haben |
| `abstimmbar_questions_run` | — | verschiedene durchgeführte Fragen (Frage × Durchführung mit Stimmen) |
| `abstimmbar_tour_events` | `kind`, `mode` | Rundgang gestartet / abgeschlossen / abgebrochen je Modus |
| `abstimmbar_tour_starts` | `source` | Rundgang-Starts je Quelle |
| `abstimmbar_tour_users_seen` | — | Konten, die den Rundgang gestartet oder weggeklickt haben |
| `abstimmbar_sessions_today` | `mode` | aktive Sitzungen heute je Modus |

Label-Werte:

- `type`: `live_poll` (Live-Umfrage), `self_paced` (Quiz-Block),
  `self_check` (Lernkontrolle)
- `kind`: `single_choice`, `multiple_choice`, `likert`, `word_cloud`,
  `open_text`, `priorities`, `ordering`
- `mode`: `easy` (Einfach), `pro` (Experte)
- `kind` bei `abstimmbar_tour_events`: `started`, `completed`, `aborted`
- `source`: `welcome` (Willkommensdialog beim ersten Login), `help` (?-Menü)

**Beispielräume:** Jede neue Person erhält einen automatisch angelegten
Beispielraum mit erfundenen Beispielergebnissen. Diese Beispielräume sind aus
den **Nutzungszahlen** (`abstimmbar_runs`, `abstimmbar_participants`,
`abstimmbar_questions_run`) herausgerechnet, zählen aber bei den angelegten
Inhalten (`abstimmbar_rooms`, `abstimmbar_question_sets`,
`abstimmbar_questions`) mit — dort steigt der Wert pro neuer Person um einen
Raum, ein Set und sieben Fragen.

## 4. Nützliche Abfragen (PromQL)

```promql
# Durchführungen in den letzten 7 Tagen, je Set-Typ
increase(abstimmbar_runs[7d])

# Neue Teilnehmende pro Tag
delta(abstimmbar_participants[1d])

# Anteil der LTI-Räume
abstimmbar_rooms_lti / abstimmbar_rooms

# Abschlussquote des Rundgangs (gesamt)
sum(abstimmbar_tour_events{kind="completed"}) / sum(abstimmbar_tour_events{kind="started"})

# Verteilung Einfach/Experte heute
abstimmbar_sessions_today
```

`increase()` ist für Gauges nur bedingt geeignet (bei sinkenden Werten, z. B.
nach Löschungen, entstehen Sprünge); für Übersichten reicht es. Für exakte
Tageswerte bietet die Statistikseite im Admin-Bereich die Zeitreihen
direkt aus der Datenbank.

## 5. Grafana

1. Prometheus als Datenquelle anlegen (falls noch nicht vorhanden).
2. Ein Dashboard mit z. B. diesen Panels bauen:
   - **Stat**: `abstimmbar_rooms`, `abstimmbar_users`,
     `abstimmbar_participants`
   - **Time series**: `increase(abstimmbar_runs[1d])` (gestapelt nach `type`)
   - **Pie chart**: `abstimmbar_questions` nach `kind`
   - **Bar gauge**: `abstimmbar_tour_events` nach `kind`
3. Als Zeitraum ein Semester wählen — die Kennzahlen entwickeln sich über
   Wochen, nicht Minuten.

## 6. Datenschutz

Der Endpoint liefert ausschließlich Summen. Er enthält keine Namen,
E-Mail-Adressen, Raum- oder Fragetitel, Antworten oder IP-Adressen. Die
Sitzungszahl je Modus beruht auf gehashten Sitzungsschlüsseln
(`DailyModeSession`), die Rundgang-Zahlen auf anonymen Tageszählern
(`TourDailyCount`) — Details in [`deployment.md`](deployment.md), Abschnitt
„Modus-Statistik (Datenschutz)“ und „Rundgang-Statistik (Datenschutz)“.
Trotzdem gehört das Token nicht in öffentliche Repositories oder Tickets.

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| `404` | `METRICS_TOKEN` nicht gesetzt oder App-Container nicht neu erstellt (Schritt 1.3) |
| `401` | Token falsch, oder Header fehlt (`Authorization: Bearer …`, mit Leerzeichen) |
| HTML statt Kennzahlen / Parse-Fehler in Prometheus | `handle /metrics` fehlt im `Caddyfile` (Schritt 1.4) |
| Target `DOWN`, TLS-Fehler | Domain/Zertifikat prüfen; `scheme: https` gesetzt? |
| Werte bleiben bei 0 | Neu installiert oder nur Beispielräume genutzt (siehe „Beispielräume“) |
