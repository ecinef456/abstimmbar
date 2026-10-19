# Projekt-Website

Quellen der Projekt-Website (GitHub Pages) mit der Anleitung für Lehrende —
zweisprachig: Deutsch an der Wurzel der Website, Englisch unter `/en/`.

## Zwei Sprachen

Die Website besteht aus zwei MkDocs-Konfigurationen, ohne i18n-Plugin:

- `mkdocs.yml` — Deutsch, Quellen in diesem Ordner, Ausgabe `site/`.
- `mkdocs.en.yml` — Englisch, erbt per `INHERIT` Theme, CSS, `overrides/`,
  Hooks und Markdown-Erweiterungen; Quellen in `en/` (englische Dateinamen,
  z. B. `en/guide/rooms.md`), Ausgabe `site/en/`.
- `hooks/i18n.py` verknüpft die Seiten paarweise (Tabelle `PAGES`) für den
  Sprachumschalter im Kopf (`overrides/partials/alternate.html`) und stellt
  der englischen Seite die gemeinsamen `assets/` bereit.

**Beide Sprachen synchron halten:** Jede Änderung an einer deutschen Seite
braucht die passende Änderung in `en/`. Das gilt auch für
`docs/deployment.md` und `docs/lti.md`: die deutsche Website bindet sie
direkt ein, die englische hat eigene Übersetzungen (`en/installation.md`,
`en/lti.md`), die von Hand nachgezogen werden müssen. Neue oder umbenannte
Seiten in beide `nav`-Listen und in `PAGES` eintragen.

## Screenshots (`bilder/`, `en/bilder/`)

Die Bilder in `bilder/` (deutsch) und `en/bilder/` (englisch, gleiche
Dateinamen) werden per Skript aus synthetischen Daten erzeugt —
nicht von Hand ersetzen, sondern das Skript anpassen und neu laufen lassen.

Voraussetzung: der Dev-Stack läuft (`docker compose up -d` im Repo-Root) und
Playwright ist installiert (`cd frontend && npx playwright install chromium`).

```bash
cd frontend
npm run docs:shots                        # deutsch → website/bilder/
DOCS_SHOTS_LANG=en npm run docs:shots     # englisch → website/en/bilder/
```

Das Skript (`frontend/e2e/docs-screenshots.spec.ts`) meldet sich als
Dev-Account `demo` an, legt drei Beispielräume an (Titel in der Sprache der
Bilder wie „Didaktik-Workshop“ bzw. „Didactics workshop“, der Titel der
anderen Sprache beginnt mit „E2E Docs …“), spielt eine
Live-Abstimmung mit anonymen Teilnehmenden durch, fotografiert die Ansichten
und löscht die Räume danach wieder (Reste abgebrochener Läufe werden beim
nächsten Lauf entfernt). Es ruft kein KI-Modell auf: der KI-Vorschlag der
Vier-Felder-Matrix wird vom Backend simuliert und signiert
(`frontend/e2e/helpers/matrixAi.ts`).

- Desktop/Beamer: 1440 × 900 CSS-Pixel bei Skalierung 1,5 (2160 × 1350 px),
  Handy: 390 × 844 bei Skalierung 2 (780 × 1688 px); helles Design.
- Einmalige Hinweise (KI-Datenschutzhinweis, Tipps) sind ausgeblendet; die
  Beitritts-URL auf dem Beamer wird als `abstimmbar.example.org` angezeigt,
  und der QR-Code kodiert `https://abstimmbar.example.org/p/<code>` (erzeugt
  mit der QR-Bibliothek des Backends per `docker compose exec`).
- `DOCS_SHOTS_ONLY=beamer-beitritt npm run docs:shots` schreibt nur die
  genannten Bilder (Komma-Liste); der Lauf selbst ist derselbe.
- `DOCS_SHOTS_DIR=<ordner> npm run docs:shots` schreibt in einen anderen
  Ordner (z. B. zum Vergleichen).

Das Projekt `docs-shots` existiert nur mit gesetztem `DOCS_SHOTS`; ein
normales `npx playwright test` führt das Skript also nicht aus.

## Website bauen und ansehen

Die Website ist eine [MkDocs-Material](https://squidfunk.github.io/mkdocs-material/)-Seite
(`mkdocs.yml` in diesem Ordner). Der Workflow `.github/workflows/docs.yml`
baut sie bei Änderungen auf `main` und veröffentlicht sie auf GitHub Pages.
Lokal, in einer eigenen virtuellen Umgebung — alle `mkdocs`-Befehle **im
Repo-Root** ausführen und die Konfiguration relativ angeben
(`-f website/mkdocs.yml`); die Einbindungen von `docs/*.md` und der
Ausgabeordner `site/` (Repo-Root, per `.gitignore` ausgenommen) beziehen
sich auf diesen Aufbau:

```bash
python3 -m venv /tmp/abstimmbar-docs && . /tmp/abstimmbar-docs/bin/activate
pip install -r website/requirements.txt
mkdocs serve -f website/mkdocs.yml             # deutsch, http://127.0.0.1:8000/abstimmbar/
mkdocs serve -f website/mkdocs.en.yml          # englisch, …/abstimmbar/en/
# wie in CI — erst Deutsch (räumt site/ auf), dann Englisch nach site/en/:
mkdocs build --strict -f website/mkdocs.yml
mkdocs build --strict -f website/mkdocs.en.yml
```

`mkdocs serve` zeigt jeweils nur eine Sprache; der Sprachumschalter führt
dort ins Leere. Die fertige Gesamtseite ansehen: beide bauen und `site/`
statisch ausliefern, z. B. unter `/abstimmbar/` per
`mkdir -p /tmp/pages && ln -sfn "$PWD/site" /tmp/pages/abstimmbar && python3 -m http.server -d /tmp/pages`.

- `index.md` — Startseite, `anleitung/` — Anleitung für Lehrende (ein Kapitel
  pro Datei), `assets/` — Theme (Farben wie in der App) und Logo; `en/` —
  dasselbe auf Englisch (`en/guide/`).
- `installation.md` und `lti.md` binden `docs/deployment.md` bzw.
  `docs/lti.md` per `pymdownx.snippets` ein — Änderungen dort machen, nicht
  hier (und die englischen Fassungen in `en/` nachziehen, s. o.). Links aus diesen Dokumenten auf andere Dateien in `docs/` schreibt
  `hooks/docs_links.py` auf GitHub um.
