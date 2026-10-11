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
  and the translation-controls drag smoke test (`translation-controls.spec.ts`).
- `phone-chromium` / `phone-firefox` — 324×756 px (Galaxy Z Fold7 front
  screen), `mobile-*.spec.ts` only: layout checks (`mobile-layout.spec.ts`) and
  axe accessibility smoke checks (`mobile-a11y.spec.ts`), each in light and dark.
- `mobile-setup` / `mobile-teardown` — log in once (storage states in
  `e2e/.auth/`, gitignored) and seed/delete one shared "E2E Mobile …" room.

axe runs with the WCAG 2.0/2.1 A+AA tags; `color-contrast` is disabled until
the contrast fixes land.

Tests create rooms whose titles start with "E2E" and delete them afterwards.
A loaded Docker host (e.g. colima with little RAM) makes runs slow and can
cause timeouts; use `--workers=2` or fewer.
