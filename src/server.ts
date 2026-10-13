import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { bootstrap } from './bootstrap.js';
const config = readConfig();
const services = await bootstrap(config);
const server = serve(
  { fetch: createApp(services).fetch, port: config.PORT, hostname: config.HOST },
  () => console.info(`pi_wedge listening on ${config.HOST}:${config.PORT}`),
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void services
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
