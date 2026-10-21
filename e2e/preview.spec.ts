import { test, expect } from '@playwright/test';
import { GCODE } from '../tests/helpers.js';
const id = '0198cdf0-b8f1-4de0-8d67-2d9e95ed019c';
const ams = {
  observedAt: '2026-10-14T04:00:00.000Z',
  gcodeState: 'IDLE',
  amsConnected: true,
  currentSlot: 0,
  externalSpoolActive: false,
  slots: [
    {
      slot: 0,
      present: true,
      material: 'PLA',
      color: '#F72323',
      remainingPercent: 100,
      active: true,
    },
    {
      slot: 1,
      present: true,
      material: 'PLA',
      color: '#FFFFFF',
      remainingPercent: null,
      active: false,
    },
    { slot: 2, present: false, material: null, color: null, remainingPercent: null, active: false },
    {
      slot: 3,
      present: true,
      material: 'PETG',
      color: '#000000',
      remainingPercent: null,
      active: false,
    },
  ],
};
test('WebGL layers, stats, confirmation and one explicit print request', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  let prints = 0;
  await page.route(
    /\/preview\/[^/]+\/(?:data|gcode|printer|print|download|thumbnail)(?:\?.*)?$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/gcode')) return route.fulfill({ contentType: 'text/plain', body: GCODE });
      if (path.endsWith('/printer')) return route.fulfill({ json: ams });
      if (path === `/preview/${id}/print`) {
        prints++;
        expect(route.request().postDataJSON()).toEqual({ useAms: true, amsMapping: [1] });
        expect(route.request().headers()['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
        expect(route.request().headers().authorization).toBeUndefined();
        expect(route.request().headers().origin).toBe(new URL(page.url()).origin);
        return route.fulfill({
          json: {
            id: route.request().headers()['idempotency-key'],
            state: 'accepted',
            error: null,
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
            estimatedSeconds: 62,
            filamentGrams: 1.2,
            filamentMillimeters: 340,
          },
        },
      });
    },
  );
  await page.goto(`/preview/${id}/${id}`);
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
  await expect(page.getByText('AMS Lite 接続済み', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'AMS スロット3', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'AMS スロット4', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'AMS スロット2', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('preview-desktop.png'), fullPage: true });
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(
      '印刷しますか？\ncube.stl\n供給元: AMS スロット2 · PLA · #FFFFFF\nスライス設定: Generic PLA\nベッドレベリング: 有効\nベッドが空で、材料とプレートが合っていることを確認してください。',
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
  await page.reload();
  await expect(page.getByRole('slider', { name: 'レイヤー', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '受付済み', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'AMS スロット2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(prints).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('preview-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('shows a missing file clearly and never enables print', async ({ page }) => {
  await page.route(
    /\/preview\/[^/]+\/(?:data|gcode|printer|print|download|thumbnail)(?:\?.*)?$/,
    (route) =>
      route.fulfill({
        status: 404,
        json: { error: { code: 'file_not_found', message: 'not found' } },
      }),
  );
  await page.goto(`/preview/${id}/${id}`);
  await expect(page.getByRole('alert')).toHaveText('ファイルが見つかりません。');
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeDisabled();
});
test('renders all layers above 250,000 lines, including a layer above 20,000 commands', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const parts = ['G21\nG90\nM83\n'];
  for (let layer = 1; layer <= 12; layer++) {
    parts.push(`; CHANGE_LAYER\nG1 Z${(layer * 0.2).toFixed(1)}\n`);
    for (let command = 0; command < 24000; command++) {
      const x = 15 + (command % 150);
      const y = 15 + Math.floor(command / 160);
      parts.push(`G1 X${x} Y${y} E0.01\n`);
    }
  }
  let prints = 0;
  await page.route(
    /\/preview\/[^/]+\/(?:data|gcode|printer|print|download|thumbnail)(?:\?.*)?$/,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/gcode'))
        return route.fulfill({ contentType: 'text/plain', body: parts.join('') });
      if (path.endsWith('/print')) {
        prints++;
        return route.abort();
      }
      return route.fulfill({
        json: {
          displayName: 'large.stl',
          printerEnabled: false,
          file: { id, format: 'gcode.3mf', state: 'ready' },
        },
      });
    },
  );
  await page.goto(`/preview/${id}/${id}`);
  const slider = page.getByRole('slider', { name: 'レイヤー', exact: true });
  await expect(slider).toBeEnabled({ timeout: 90000 });
  await expect(slider).toHaveAttribute('max', '12');
  await expect(slider).toHaveValue('12');
  await expect(page.locator('.layer-heading')).toContainText('2.40 mm');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('このレイヤーのみ').check();
  await slider.fill('1');
  await expect(page.locator('.layer-heading')).toContainText('0.20 mm');
  await page.getByLabel('移動経路').check();
  await slider.fill('12');
  await page.screenshot({ path: testInfo.outputPath('preview-large.png') });
  expect(errors).toEqual([]);
  expect(prints).toBe(0);
});
test('keeps an unknown print outcome distinct and disables further requests', async ({ page }) => {
  let prints = 0;
  await page.route(
    /\/preview\/[^/]+\/(?:data|gcode|printer|print|download|thumbnail)(?:\?.*)?$/,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/gcode')) return route.fulfill({ contentType: 'text/plain', body: GCODE });
      if (path.endsWith('/printer')) return route.fulfill({ json: ams });
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
    },
  );
  await page.goto(`/preview/${id}/${id}`);
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

test('refreshing disconnected AMS blocks a selected slot without dispatching', async ({ page }) => {
  let snapshots = 0,
    prints = 0;
  await page.route(
    /\/preview\/[^/]+\/(?:data|gcode|printer|print|download|thumbnail)(?:\?.*)?$/,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/gcode')) return route.fulfill({ contentType: 'text/plain', body: GCODE });
      if (path.endsWith('/printer')) {
        snapshots++;
        return route.fulfill({
          json:
            snapshots === 1
              ? ams
              : {
                  ...ams,
                  amsConnected: false,
                  currentSlot: null,
                  externalSpoolActive: false,
                  slots: [],
                },
        });
      }
      if (path.endsWith('/print')) {
        prints++;
        return route.fulfill({ json: { state: 'accepted' } });
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
    },
  );
  await page.goto(`/preview/${id}/${id}`);
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await page.getByRole('button', { name: 'AMS スロット2', exact: true }).click();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByText('AMS未接続', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeDisabled();
  await page.getByLabel('外部スプール', { exact: true }).check();
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeEnabled();
  expect(prints).toBe(0);
});

test('switches thumbnail previews with nested URLs, history navigation and independent print keys', async ({
  page,
}, testInfo) => {
  const secondId = 'a8979c43-b9a6-4d6d-a733-7347800130af';
  const plateId = 'b8979c43-b9a6-4d6d-a733-7347800130af';
  const keys: string[] = [];
  let secondDataRequests = 0;
  await page.route(
    /\/preview\/[^/]+\/(?:data|gcode|printer|print|download|thumbnail)(?:\?.*)?$/,
    (route) => {
      const url = new URL(route.request().url());
      const selected = url.searchParams.get('previewId') ?? id;
      if (url.pathname.endsWith('/thumbnail'))
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><path d="M20 20L100 100" stroke="#4bd5bc"/></svg>',
        });
      if (url.pathname.endsWith('/gcode'))
        return route.fulfill({
          contentType: 'text/plain',
          body: selected === secondId ? GCODE + 'G1 Z0.6\nG1 X30 Y30 E1\n' : GCODE,
        });
      if (url.pathname.endsWith('/printer')) return route.fulfill({ json: ams });
      if (url.pathname.endsWith('/print')) {
        expect(selected).toBe(keys.length === 0 ? id : secondId);
        keys.push(route.request().headers()['idempotency-key']!);
        return route.fulfill({ json: { id: keys.at(-1), state: 'accepted', error: null } });
      }
      if (url.pathname.endsWith('/data') && selected === secondId && ++secondDataRequests === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: 'preview_busy', message: 'Previous plate is still processing' } },
        });
      if (url.pathname.endsWith('/data'))
        return route.fulfill({
          json: {
            plateId,
            previewId: selected,
            plate: selected === secondId ? 3 : 1,
            plates: [
              { id, plate: 1 },
              { id: secondId, plate: 3 },
            ],
            displayName: 'plates.stl',
            printerEnabled: true,
            file: {
              id,
              format: 'gcode.3mf',
              state: 'ready',
              estimatedSeconds: selected === secondId ? 300 : 62,
              filamentGrams: 1.2,
              filamentMillimeters: 340,
            },
          },
        });
      return route.continue();
    },
  );
  await page.goto(`/preview/${plateId}/${id}`);
  const slider = page.getByRole('slider', { name: 'レイヤー', exact: true });
  await expect(slider).toBeEnabled();
  await expect(page.locator('.plate-thumbnails img')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'プレート 1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '印刷', exact: true }).click();
  await expect(page.getByRole('button', { name: '受付済み', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'プレート 3', exact: true }).click();
  await expect(page).toHaveURL(`/preview/${plateId}/${secondId}`);
  await expect(slider).toHaveAttribute('max', '3');
  await expect(page.getByText('5分', { exact: true })).toBeVisible();
  expect(secondDataRequests).toBe(2);
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeEnabled();
  await page.goBack();
  await expect(page).toHaveURL(`/preview/${plateId}/${id}`);
  await expect(page.getByRole('button', { name: '受付済み', exact: true })).toBeDisabled();
  await page.goForward();
  await expect(page).toHaveURL(`/preview/${plateId}/${secondId}`);
  await page.reload();
  await expect(slider).toHaveAttribute('max', '3');
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('プレート 3');
    void dialog.accept();
  });
  await page.getByRole('button', { name: '印刷', exact: true }).click();
  await expect(page.getByRole('button', { name: '受付済み', exact: true })).toBeDisabled();
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('multi-plate-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
