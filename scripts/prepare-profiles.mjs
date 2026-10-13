import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const version = 'v2.4.2';
const base = `https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/${version}/resources/profiles/`;
const out = resolve(process.env.PROFILE_DIR ?? 'profiles/generated');
const sources = [];
async function fetchJson(path) {
  const url = base + path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Profile download failed: ${path} (${response.status})`);
  const text = await response.text();
  sources.push({ path, url, sha256: createHash('sha256').update(text).digest('hex') });
  return JSON.parse(text);
}
const catalog = await fetchJson('BBL.json');
async function flatten(group, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Cyclic profile inheritance: ${name}`);
  seen.add(name);
  const entry = catalog[`${group}_list`].find((e) => e.name === name);
  if (!entry) throw new Error(`Unknown upstream profile: ${group}/${name}`);
  const profile = await fetchJson(`BBL/${entry.sub_path}`);
  const inherited = profile.inherits ? await flatten(group, profile.inherits, seen) : {};
  const result = { ...inherited, ...profile };
  delete result.inherits;
  return result;
}
await mkdir(out, { recursive: true });
for (const [file, group, name] of [
  ['machine.json', 'machine', 'Bambu Lab A1 mini 0.4 nozzle'],
  ['process.json', 'process', '0.20mm Standard @BBL A1M'],
  ['filament.json', 'filament', 'Generic PLA @BBL A1M'],
]) {
  const profile = await flatten(group, name);
  await writeFile(join(out, file), JSON.stringify(profile, null, 2) + '\n');
}
await writeFile(
  join(out, 'manifest.json'),
  JSON.stringify(
    {
      version,
      license: 'AGPL-3.0 (upstream profiles)',
      licenseUrl: `https://github.com/OrcaSlicer/OrcaSlicer/blob/${version}/LICENSE`,
      sources,
    },
    null,
    2,
  ) + '\n',
);
console.info(`A1 mini / 0.4mm / Generic PLA profiles prepared: ${out}`);
