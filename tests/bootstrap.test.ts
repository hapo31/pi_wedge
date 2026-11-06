import { expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { bootstrap } from '../src/bootstrap.js';
import { MODEL, TOKEN } from './helpers.js';
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

it('recovers interrupted local writes before reconciling staged metadata on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-recovery-')),
    config = readConfig({ API_TOKEN: TOKEN, DATA_DIR: dir, STORAGE_BACKEND: 'local' });
  let owner = await bootstrap(config);
  try {
    const committed = await owner.files.upload(new File([MODEL], 'triangle.stl'));
    committed.state = 'staging';
    owner.files.repository.save('file', committed);
    const orphan = `${randomUUID()}.${randomUUID()}.tmp`;
    await writeFile(join(dir, 'objects', orphan), 'interrupted');
    await writeFile(join(dir, 'objects', 'administrator.tmp'), 'keep');
    await owner.close();
    owner = await bootstrap(config);
    expect(owner.ready).toBe(true);
    expect(owner.files.metadata(committed.id).state).toBe('ready');
    const names = await readdir(join(dir, 'objects'));
    expect(names).not.toContain(orphan);
    expect(names).toEqual(expect.arrayContaining([committed.id, 'administrator.tmp']));
  } finally {
    await owner.close();
    await rm(dir, { recursive: true, force: true });
  }
});
