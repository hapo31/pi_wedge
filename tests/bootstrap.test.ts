import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { bootstrap } from '../src/bootstrap.js';
import { TOKEN } from './helpers.js';
it('prevents a second process from recovering or deleting the active server workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-owner-')),
    config = readConfig({ API_TOKEN: TOKEN, DATA_DIR: dir, STORAGE_BACKEND: 'local' });
  let owner = await bootstrap(config);
  try {
    await expect(bootstrap(config)).rejects.toThrow('already owned');
    await owner.close();
    owner = await bootstrap(config);
    expect(owner.ready).toBe(true);
  } finally {
    await owner.close();
    await rm(dir, { recursive: true, force: true });
  }
});
