import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readConfig } from '../src/config.js';
import { bootstrap } from '../src/bootstrap.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';
const append = process.argv.includes('--append');
const paths = process.argv.slice(2).filter((arg) => arg !== '--append');
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
    if (append) {
      const before = await services.preview.details(metadata.id);
      for (let number = 2; number <= 3; number++) {
        const child = await services.jobs.createWithParent(
          file.id,
          SliceOptionsSchema.parse({ layerHeight: number === 2 ? 0.16 : 0.2 }),
          `追加 ${number}`,
          metadata.id,
        );
        await services.jobs.idle();
        const done = services.jobs.get(child.id);
        console.info(JSON.stringify(done));
        if (done.state !== 'succeeded') throw new Error(`Append failed: ${done.error?.code}`);
        const current = await services.preview.details(before.plateId, done.resultFileId!);
        if (current.plates.length !== number || current.plate !== number)
          throw new Error('Unexpected plate selection');
        const text = await services.preview.selectedText(before.plateId, done.resultFileId!);
        console.info(
          `Appended plate ${number}: ${Buffer.byteLength(text)} preview bytes; plate UUID ${before.plateId}`,
        );
      }
      if ((await services.preview.selectedText(before.plateId, metadata.id)) !== gcode)
        throw new Error('Original G-code changed');
    }
  }
} finally {
  await services.close();
}
