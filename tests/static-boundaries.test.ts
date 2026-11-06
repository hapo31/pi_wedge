import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setup, MODEL } from './helpers.js';

const contexts: Array<Awaited<ReturnType<typeof setup>>> = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

it('serves installed Swagger assets publicly while protecting uploaded models and API data', async () => {
  const context = await setup();
  contexts.push(context);
  const model = await context.files.upload(new File([MODEL], 'private-model.stl'));
  const read = vi.spyOn(context.storage, 'get');
  const require = createRequire(import.meta.url);
  const swaggerRoot = dirname(require.resolve('swagger-ui-dist/package.json'));
  for (const name of ['swagger-ui.css', 'swagger-ui-bundle.js']) {
    const response = await context.app.request(`/swagger/${name}`);
    expect(response.status).toBe(200);
    expect(
      Buffer.from(await response.arrayBuffer()).equals(await readFile(join(swaggerRoot, name))),
    ).toBe(true);
  }
  for (const path of [
    `/api/files/${model.id}`,
    `/api/files/${model.id}/download`,
    `/assets/../../api/files/${model.id}/download`,
    `/swagger/../../api/files/${model.id}/download`,
  ]) {
    const response = await context.app.request(path);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  }
  for (const prefix of ['assets', 'swagger']) {
    const response = await context.app.request(`/${prefix}/%252e%252e/%252e%252e/.env`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  }
  expect(read).not.toHaveBeenCalled();
  expect(context.adapter.startPrint).not.toHaveBeenCalled();
});
