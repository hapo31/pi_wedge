import { test, expect } from '@playwright/test';
import { GCODE } from '../tests/helpers.js';
const id = '0198cdf0-b8f1-4de0-8d67-2d9e95ed019c';
test('WebGL layers, stats, confirmation and one explicit print request', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  let prints = 0;
  await page.route('**/preview/*/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/gcode')) return route.fulfill({ contentType: 'text/plain', body: GCODE });
    if (path === `/preview/${id}/print`) {
      prints++;
      expect(route.request().headers()['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
      expect(route.request().headers().authorization).toBeUndefined();
      expect(route.request().headers().origin).toBe(new URL(page.url()).origin);
      return route.fulfill({
        json: { id: route.request().headers()['idempotency-key'], state: 'accepted', error: null },
      });
    }
    return route.fulfill({
      json: {
        displayName: 'cube.stl',
        printerEnabled: true,
        file: {
          id,
          name: 'cube.gcode.3mf',
          format: 'gcode.3mf',
          state: 'ready',
          estimatedSeconds: 62,
          filamentGrams: 1.2,
          filamentMillimeters: 340,
        },
      },
    });
  });
  await page.goto(`/preview/${id}`);
  await expect(page.getByLabel('APIトークン', { exact: true })).toHaveCount(0);
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
  await page.screenshot({ path: testInfo.outputPath('preview-desktop.png'), fullPage: true });
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(
      '印刷しますか？\nベッドが空で、材料とプレートが合っていることを確認してください。',
    );
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: '印刷', exact: true }).click();
  expect(prints).toBe(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '印刷', exact: true }).click();
  await expect(page.getByRole('button', { name: '受付済み', exact: true })).toBeDisabled();
  expect(prints).toBe(1);
  expect(pageErrors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('preview-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('shows a missing file clearly and never enables print', async ({ page }) => {
  await page.route('**/preview/*/*', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'file_not_found', message: 'not found' } },
    }),
  );
  await page.goto(`/preview/${id}`);
  await expect(page.getByRole('alert')).toHaveText('ファイルが見つかりません。');
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeDisabled();
});
test('keeps an unknown print outcome distinct and disables further requests', async ({ page }) => {
  let prints = 0;
  await page.route('**/preview/*/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/gcode')) return route.fulfill({ contentType: 'text/plain', body: GCODE });
    if (path.endsWith('/print')) {
      prints++;
      return route.fulfill({
        status: 504,
        json: {
          id: route.request().headers()['idempotency-key'],
          state: 'unknown',
          error: { code: 'printer_outcome_unknown', message: 'Print command outcome is unknown' },
        },
      });
    }
    return route.fulfill({
      json: {
        displayName: 'cube.stl',
        printerEnabled: true,
        file: {
          id,
          name: 'cube.gcode.3mf',
          format: 'gcode.3mf',
          state: 'ready',
          estimatedSeconds: null,
          filamentGrams: null,
          filamentMillimeters: null,
        },
      },
    });
  });
  await page.goto(`/preview/${id}`);
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '印刷', exact: true }).click();
  await expect(page.getByRole('button', { name: '結果不明', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText(
    '結果が不明です。プリンターの画面を確認してください。',
  );
  expect(prints).toBe(1);
});
