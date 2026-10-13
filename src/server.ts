import { serve } from '@hono/node-server';
import { createApp } from './app.js';
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '127.0.0.1';
const server = serve({ fetch: createApp().fetch, port, hostname }, () =>
  console.info(`pi_wedge listening on ${hostname}:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
