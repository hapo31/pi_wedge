import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProcessRunner } from '../src/adapters/command.js';
import { OrcaSlicerAdapter } from '../src/adapters/orca.js';
import { openArchive, openGcode, listPlates } from '../src/adapters/gcode.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';
import { readConfig } from '../src/config.js';
import { GCODE, storedEntries, TOKEN } from './helpers.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function content(path: string, name: string) {
  const { zip, entries } = await openArchive(path);
  try {
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
      zip.openReadStream(
        entries.find((e) => e.fileName === name)!,
        (e, stream) => (e ? reject(e) : resolve(stream!)),
      ),
    );
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(Buffer.from(part));
    return Buffer.concat(parts).toString();
  } finally {
    zip.close();
  }
}
function container(gcode = GCODE) {
  const core = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const prod = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return storedEntries(
    Object.entries({
      '[Content_Types].xml': '<Types/>',
      '3D/3dmodel.model': `<model xmlns="${core}" xmlns:p="${prod}" requiredextensions="p"><resources><object id="2"><components><component p:path="/3D/Objects/cube.model" objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 80 80 0"/></build></model>`,
      '3D/Objects/cube.model': `<model xmlns="${core}"><resources><object id="1"><mesh/></object></resources></model>`,
      '3D/_rels/3dmodel.model.rels': `<Relationships xmlns="${rels}"><Relationship Target="/3D/Objects/cube.model" Id="1" Type="model"/></Relationships>`,
      'Metadata/project_settings.config': JSON.stringify({
        printer_model: 'Bambu Lab A1 mini',
        nozzle_diameter: ['0.4'],
      }),
      'Metadata/model_settings.config':
        '<config><object id="2"><part id="1"/></object><plate><metadata key="plater_id" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate></config>',
      'Metadata/_rels/model_settings.config.rels': `<Relationships xmlns="${rels}"><Relationship Target="/Metadata/plate_1.gcode" Id="1" Type="gcode"/></Relationships>`,
      'Metadata/slice_info.config':
        '<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="62"/></plate></config>',
      'Metadata/filament_sequence.json': '{"plate_1":{"sequence":[1]}}',
      'Metadata/plate_1.gcode': gcode,
      'Metadata/plate_1.gcode.md5': createHash('md5').update(gcode).digest('hex'),
      'Metadata/plate_1.json': '{"bbox_all":[80,80,100,100]}',
    }).map(([name, text]) => [name, Buffer.from(text)] as [string, Buffer]),
  );
}
it('runs the bounded Python merger, retains G-code/md5/meshes and moves the model grid as plates grow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-merge-'));
  dirs.push(dir);
  const parent = join(dir, 'parent.3mf'),
    added = join(dir, 'new.3mf');
  await writeFile(parent, container());
  await writeFile(added, container(GCODE.replace('1m 2s', '3m')));
  const runner = new ProcessRunner(10000);
  let current = parent;
  for (let plate = 2; plate <= 5; plate++) {
    const next = join(dir, `combined-${plate}.3mf`);
    await runner.run(
      '/usr/bin/python3',
      [resolve('scripts/append-plate.py'), current, added, next, '1048576'],
      dir,
    );
    expect(await listPlates(next)).toEqual(Array.from({ length: plate }, (_, i) => i + 1));
    expect(await content(next, 'Metadata/plate_1.gcode')).toBe(GCODE);
    expect(await content(next, `Metadata/plate_${plate}.gcode`)).toBe(GCODE.replace('1m 2s', '3m'));
    expect(await content(next, `Metadata/plate_${plate}.gcode.md5`)).toBe(
      createHash('md5').update(GCODE.replace('1m 2s', '3m')).digest('hex'),
    );
    expect(await content(next, `3D/Objects/plate_${plate}_cube.model`)).toContain('mesh');
    expect(await content(next, 'Metadata/model_settings.config')).toContain(
      `key="plater_id" value="${plate}"`,
    );
    expect(await content(next, '3D/3dmodel.model')).toContain(`id="${plate + 1}"`);
    current = next;
  }
  const model = await content(current, '3D/3dmodel.model');
  expect(model).toContain('1 0 0 0 1 0 0 0 1 512 80 0'); // Third plate moved to column 3.
  expect(model).toContain('1 0 0 0 1 0 0 0 1 296 -136 0'); // New fifth plate.
  expect(JSON.parse(await content(current, 'Metadata/filament_sequence.json'))).toHaveProperty(
    'plate_5',
  );
  const tooLarge = join(dir, 'too-large.3mf');
  await expect(
    runner.run(
      '/usr/bin/python3',
      [resolve('scripts/append-plate.py'), parent, added, tooLarge, '1'],
      dir,
    ),
  ).rejects.toMatchObject({ code: 'command_failed' });
});
it('uses the Slicer boundary for append and returns only the new plate statistics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-orca-append-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'machine.json'),
    JSON.stringify({ printer_model: 'Bambu Lab A1 mini', nozzle_diameter: ['0.4'] }),
  );
  await writeFile(join(dir, 'process.json'), '{}');
  await writeFile(join(dir, 'filament.json'), '{}');
  const parent = join(dir, 'parent.3mf');
  await writeFile(parent, container());
  const native = new ProcessRunner(10000);
  const runner = {
    run: vi.fn(async (command: string, args: string[], cwd: string) => {
      if (command === '/trusted/orca') {
        await writeFile(join(cwd, 'result.gcode.3mf'), container(GCODE.replace('1m 2s', '3m')));
        return { stdout: '', stderr: '' };
      }
      return native.run(command, args, cwd);
    }),
  };
  const adapter = new OrcaSlicerAdapter(
    runner,
    readConfig({
      API_TOKEN: TOKEN,
      STORAGE_BACKEND: 'local',
      PROFILE_DIR: dir,
      ORCA_BIN: '/trusted/orca',
    }),
  );
  const result = await adapter.slice(
    { id: randomUUID(), format: 'stl', path: join(dir, 'model.stl'), workDir: dir },
    SliceOptionsSchema.parse({}),
    { path: parent, plate: 2 },
  );
  expect(result).toMatchObject({ format: 'gcode.3mf', plate: 2, estimatedSeconds: 180 });
  expect(await listPlates(result.path)).toEqual([1, 2]);
  const stream = await openGcode(result.path, 'gcode.3mf', 1048576, 2);
  stream.destroy();
  expect(runner.run).toHaveBeenCalledWith(
    '/usr/bin/python3',
    expect.arrayContaining([resolve('scripts/append-plate.py'), parent]),
    dir,
  );
});
