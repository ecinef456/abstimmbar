# E2E tests (Playwright)

Local-only for now: there is no CI job yet. The tests run against the dev
stack, so it has to be up (`docker compose up -d` in the repo root, demo users
`demo`/`demo` and `admin-demo`/`demo` from the Keycloak dev realm).

## Run

```bash
cd frontend
npx playwright install chromium firefox   # once
npx playwright test                        # all projects
npx playwright test --project phone-chromium
npx playwright test e2e/mobile-a11y.spec.ts --workers=2
npx playwright test --ui                   # interactive runner
```

Projects:

- `firefox` — desktop, the original specs (`create-question-set.spec.ts`)
  and the translation-controls drag smoke test (`translation-controls.spec.ts`),
  and the guided tour (`tour.spec.ts`: sections/progress, Back across a page
  change, "Skip section", ←/→, mind map step shown only if the demo user's
  example set has one — otherwise a visible `skip-reason` annotation is recorded;
  read-only on the example room, restores it if missing; set `TOUR_USER=<keycloak
  user>` to run it as a fresh dev account, password `demo` like all dev users,
  whose example room then includes the matrix),
  and the four-field matrix (`matrix-results.spec.ts`: results board, stack badge,
  hidden marker, legend, zone list, axe; `matrix-presenter.spec.ts`: beamer board —
  drag, stack, dialog, hide, teacher card, keyboard moves, new-card highlight),
  and the presenter footer (`presenter-footer.spec.ts`: icon bar per question
  kind, view switcher, keys A/E/L, axe on the footer, no overflow at 1280 px;
  `FOOTER_SHOTS=<dir>` saves footer screenshots), and the presenter "?" help
  (`presenter-help.spec.ts`: ?/H/button open and close, one label card per
  visible control and handle without overlaps, Esc closes only the help, no
  shortcuts while open, axe on the overlay; `HELP_SHOTS=<dir>` saves
  screenshots).
- `phone-chromium` / `phone-firefox` — 324×756 px (Galaxy Z Fold7 front
  screen), `mobile-*.spec.ts` only: layout checks (`mobile-layout.spec.ts`,
  tour popover in `mobile-tour.spec.ts`, matrix participant page in
  `mobile-matrix-participant.spec.ts`, matrix results board and list in
  `mobile-matrix-results.spec.ts`) and
  axe accessibility smoke checks (`mobile-a11y.spec.ts`), each in light and dark.
- `mobile-setup` / `mobile-teardown` — log in once (storage states in
  `e2e/.auth/`, gitignored) and seed/delete one shared "E2E Mobile …" room.

axe runs with the WCAG 2.0/2.1 A+AA tags, `color-contrast` included (#178),
in light and dark on: home, room page, set page, question editor, results,
a delete confirmation dialog (opened, then cancelled), and the participant
page with an open question and with results (single choice, ordering). It
waits for finite entrance animations first, so fading/popping result badges
are measured at full opacity. Form-control borders (WCAG 1.4.11) are not an
axe rule; they come from one token (`border-field` in the management UI,
`--field-line` on the participant page) — change those, not single inputs.

**AI without the LLM.** No spec calls a real AI model. The matrix AI grouping
specs (`matrix-ai-presenter.spec.ts`, and the summary-card checks in
`matrix-results.spec.ts` / `mobile-matrix-rating.spec.ts`) use
`e2e/helpers/matrixAi.ts`: `signedProposal()` runs
`docker compose exec -T backend python manage.py shell` from the repo root and
lets the backend simulate and sign a fixed, already parsed AI reply
(`live.matrix.simulate_groups` / `simulate_hints` / `with_tops` /
`sign_proposal`) — the same steps as the `ai-propose` view after its LLM
call, so the body has the exact response shape. Specs route-mock
`/ai-propose` with it; `ai-apply` / `ai-undo` then run for real
(`applySummary()` calls ai-apply directly to seed summary cards). This needs
the dev stack's `backend` service; if `matrix_ai_propose` changes how it
builds its response, update the helper's script to match.

Tests create rooms whose titles start with "E2E" and delete them afterwards.
A loaded Docker host (e.g. colima with little RAM) makes runs slow and can
cause timeouts; use `--workers=2` or fewer.
