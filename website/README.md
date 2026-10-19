# Projekt-Website

Quellen der Projekt-Website (GitHub Pages) mit der Anleitung für Lehrende.

## Screenshots (`bilder/`)

Die Bilder in `bilder/` werden per Skript aus synthetischen Daten erzeugt —
nicht von Hand ersetzen, sondern das Skript anpassen und neu laufen lassen.

Voraussetzung: der Dev-Stack läuft (`docker compose up -d` im Repo-Root) und
Playwright ist installiert (`cd frontend && npx playwright install chromium`).

```bash
cd frontend
npm run docs:shots
```

Das Skript (`frontend/e2e/docs-screenshots.spec.ts`) meldet sich als
Dev-Account `demo` an, legt drei Beispielräume an (deutsche Titel wie
„Didaktik-Workshop“, englische Titel „E2E Docs …“), spielt eine
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
mkdocs serve -f website/mkdocs.yml          # http://127.0.0.1:8000
mkdocs build --strict -f website/mkdocs.yml # wie in CI, Ausgabe in site/
```

- `index.md` — Startseite, `anleitung/` — Anleitung für Lehrende (ein Kapitel
  pro Datei), `assets/` — Theme (Farben wie in der App) und Logo.
- `installation.md` und `lti.md` binden `docs/deployment.md` bzw.
  `docs/lti.md` per `pymdownx.snippets` ein — Änderungen dort machen, nicht
  hier. Links aus diesen Dokumenten auf andere Dateien in `docs/` schreibt
  `hooks/docs_links.py` auf GitHub um.
