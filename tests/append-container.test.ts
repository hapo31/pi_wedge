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
function containerEntries(gcode = GCODE, size = 20): Record<string, string> {
  const core = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const prod = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return {
    '[Content_Types].xml': '<Types/>',
    '3D/3dmodel.model': `<model xmlns="${core}" xmlns:p="${prod}" requiredextensions="p"><resources><object id="2"><components><component p:path="/3D/Objects/cube.model" objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 80 80 0"/></build></model>`,
    '3D/Objects/cube.model': `<model xmlns="${core}" xmlns:p="${prod}"><resources><object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="${size}" y="0" z="0"/><vertex x="0" y="${size}" z="0"/><vertex x="0" y="0" z="${size}"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources></model>`,
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
  };
}
function pack(entries: Record<string, string>) {
  return storedEntries(
    Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)] as [string, Buffer]),
  );
}
function container(gcode = GCODE, size = 20) {
  return pack(containerEntries(gcode, size));
}
function legacyContainer() {
  const entries = containerEntries();
  const second = containerEntries(GCODE.replace('1m 2s', '3m'), 30);
  const model = '3D/3dmodel.model';
  entries[model] = entries[model]!.replace(
    '</resources>',
    '<object id="3"><components><component p:path="/3D/Objects/plate_2_cube.model" objectid="1"/></components></object></resources>',
  ).replace('</build>', '<item objectid="3" transform="1 0 0 0 1 0 0 0 1 296 80 0"/></build>');
  entries['Metadata/model_settings.config'] = entries['Metadata/model_settings.config']!.replace(
    '</config>',
    '<object id="3"><part id="1"><metadata key="mesh_shared" value="1"/></part></object><plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance></plate></config>',
  );
  entries['3D/Objects/plate_2_cube.model'] = second['3D/Objects/cube.model']!;
  for (const [name, text] of Object.entries(second))
    if (name.startsWith('Metadata/plate_1')) entries[name.replace('plate_1', 'plate_2')] = text;
  return pack(entries);
}
async function importedMeshes(path: string) {
  // Bambu/Orca's _generate_volumes caches by numeric mesh ID across model
  // paths. Exercise that behavior with different geometries, not identical cubes.
  const { stdout } = await new ProcessRunner(10000).run(
    '/usr/bin/python3',
    [
      '-c',
      `import json, sys, zipfile, xml.etree.ElementTree as E
c = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'
p = '{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}'
with zipfile.ZipFile(sys.argv[1]) as z:
    model = E.fromstring(z.read('3D/3dmodel.model'))
    settings = E.fromstring(z.read('Metadata/model_settings.config'))
    shared, result = {}, []
    for item in model.find(c + 'build'):
        obj = model.find(c + "resources/" + c + "object[@id='" + item.get('objectid') + "']")
        for component in obj.findall(c + 'components/' + c + 'component'):
            mid = component.get('objectid')
            part = settings.find("object[@id='" + obj.get('id') + "']/part[@id='" + mid + "']")
            assert part is not None, 'model_settings part reference is missing'
            meta = part.find("metadata[@key='mesh_shared']")
            key = mid if meta is None else meta.get('value')
            mesh = E.fromstring(z.read(component.get(p + 'path').lstrip('/')))
            leaf = mesh.find(c + "resources/" + c + "object[@id='" + mid + "']")
            assert leaf is not None, 'component mesh reference is missing'
            vertices = leaf.findall(c + 'mesh/' + c + 'vertices/' + c + 'vertex')
            size = [max(float(v.get(a)) for v in vertices) - min(float(v.get(a)) for v in vertices) for a in ['x','y','z']]
            actual = shared.setdefault(key, size)
            result.append({'id': mid, 'size': actual, 'transform': item.get('transform'), 'uuid': leaf.get(p + 'UUID')})
    print(json.dumps(result))`,
      path,
    ],
    tmpdir(),
  );
  return JSON.parse(stdout) as {
    id: string;
    size: number[];
    transform: string;
    uuid: string;
  }[];
}
it('keeps different appended meshes distinct when Bambu/Orca shares geometry by numeric ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-distinct-meshes-'));
  dirs.push(dir);
  const runner = new ProcessRunner(10000);
  let current = join(dir, 'parent.3mf');
  await writeFile(current, container());
  for (const size of [30, 40]) {
    const added = join(dir, `added-${size}.3mf`);
    const output = join(dir, `combined-${size}.3mf`);
    await writeFile(added, container(GCODE.replace('1m 2s', `${size}m`), size));
    await runner.run(
      '/usr/bin/python3',
      [resolve('scripts/append-plate.py'), current, added, output, '1048576'],
      dir,
    );
    current = output;
  }
  const meshes = await importedMeshes(current);
  expect(meshes.map((m) => m.size)).toEqual([
    [20, 20, 20],
    [30, 30, 30],
    [40, 40, 40],
  ]);
  expect(new Set(meshes.map((m) => m.id)).size).toBe(3);
  expect(new Set(meshes.map((m) => m.uuid)).size).toBe(3);
  expect(meshes.map((m) => m.transform)).toEqual([
    '1 0 0 0 1 0 0 0 1 80 80 0',
    '1 0 0 0 1 0 0 0 1 296 80 0',
    '1 0 0 0 1 0 0 0 1 80 -136 0',
  ]);
});
it('repairs legacy containers and their shared-mesh references without changing G-code or placement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-repair-meshes-'));
  dirs.push(dir);
  const runner = new ProcessRunner(10000);
  const legacy = join(dir, 'legacy.3mf');
  const repaired = join(dir, 'repaired.3mf');
  await writeFile(legacy, legacyContainer());
  // Demonstrate the reported corruption with Bambu's cache semantics.
  expect((await importedMeshes(legacy)).map((m) => m.size)).toEqual([
    [20, 20, 20],
    [20, 20, 20],
  ]);
  await runner.run(
    '/usr/bin/python3',
    [resolve('scripts/append-plate.py'), '--repair', legacy, repaired, '1048576'],
    dir,
  );
  expect((await importedMeshes(repaired)).map((m) => m.size)).toEqual([
    [20, 20, 20],
    [30, 30, 30],
  ]);
  expect((await importedMeshes(repaired)).map((m) => m.transform)).toEqual(
    (await importedMeshes(legacy)).map((m) => m.transform),
  );
  for (const name of [
    'Metadata/plate_1.gcode',
    'Metadata/plate_2.gcode',
    'Metadata/plate_1.gcode.md5',
    'Metadata/plate_2.gcode.md5',
    'Metadata/plate_2.json',
    'Metadata/project_settings.config',
  ])
    expect(await content(repaired, name)).toBe(await content(legacy, name));
  for (const name of ['3D/Objects/cube.model', '3D/Objects/plate_2_cube.model'])
    expect((await content(repaired, name)).split('<mesh>')[1]).toBe(
      (await content(legacy, name)).split('<mesh>')[1],
    );
  const repeated = join(dir, 'repaired-again.3mf');
  await runner.run(
    '/usr/bin/python3',
    [resolve('scripts/append-plate.py'), '--repair', repaired, repeated, '1048576'],
    dir,
  );
  for (const name of ['3D/3dmodel.model', 'Metadata/model_settings.config'])
    expect(await content(repeated, name)).toBe(await content(repaired, name));
  const added = join(dir, 'new.3mf');
  const combined = join(dir, 'combined.3mf');
  await writeFile(added, container(GCODE, 40));
  // An append must also normalize older parents, without a separate repair.
  await runner.run(
    '/usr/bin/python3',
    [resolve('scripts/append-plate.py'), legacy, added, combined, '1048576'],
    dir,
  );
  expect((await importedMeshes(combined)).map((m) => m.size)).toEqual([
    [20, 20, 20],
    [30, 30, 30],
    [40, 40, 40],
  ]);
});
it('streams mesh XML larger than the metadata limit and rejects entity declarations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-large-mesh-'));
  dirs.push(dir);
  const runner = new ProcessRunner(10000);
  const entries = containerEntries();
  const mesh = '3D/Objects/cube.model';
  entries[mesh] = entries[mesh]!.replace('<mesh>', `<mesh>${' '.repeat(8 * 1048576)}`);
  const input = join(dir, 'large.3mf');
  const output = join(dir, 'repaired.3mf');
  await writeFile(input, pack(entries));
  await runner.run(
    '/usr/bin/python3',
    [resolve('scripts/append-plate.py'), '--repair', input, output, String(16 * 1048576)],
    dir,
  );
  expect((await importedMeshes(output))[0]?.size).toEqual([20, 20, 20]);
  expect((await content(output, mesh)).split('<mesh>')[1]).toBe(entries[mesh]!.split('<mesh>')[1]);
  entries[mesh] = '<!DOCTYPE model [<!ENTITY x "expanded">]>' + entries[mesh];
  const invalid = join(dir, 'entity.3mf');
  await writeFile(invalid, pack(entries));
  await expect(
    runner.run(
      '/usr/bin/python3',
      [resolve('scripts/append-plate.py'), '--repair', invalid, join(dir, 'bad.3mf'), '16777216'],
      dir,
    ),
  ).rejects.toMatchObject({ code: 'command_failed' });
});
it('updates multiple parts in one streamed model with consistent component references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-multipart-mesh-'));
  dirs.push(dir);
  const entries = containerEntries();
  const second = containerEntries(GCODE, 30);
  entries['3D/Objects/cube.model'] = entries['3D/Objects/cube.model']!.replace(
    '</resources>',
    second['3D/Objects/cube.model']!.match(/<object.*<\/object>/)![0].replace('id="1"', 'id="2"') +
      '</resources>',
  );
  entries['3D/3dmodel.model'] = entries['3D/3dmodel.model']!.replace(
    '</components>',
    '<component p:path="/3D/Objects/cube.model" objectid="2"/></components>',
  );
  entries['Metadata/model_settings.config'] = entries['Metadata/model_settings.config']!.replace(
    '<part id="1"/>',
    '<part id="1"/><part id="2"/>',
  );
  const input = join(dir, 'parts.3mf');
  const output = join(dir, 'repaired.3mf');
  await writeFile(input, pack(entries));
  await new ProcessRunner(10000).run(
    '/usr/bin/python3',
    [resolve('scripts/append-plate.py'), '--repair', input, output, '1048576'],
    dir,
  );
  const meshes = await importedMeshes(output);
  expect(meshes.map((m) => m.size)).toEqual([
    [20, 20, 20],
    [30, 30, 30],
  ]);
  expect(new Set(meshes.map((m) => m.id)).size).toBe(2);
});
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
