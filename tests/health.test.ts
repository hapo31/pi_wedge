import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
describe('phase 0', () => {
  it('serves health, local Swagger assets and OpenAPI 3.1', async () => {
    const app = createApp();
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok' });
    expect((await app.request('/docs')).status).toBe(200);
    expect((await app.request('/swagger/swagger-ui-bundle.js')).status).toBe(200);
    const spec = await (await app.request('/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/health'].get.operationId).toBe('health');
  });
});
