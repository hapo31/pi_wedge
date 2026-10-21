import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { GCODE } from '../tests/helpers.js';

const plateId = 'b8979c43-b9a6-4d6d-a733-7347800130af';
const plates = Array.from({ length: 12 }, (_, index) => ({
  id: `0198cdf0-b8f1-4de0-8d67-${String(index + 1).padStart(12, '0')}`,
  plate: index + 1,
}));
const first = plates[0]!;
const second = plates[1]!;
const third = plates[2]!;
const fourth = plates[3]!;
const endpoints = /\/preview\/[^/]+\/(?:data|gcode|printer|print|download|thumbnail)(?:\?.*)?$/;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function metadata(selected: string, count: number, printerEnabled = false) {
  const plate = plates.find((item) => item.id === selected)?.plate ?? 1;
  return {
    plateId,
    previewId: selected,
    plate,
    plates: plates.slice(0, count),
    displayName: 'plates.stl',
    printerEnabled,
    file: {
      id: first.id,
      format: 'gcode.3mf',
      state: 'ready',
      estimatedSeconds: plate * 180,
      filamentGrams: plate * 1.2,
      filamentMillimeters: plate * 340,
    },
  };
}

function thumbnail(route: Route) {
  return route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><path d="M20 20L100 100" stroke="#4bd5bc"/></svg>',
  });
}

