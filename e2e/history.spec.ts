import { test, expect } from '@playwright/test';

const id = '0198cdf0-b8f1-4de0-8d67-2d9e95ed019c';

test('shows ready slices and opens the selected preview without token input', async ({ page }) => {
  await page.route('**/history/data*', (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    return route.fulfill({
      json: {
        items:
          query && query !== '収納'
            ? []
            : [
                {
                  id,
                  plateId: id,
                  previewId: id,
                  plateCount: 2,
                  name: '収納ケースのふた',
                  createdAt: '2026-10-19T03:00:00.000Z',
                  format: 'gcode.3mf',
                  estimatedSeconds: 2520,
                  filamentGrams: 12.4,
                },
              ],
        nextCursor: null,
      },
    });
  });
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'スライス履歴' })).toBeVisible();
  await expect(page.getByRole('link', { name: /収納ケースのふた/ })).toHaveAttribute(
    'href',
    `/preview/${id}/${id}`,
  );
  await expect(page.getByText('42分')).toBeVisible();
  await expect(page.getByText('12.4 g')).toBeVisible();
  await expect(page.getByLabel('APIトークン')).toHaveCount(0);
  await page.getByRole('textbox', { name: '履歴を検索' }).fill('収納');
  await page.getByRole('button', { name: '検索' }).click();
  await expect(page.getByRole('link', { name: /収納ケースのふた/ })).toBeVisible();
  await page.getByRole('textbox', { name: '履歴を検索' }).fill('ない');
  await page.getByRole('button', { name: '検索' }).click();
  await expect(page.getByText('見つかりません。')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
