import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'pi-wedge',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'replace-with-a-random-storage-secret',
  },
});
const Bucket = process.env.S3_BUCKET ?? 'pi-wedge';
const Key = process.argv[2] === '--read' ? process.argv[3] : randomUUID();
if (!Key) throw new Error('UUID required');
if (process.argv[2] !== '--read')
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: 'pi_wedge persistence probe' }));
const result = await s3.send(new GetObjectCommand({ Bucket, Key }));
if ((await result.Body?.transformToString()) !== 'pi_wedge persistence probe')
  throw new Error('Persistence mismatch');
console.info(`S3 verified: ${Key}`);
if (process.argv[2] !== '--keep') await s3.send(new DeleteObjectCommand({ Bucket, Key }));
s3.destroy();
