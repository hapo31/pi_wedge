import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export function createApp() {
  const app = new OpenAPIHono();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      operationId: 'health',
      summary: 'Server liveness',
      description: 'No physical printer side effects. Liveness only; not a dependency check.',
      responses: {
        200: {
          description: 'Server running',
          content: {
            'application/json': {
              schema: z.object({ status: z.literal('ok') }),
              example: { status: 'ok' },
            },
          },
        },
      },
    }),
    (c) => c.json({ status: 'ok' as const }, 200),
  );
  const require = createRequire(import.meta.url);
  const swaggerRoot = dirname(require.resolve('swagger-ui-dist/package.json'));
  app.get(
    '/swagger/*',
    serveStatic({ root: swaggerRoot, rewriteRequestPath: (p) => p.replace('/swagger/', '') }),
  );
  app.get('/docs', (c) =>
    c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>pi_wedge API</title><link rel="stylesheet" href="/swagger/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/swagger/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false})</script></body></html>`,
    ),
  );
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'pi_wedge',
      version: '0.1.0',
      description:
        'LAN slicing and explicit A1 mini printing. Physical actions only on /api/printer/print.',
    },
  });
  return app;
}