function ready(page: Page) {
  return expect(page.getByRole('slider', { name: 'レイヤー', exact: true })).toBeEnabled({
    timeout: 20000,
  });
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`keeps plate DOM, thumbnails, scroll and layout while switching at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const pending = gate();
    let thumbnails = 0;
    let selectedRequests = 0;
    let prints = 0;
    await page.route(endpoints, async (route) => {
      const url = new URL(route.request().url());
      const selected = url.searchParams.get('previewId') ?? first.id;
      if (url.pathname.endsWith('/thumbnail')) {
        thumbnails++;
        return thumbnail(route);
      }
      if (url.pathname.endsWith('/gcode'))
        return route.fulfill({ contentType: 'text/plain', body: GCODE });
      if (url.pathname.endsWith('/print')) {
        prints++;
        return route.abort();
      }
      if (url.pathname.endsWith('/data')) {
        if (selected === fourth.id) {
          selectedRequests++;
          await pending.promise;
        }
        return route.fulfill({ json: metadata(selected, 12) });
      }
      return route.abort();
    });
    await page.goto(`/preview/${plateId}/${first.id}`);
    await ready(page);
    const navigation = page.getByRole('navigation', { name: 'プレート', exact: true });
    await expect(navigation.locator('img')).toHaveCount(12);
    await navigation.scrollIntoViewIfNeeded();
    await navigation.evaluate((element) => {
      element.scrollLeft = 280;
    });
    const original = await navigation.evaluateHandle((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        navigation: element,
        buttons: [...element.querySelectorAll('button')],
        images: [...element.querySelectorAll('img')],
        urls: [...element.querySelectorAll('img')].map((image) => image.src),
        scrollLeft: element.scrollLeft,
        bounds: {
          x: bounds.x + window.scrollX,
          y: bounds.y + window.scrollY,
          width: bounds.width,
          height: bounds.height,
        },
      };
    });
    const assertPreserved = async () => {
      const actual = await page.evaluate((baseline) => {
        const current = document.querySelector('.plate-thumbnails');
        const bounds = current?.getBoundingClientRect();
        return {
          sameNavigation: current === baseline.navigation && baseline.navigation.isConnected,
          sameButtons: baseline.buttons.every(
            (button, index) => button === current?.querySelectorAll('button')[index],
          ),
          sameImages: baseline.images.every(
            (image, index) => image === current?.querySelectorAll('img')[index],
          ),
          sameUrls: baseline.urls.every(
            (url, index) => url === current?.querySelectorAll('img')[index]?.src,
          ),
          scrollDelta: Math.abs((current?.scrollLeft ?? -1) - baseline.scrollLeft),
          boundsDelta: bounds
            ? Math.max(
                Math.abs(bounds.x + window.scrollX - baseline.bounds.x),
                Math.abs(bounds.y + window.scrollY - baseline.bounds.y),
                Math.abs(bounds.width - baseline.bounds.width),
                Math.abs(bounds.height - baseline.bounds.height),
              )
            : Infinity,
        };
      }, original);
      expect(actual.sameNavigation).toBe(true);
      expect(actual.sameButtons).toBe(true);
      expect(actual.sameImages).toBe(true);
      expect(actual.sameUrls).toBe(true);
      expect(actual.scrollDelta).toBeLessThan(1);
      expect(actual.boundsDelta).toBeLessThan(1);
      expect(thumbnails).toBe(12);
    };
    try {
      await page.getByRole('button', { name: 'プレート 4', exact: true }).click();
      await expect.poll(() => selectedRequests).toBe(1);
      await expect(page).toHaveURL(`/preview/${plateId}/${fourth.id}`);
      await assertPreserved();
      await expect(page.getByRole('button', { name: 'プレート 4', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeDisabled();
      pending.release();
      await ready(page);
      await expect(page.getByText('12分', { exact: true })).toBeVisible();
      await assertPreserved();
      await page.goBack();
      await expect(page).toHaveURL(`/preview/${plateId}/${first.id}`);
      await ready(page);
      await expect(page.getByText('3分', { exact: true })).toBeVisible();
      await assertPreserved();
      await page.goForward();
      await expect(page).toHaveURL(`/preview/${plateId}/${fourth.id}`);
      await ready(page);
      await expect(page.getByText('12分', { exact: true })).toBeVisible();
      await assertPreserved();
      expect(prints).toBe(0);
      expect(errors).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    } finally {
      pending.release();
      await original.dispose();
    }
  });
}

test.describe('classic browser scrollbars', () => {
  test('keeps the plate list position, width and page scroll while the AMS sidebar loads', async ({
    playwright,
    baseURL,
  }) => {
    const browser = await playwright.chromium.launch({
      headless: true,
      // Chromium otherwise hides the scrollbar and masks the width change when
      // the AMS sidebar disappears while the next plate's metadata is loading.
      ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--enable-unsafe-swiftshader', '--disable-features=OverlayScrollbar'],
    });
    const page = await browser.newPage({ baseURL, viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const pending = gate();
    let secondRequests = 0;
    let prints = 0;
    await page.route(endpoints, async (route) => {
      const url = new URL(route.request().url());
      const selected = url.searchParams.get('previewId') ?? first.id;
      if (url.pathname.endsWith('/thumbnail')) return thumbnail(route);
      if (url.pathname.endsWith('/gcode'))
        return route.fulfill({ contentType: 'text/plain', body: GCODE });
      if (url.pathname.endsWith('/printer'))
        return route.fulfill({
          json: {
            observedAt: '2026-10-21T04:00:00.000Z',
            gcodeState: 'IDLE',
            amsConnected: true,
            currentSlot: 0,
            externalSpoolActive: false,
            slots: Array.from({ length: 4 }, (_, slot) => ({
              slot,
              present: true,
              material: 'PLA',
              color: '#FFFFFF',
              remainingPercent: 100,
              active: slot === 0,
            })),
          },
        });
      if (url.pathname.endsWith('/data')) {
        if (selected === second.id) {
          secondRequests++;
          await pending.promise;
        }
        return route.fulfill({ json: metadata(selected, 2, true) });
      }
      if (url.pathname.endsWith('/print')) prints++;
      return route.abort();
    });
    const snapshot = () =>
      page.evaluate(() => {
        const bounds = document.querySelector('.plate-thumbnails')!.getBoundingClientRect();
        return {
          bodyHeight: document.body.scrollHeight,
          viewportHeight: window.innerHeight,
          scrollbarWidth: window.innerWidth - document.documentElement.clientWidth,
          scrollY: window.scrollY,
          list: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
        };
      });
    try {
      await page.goto(`/preview/${plateId}/${first.id}`);
      await page.addStyleTag({ content: '::-webkit-scrollbar { width: 15px; height: 15px; }' });
      await ready(page);
      await expect(page.getByRole('button', { name: 'AMS スロット4', exact: true })).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const original = await snapshot();
      expect(original.bodyHeight).toBeGreaterThan(original.viewportHeight);
      expect(original.scrollbarWidth).toBe(15);
      expect(original.scrollY).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'プレート 2', exact: true }).click();
      await expect.poll(() => secondRequests).toBe(1);
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'AMS スロット4', exact: true })).toHaveCount(0);
      const loading = await snapshot();
      for (const dimension of ['x', 'y', 'width', 'height'] as const)
        expect.soft(Math.abs(loading.list[dimension] - original.list[dimension])).toBeLessThan(1);
      expect.soft(loading.scrollY).toBe(original.scrollY);
      pending.release();
      await ready(page);
      await expect(page.getByRole('button', { name: 'AMS スロット4', exact: true })).toBeVisible();
      const completed = await snapshot();
      expect(completed.bodyHeight).toBeGreaterThan(completed.viewportHeight);
      for (const dimension of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(completed.list[dimension] - original.list[dimension])).toBeLessThan(1);
      expect(completed.scrollY).toBe(original.scrollY);
      expect(prints).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      pending.release();
      await browser.close();
    }
  });
});

test('ignores a late plate response and restores each plate print outcome and AMS settings', async ({
  page,
}) => {
  const pending = gate();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let secondRequests = 0;
  let secondResponseFinished = false;
  const prints: { previewId: string; key: string; settings: unknown }[] = [];
  await page.route(endpoints, async (route) => {
    const url = new URL(route.request().url());
    const selected = url.searchParams.get('previewId') ?? first.id;
    if (url.pathname.endsWith('/thumbnail')) return thumbnail(route);
    if (url.pathname.endsWith('/gcode'))
      return route.fulfill({
        contentType: 'text/plain',
        body:
          selected === third.id
            ? GCODE + 'G1 Z0.6\nG1 X30 Y30 E1\nG1 Z0.8\nG1 X40 Y40 E1\n'
            : GCODE,
      });
    if (url.pathname.endsWith('/printer'))
      return route.fulfill({
        json: {
          observedAt: '2026-10-21T04:00:00.000Z',
          gcodeState: 'IDLE',
          amsConnected: true,
          currentSlot: null,
          externalSpoolActive: true,
          slots: [
            {
              slot: 1,
              present: true,
              material: 'PLA',
              color: '#FFFFFF',
              remainingPercent: 100,
              active: false,
            },
          ],
        },
      });
    if (url.pathname.endsWith('/print')) {
      const key = route.request().headers()['idempotency-key']!;
      prints.push({ previewId: selected, key, settings: route.request().postDataJSON() });
      return route.fulfill({
        status: selected === first.id ? 504 : 200,
        json: {
          id: key,
          state: selected === first.id ? 'unknown' : 'accepted',
          error: null,
        },
      });
    }
    if (url.pathname.endsWith('/data')) {
      if (selected === second.id) {
        secondRequests++;
        await pending.promise;
      }
      await route.fulfill({ json: metadata(selected, 3, true) });
      if (selected === second.id) secondResponseFinished = true;
      return;
    }
    return route.abort();
  });
  try {
    await page.goto(`/preview/${plateId}/${first.id}`);
    await ready(page);
    await page.getByRole('button', { name: 'AMS スロット2', exact: true }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '印刷', exact: true }).click();
    await expect(page.getByRole('button', { name: '結果不明', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'プレート 2', exact: true }).click();
    await expect.poll(() => secondRequests).toBe(1);
    await page.getByRole('button', { name: 'プレート 3', exact: true }).click();
    await expect(page).toHaveURL(`/preview/${plateId}/${third.id}`);
    await ready(page);
    pending.release();
    await expect.poll(() => secondResponseFinished).toBe(true);
    await expect(page.getByRole('button', { name: 'プレート 3', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('slider', { name: 'レイヤー', exact: true })).toHaveAttribute(
      'max',
      '4',
    );
    await expect(page.getByText('9分', { exact: true })).toBeVisible();
    await expect(page.getByLabel('外部スプール', { exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: '印刷', exact: true })).toBeEnabled();
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('プレート 3');
      expect(dialog.message()).toContain('供給元: 外部スプール');
      void dialog.accept();
    });
    await page.getByRole('button', { name: '印刷', exact: true }).click();
    await expect(page.getByRole('button', { name: '受付済み', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'プレート 1', exact: true }).click();
    await ready(page);
    await expect(page.getByRole('button', { name: '結果不明', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'AMS スロット2', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.goBack();
    await expect(page).toHaveURL(`/preview/${plateId}/${third.id}`);
    await ready(page);
    await expect(page.getByRole('button', { name: '受付済み', exact: true })).toBeDisabled();
    expect(prints).toHaveLength(2);
    expect(prints[0]).toMatchObject({
      previewId: first.id,
      settings: { useAms: true, amsMapping: [1] },
    });
    expect(prints[1]).toMatchObject({ previewId: third.id, settings: { useAms: false } });
    expect(prints[0]!.key).not.toBe(prints[1]!.key);
    expect(errors).toEqual([]);
  } finally {
    pending.release();
  }
});

test('opens history and canonical preview links in the same document', async ({ page }) => {
  await page.route('**/history/data*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: first.id,
            plateId,
            previewId: first.id,
            plateCount: 2,
            name: 'plates.stl',
            createdAt: '2026-10-21T04:00:00.000Z',
            format: 'gcode.3mf',
            estimatedSeconds: 180,
            filamentGrams: 1.2,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  let prints = 0;
  await page.route(endpoints, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/thumbnail')) return thumbnail(route);
    if (url.pathname.endsWith('/gcode'))
      return route.fulfill({ contentType: 'text/plain', body: GCODE });
    if (url.pathname.endsWith('/data')) return route.fulfill({ json: metadata(first.id, 2) });
    if (url.pathname.endsWith('/print')) prints++;
    return route.abort();
  });
  await page.goto('/history');
  await expect(page.getByRole('link', { name: /plates.stl/ })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.routingSession = 'same-document';
  });
  let documentNavigations = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documentNavigations++;
  });
  const expectSameDocument = async () => {
    expect(await page.locator('html').getAttribute('data-routing-session')).toBe('same-document');
    expect(documentNavigations).toBe(0);
    expect(prints).toBe(0);
  };
  await page.getByRole('link', { name: /plates.stl/ }).click();
  await expect(page).toHaveURL(`/preview/${plateId}/${first.id}`);
  await ready(page);
  await expectSameDocument();
  await page.getByRole('link', { name: '履歴', exact: true }).click();
  await expect(page).toHaveURL('/history');
  await expect(page.getByRole('link', { name: /plates.stl/ })).toBeVisible();
  await expectSameDocument();
  await page.goBack();
  await expect(page).toHaveURL(`/preview/${plateId}/${first.id}`);
  await ready(page);
  await expectSameDocument();
  await page.goForward();
  await expect(page).toHaveURL('/history');
  await expect(page.getByRole('heading', { name: 'スライス履歴', exact: true })).toBeVisible();
  await expectSameDocument();
});

test('normalizes legacy history and plate ID links while preserving the preview print outcome', async ({
  page,
}) => {
  const canonical = `/preview/${plateId}/${first.id}`;
  for (const shortId of [first.id, plateId]) {
    await page.route(`**/preview/${shortId}`, (route) =>
      route.fulfill({ status: 302, headers: { location: canonical } }),
    );
  }
  await page.route('**/history/data*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: first.id,
            name: 'legacy.stl',
            createdAt: '2026-10-21T04:00:00.000Z',
            format: 'gcode.3mf',
            estimatedSeconds: 180,
            filamentGrams: 1.2,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  let prints = 0;
  await page.route(endpoints, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/thumbnail')) return thumbnail(route);
    if (url.pathname.endsWith('/gcode'))
      return route.fulfill({ contentType: 'text/plain', body: GCODE });
    if (url.pathname.endsWith('/data')) return route.fulfill({ json: metadata(first.id, 2, true) });
    if (url.pathname.endsWith('/printer'))
      return route.fulfill({
        json: {
          observedAt: '2026-10-21T04:00:00.000Z',
          gcodeState: 'IDLE',
          amsConnected: false,
          currentSlot: null,
          externalSpoolActive: true,
          slots: [],
        },
      });
    if (url.pathname.endsWith('/print')) {
      prints++;
      expect(url.searchParams.get('previewId')).toBe(first.id);
      return route.fulfill({
        status: 504,
        json: {
          id: route.request().headers()['idempotency-key'],
          state: 'unknown',
          error: null,
        },
      });
    }
    return route.abort();
  });
  await page.goto(canonical);
  await ready(page);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '印刷', exact: true }).click();
  await expect(page.getByRole('button', { name: '結果不明', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: '履歴', exact: true }).click();
  const legacy = page.getByRole('link', { name: /legacy.stl/ });
  await expect(legacy).toHaveAttribute('href', `/preview/${first.id}`);
  await legacy.click();
  await expect(page).toHaveURL(canonical);
  await ready(page);
  await expect(page.getByRole('button', { name: '結果不明', exact: true })).toBeDisabled();
  await page.locator('.preview-ids summary').click();
  await expect(page.locator('.preview-ids dd').nth(0)).toHaveText(plateId);
  await expect(page.locator('.preview-ids dd').nth(1)).toHaveText(first.id);
  await page.getByRole('link', { name: plateId, exact: true }).click();
  await expect(page).toHaveURL(canonical);
  await ready(page);
  await expect(page.getByRole('button', { name: '結果不明', exact: true })).toBeDisabled();
  expect(prints).toBe(1);
});
