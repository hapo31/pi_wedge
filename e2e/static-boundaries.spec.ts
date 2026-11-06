import { test, expect } from '@playwright/test';

test('serves the built UI and Swagger assets without exposing private API files', async ({
  request,
}) => {
  const history = await request.get('/history');
  expect(history.status()).toBe(200);
  const html = await history.text();
  const assets = Array.from(
    html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g),
    (match) => match[1]!,
  );
  expect(assets.some((path) => path.endsWith('.js'))).toBe(true);
  expect(assets.some((path) => path.endsWith('.css'))).toBe(true);
  for (const path of assets) {
    const asset = await request.get(path);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toContain(
      path.endsWith('.css') ? 'text/css' : 'javascript',
    );
    expect((await asset.body()).length).toBeGreaterThan(0);
  }
  for (const path of ['/swagger/swagger-ui.css', '/swagger/swagger-ui-bundle.js']) {
    const asset = await request.get(path);
    expect(asset.status()).toBe(200);
    expect((await asset.body()).length).toBeGreaterThan(0);
  }
  const privateFile = await request.get('/api/files/0198cdf0-b8f1-4de0-8d67-2d9e95ed019c/download');
  expect(privateFile.status()).toBe(401);
  expect(await privateFile.json()).toMatchObject({ error: { code: 'unauthorized' } });
});
