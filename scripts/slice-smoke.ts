import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readConfig } from '../src/config.js';
import { bootstrap } from '../src/bootstrap.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';
const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Provide STL/STEP model paths');
const services = await bootstrap(readConfig());
try {
  if (!services.ready) throw new Error('Dependencies not ready');
  for (const path of paths) {
    const file = await services.files.upload(new File([await readFile(path)], basename(path)));
    const job = services.jobs.create(file.id, SliceOptionsSchema.parse({}));
    await services.jobs.idle();
    const result = services.jobs.get(job.id);
    console.info(JSON.stringify(result));
    if (result.state !== 'succeeded') throw new Error(`Slice failed: ${result.error?.code}`);
    const metadata = services.files.ready(result.resultFileId!);
    console.info(JSON.stringify(metadata));
    const gcode = await services.preview.text(metadata.id);
    console.info(`Preview bytes: ${Buffer.byteLength(gcode)}`);
  }
} finally {
  await services.close();
}
