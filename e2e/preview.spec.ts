import { test, expect } from '@playwright/test';
import { GCODE, TOKEN } from '../tests/helpers.js';
const id = '0198cdf0-b8f1-4de0-8d67-2d9e95ed019c';
test('WebGL layers, stats, confirmation and one explicit print request', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  let prints = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/gcode')) return route.fulfill({ contentType: 'text/plain', body: GCODE });
    if (path === '/api/ready')
      return route.fulfill({ json: { status: 'ready', printerEnabled: true } });
    if (path === '/api/printer/print') {
      prints++;
      const body = route.request().postDataJSON();
      expect(body.fileId).toBe(id);
      expect(route.request().headers()['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
      return route.fulfill({
        json: { id: route.request().headers()['idempotency-key'], state: 'accepted', error: null },
      });
    }
    return route.fulfill({
      json: {
        id,
        name: 'cube.gcode.3mf',
        format: 'gcode.3mf',
        state: 'ready',
        estimatedSeconds: 62,
        filamentGrams: 1.2,
        filamentMillimeters: 340,
      },
    });
  });
  await page.goto(`/preview/${id}`);
  await page.getByLabel('APIトークン', { exact: true }).fill(TOKEN);
  await page.getByRole('button', { name: 'プレビューを開く' }).click();
  await expect(page.getByRole('slider', { name: 'レイヤー', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await expect(page.getByText('1.2 g', { exact: true })).toBeVisible();
  await expect(page.getByText('2分', { exact: true })).toBeVisible();
  await page.getByRole('slider', { name: 'レイヤー', exact: true }).fill('1');
  await expect(page.locator('.layer-heading b')).toHaveText('1');
  await page.getByLabel('このレイヤーのみ').check();
  await page.getByLabel('移動経路').check();
  await page.locator('canvas').hover();
  await page.mouse.wheel(0, -120);
  await page.screenshot({ path: '.data/preview-desktop.png', fullPage: true });
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '印刷を開始', exact: true }).click();
  expect(prints).toBe(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '印刷を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '開始要求を受付済み' })).toBeDisabled();
  expect(prints).toBe(1);
  expect(pageErrors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.data/preview-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('shows a missing file clearly and never enables print', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'file_not_found', message: 'not found' } },
    }),
  );
  await page.goto(`/preview/${id}`);
  await page.getByLabel('APIトークン', { exact: true }).fill(TOKEN);
  await page.getByRole('button', { name: 'プレビューを開く' }).click();
  await expect(page.getByRole('alert')).toHaveText('指定されたファイルが見つかりません。');
  await expect(page.getByRole('button', { name: '印刷を開始', exact: true })).toBeDisabled();
});
