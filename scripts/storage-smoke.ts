import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Storage } from '../src/adapters/storage.js';
import { readConfig } from '../src/config.js';
const storage = new S3Storage(readConfig());
const id = process.argv[2] === '--read' ? process.argv[3] : randomUUID();
if (!id) throw new Error('UUID required');
try {
  await storage.check();
  if (process.argv[2] !== '--read')
    await storage.put(id, Readable.from('pi_wedge persistence probe'), 26);
  const size = await storage.head(id);
  if (size?.size !== 26) throw new Error('Object size mismatch');
  const body = await storage.get(id);
  let text = '';
  for await (const chunk of body) text += String(chunk);
  if (text !== 'pi_wedge persistence probe') throw new Error('Persistence mismatch');
  console.info(`S3 adapter verified: ${id}`);
  if (process.argv[2] !== '--keep') await storage.delete(id);
} finally {
  storage.close();
}
