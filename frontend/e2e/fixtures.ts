import { test as base, expect, type APIRequestContext } from '@playwright/test';

// The dev frontend (5174) and backend (8002) run cross-origin — mirrors
// VITE_API_BASE_URL, see frontend/src/api.ts.
export const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:8002';

/** Read the CSRF cookie the backend sets (see whoami) from a request context. */
export async function csrfToken(request: APIRequestContext): Promise<string | undefined> {
  const { cookies } = await request.storageState();
  return cookies.find((c) => c.name === 'abstimmbar_csrftoken')?.value;
}

/** Delete rooms (by id) this test run created. Tries every room even if one
 *  fails, then throws one error listing all failures. 404 = already gone. */
export async function deleteRooms(
  request: APIRequestContext,
  roomIds: (number | string)[],
): Promise<void> {
  const token = await csrfToken(request);
  const failures: string[] = [];
  for (const id of roomIds) {
    try {
      const response = await request.delete(`${API_BASE_URL}/api/rooms/${id}/`, {
        headers: token ? { 'X-CSRFToken': token } : undefined,
      });
      if (!response.ok() && response.status() !== 404) {
        failures.push(`DELETE /api/rooms/${id}/ returned ${response.status()}`);
      }
    } catch (error) {
      failures.push(`DELETE /api/rooms/${id}/ threw ${(error as Error).message}`);
    }
  }
  if (failures.length) throw new Error(`Cleanup failed: ${failures.join('; ')}`);
}

type RoomCleanupFixtures = {
  /** Register a room (by id) for deletion once the test finishes. */
  trackRoom: (roomId: number | string) => void;
};

type ThemeFixtures = {
  /** Playwright's Firefox ignores `colorScheme` (prefers-color-scheme stays
   *  light), so "dark" Firefox runs silently tested the light theme. Both the
   *  app and the participant page honour the stored `abstimmbar_theme`
   *  choice, so set it from the test's colorScheme before any page script. */
  themeFromColorScheme: void;
};

export const test = base.extend<RoomCleanupFixtures & ThemeFixtures>({
  themeFromColorScheme: [
    async ({ page, browserName, colorScheme }, use) => {
      if (browserName === 'firefox' && (colorScheme === 'dark' || colorScheme === 'light')) {
        await page.addInitScript((scheme) => {
          try {
            localStorage.setItem('abstimmbar_theme', scheme);
          } catch {
            /* storage unavailable: keep the default */
          }
        }, colorScheme);
      }
      await use();
    },
    { auto: true },
  ],
  trackRoom: async ({ page }, use) => {
    const roomIds: (number | string)[] = [];
    await use((roomId) => roomIds.push(roomId));
    await deleteRooms(page.request, roomIds);
  },
});

export { expect };
