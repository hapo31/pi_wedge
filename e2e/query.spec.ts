import { test, expect } from '@playwright/test';
import { GCODE } from '../tests/helpers.js';

const plateId = 'b8979c43-b9a6-4d6d-a733-7347800130af';
const ids = [1, 2, 3].map((value) => `0198cdf0-b8f1-4de0-8d67-${String(value).padStart(12, '0')}`);
const first = ids[0]!;
const second = ids[1]!;
const third = ids[2]!;
const endpoints = /\/preview\/[^/]+\/(?:data|gcode|printer|print|thumbnail)(?:\?.*)?$/;
function data(id: string, printerEnabled = false) {
  return {
    plateId,
    previewId: id,
    plate: ids.indexOf(id) + 1,
    plates: ids.map((value, index) => ({ id: value, plate: index + 1 })),
    displayName: 'query.stl',
    printerEnabled,
    file: {
      id: first,
      name: 'query.gcode',
      state: 'ready',
      format: 'gcode',
      estimatedSeconds: 180,
      filamentGrams: 1.2,
      filamentMillimeters: 340,
    },
  };
}
const image =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><path d="M1 1L90 90" stroke="red"/></svg>';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('loads metadata once, retains statistics after G-code failure, and serializes thumbnails after failure', async ({
  page,
}) => {
  const pending = gate();
  let dataRequests = 0,
    textRequests = 0,
    active = 0,
    peak = 0;
  const thumbnails: string[] = [];
  await page.route(endpoints, async (route) => {
    const url = new URL(route.request().url());
    const selected = url.searchParams.get('previewId')!;
    if (url.pathname.endsWith('/data')) {
      dataRequests++;
      return route.fulfill({ json: data(selected) });
    }
    if (url.pathname.endsWith('/gcode')) {
      textRequests++;
      return route.fulfill({ status: 413, json: { error: { code: 'too_large' } } });
    }
    if (url.pathname.endsWith('/thumbnail')) {
      thumbnails.push(selected);
      active++;
      peak = Math.max(peak, active);
      try {
        if (selected === first) {
          await pending.promise;
          return await route.fulfill({
            status: 503,
            json: { error: { code: 'storage_unavailable' } },
          });
        }
        return await route.fulfill({ contentType: 'image/svg+xml', body: image });
      } finally {
        active--;
      }
    }
    throw new Error('Unexpected request');
  });
  try {
    await page.goto(`/preview/${plateId}/${first}`);
    await expect(page.getByRole('alert')).toContainText('容量上限');
    await expect(page.getByText('3分', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ダウンロード', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeDisabled();
    await expect.poll(() => thumbnails.length).toBe(1);
    pending.release();
    await expect(page.locator('.plate-thumbnails img')).toHaveCount(2);
    expect(thumbnails).toEqual(ids);
    expect(peak).toBe(1);
    expect(dataRequests).toBe(1);
    expect(textRequests).toBe(1);
  } finally {
    pending.release();
  }
});

test('refreshes only AMS and hides stale supply information after a failed refresh', async ({
  page,
}) => {
  let dataRequests = 0,
    textRequests = 0,
    statusRequests = 0;
  const status = {
    observedAt: '2026-10-22T00:00:00.000Z',
    amsConnected: true,
    externalSpoolActive: false,
    currentSlot: 0,
    slots: [0, 1, 2, 3].map((slot) => ({
      slot,
      present: true,
      material: 'PLA',
      color: '#ffffff',
      active: slot === 0,
    })),
  };
  await page.route(endpoints, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/data')) {
      dataRequests++;
      return route.fulfill({ json: data(first, true) });
    }
    if (url.pathname.endsWith('/gcode')) {
      textRequests++;
      return route.fulfill({ contentType: 'text/plain', body: GCODE });
    }
    if (url.pathname.endsWith('/thumbnail'))
      return route.fulfill({ contentType: 'image/svg+xml', body: image });
    if (url.pathname.endsWith('/printer')) {
      statusRequests++;
      return statusRequests === 2
        ? route.fulfill({ status: 503, json: { error: { code: 'printer_status_unavailable' } } })
        : route.fulfill({ json: status });
    }
    throw new Error('Unexpected request');
  });
  await page.goto(`/preview/${plateId}/${first}`);
  await expect(page.getByRole('slider', { name: 'レイヤー', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'AMS スロット2', exact: true }).click();
  const canvas = await page.locator('canvas').elementHandle();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('AMSの状態を取得できません');
  await expect(page.getByRole('button', { name: 'AMS スロット2', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AMS スロット2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeEnabled();
  expect(
    await page.locator('canvas').evaluate((element, original) => element === original, canvas),
  ).toBe(true);
  expect(dataRequests).toBe(1);
  expect(textRequests).toBe(1);
  expect(statusRequests).toBe(3);
});

test('retains the plate list on metadata failure and recovers by selecting another plate', async ({
  page,
}) => {
  let failedRequests = 0;
  await page.route(endpoints, (route) => {
    const url = new URL(route.request().url());
    const selected = url.searchParams.get('previewId')!;
    if (url.pathname.endsWith('/data')) {
      if (selected === second) {
        failedRequests++;
        return route.fulfill({ status: 503, json: { error: { code: 'storage_unavailable' } } });
      }
      return route.fulfill({ json: data(selected) });
    }
    if (url.pathname.endsWith('/gcode'))
      return route.fulfill({ contentType: 'text/plain', body: GCODE });
    if (url.pathname.endsWith('/thumbnail'))
      return route.fulfill({ contentType: 'image/svg+xml', body: image });
    throw new Error('Unexpected request');
  });
  await page.goto(`/preview/${plateId}/${first}`);
  await expect(page.locator('.plate-thumbnails img')).toHaveCount(3);
  const navigation = await page.locator('.plate-thumbnails').elementHandle();
  await page.getByRole('button', { name: 'プレート 2', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保存済みファイルを読み込めません');
  await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeDisabled();
  expect(
    await page
      .locator('.plate-thumbnails')
      .evaluate((element, original) => element === original, navigation),
  ).toBe(true);
  await page.getByRole('button', { name: 'プレート 3', exact: true }).click();
  await expect(page).toHaveURL(`/preview/${plateId}/${third}`);
  await expect(page.getByRole('slider', { name: 'レイヤー', exact: true })).toBeEnabled();
  expect(failedRequests).toBe(1);
});

test('appends history pages, preserves them after failure, and isolates late pages across URL searches', async ({
  page,
}) => {
  const pending = gate();
  let appendRequests = 0,
    oldStarted = false;
  const item = (id: string, name: string) => ({
    id,
    plateId,
    previewId: id,
    name,
    createdAt: '2026-10-22T00:00:00.000Z',
    format: 'gcode',
    estimatedSeconds: 180,
    filamentGrams: 1.2,
  });
  await page.route('**/history/data*', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q');
    const cursor = url.searchParams.get('cursor');
    if (q === '別')
      return route.fulfill({ json: { items: [item(third, '別の検索結果')], nextCursor: null } });
    if (cursor === first) {
      appendRequests++;
      if (appendRequests === 1)
        return route.fulfill({ status: 503, json: { error: { code: 'storage_unavailable' } } });
      return route.fulfill({ json: { items: [item(second, '追加の収納')], nextCursor: second } });
    }
    if (cursor === second) {
      oldStarted = true;
      await pending.promise;
      return route.fulfill({ json: { items: [item(third, '古い追加結果')], nextCursor: null } });
    }
    return route.fulfill({ json: { items: [item(first, '収納ケース')], nextCursor: first } });
  });
  try {
    await page.goto('/history?q=%E5%8F%8E%E7%B4%8D');
    await expect(page.getByRole('textbox', { name: '履歴を検索' })).toHaveValue('収納');
    await page.getByRole('button', { name: 'さらに表示', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('.history-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'さらに表示', exact: true }).click();
    await expect(page.locator('.history-row')).toHaveCount(2);
    await page.getByRole('button', { name: 'さらに表示', exact: true }).click();
    await expect.poll(() => oldStarted).toBe(true);
    await page.getByRole('textbox', { name: '履歴を検索' }).fill('別');
    await page.getByRole('button', { name: '検索', exact: true }).click();
    await expect(page.getByRole('link', { name: /別の検索結果/ })).toBeVisible();
    pending.release();
    await expect(page.locator('.history-row')).toHaveCount(1);
    await expect(page.getByText('古い追加結果')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole('textbox', { name: '履歴を検索' })).toHaveValue('収納');
    await expect(page.locator('.history-row')).toHaveCount(1);
  } finally {
    pending.release();
  }
});
