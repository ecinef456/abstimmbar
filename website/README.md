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
  Beitritts-URL auf dem Beamer wird als `abstimmbar.example.org` angezeigt.
- `DOCS_SHOTS_DIR=<ordner> npm run docs:shots` schreibt in einen anderen
  Ordner (z. B. zum Vergleichen).

Das Projekt `docs-shots` existiert nur mit gesetztem `DOCS_SHOTS`; ein
normales `npx playwright test` führt das Skript also nicht aus.
