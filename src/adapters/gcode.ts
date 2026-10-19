import yauzl from 'yauzl';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { AppError } from '../domain/errors.js';
export function openGcode(
  path: string,
  format: 'gcode' | 'gcode.3mf',
  maxBytes: number,
): Promise<Readable> {
  if (format === 'gcode') return Promise.resolve(bounded(createReadStream(path), maxBytes));
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) {
          reject(new AppError('invalid_archive', 'Invalid 3MF ZIP archive', 422));
          return;
        }
        let count = 0,
          done = false;
        const fail = (error: unknown) => {
          if (!done) {
            done = true;
            zip.close();
            reject(
              error instanceof AppError
                ? error
                : new AppError('invalid_archive', 'Invalid 3MF ZIP archive', 422),
            );
          }
        };
        zip.on('error', fail);
        zip.on('end', () =>
          fail(new AppError('missing_gcode', 'Container must contain Metadata/plate_1.gcode', 422)),
        );
        zip.on('entry', (entry) => {
          if (++count > 2000) {
            fail(new AppError('invalid_archive', 'Archive entry count limit exceeded', 422));
            return;
          }
          if (entry.fileName !== 'Metadata/plate_1.gcode') {
            zip.readEntry();
            return;
          }
          if (entry.generalPurposeBitFlag & 1) {
            fail(new AppError('invalid_archive', 'Encrypted G-code is unsupported', 422));
            return;
          }
          if (!entry.uncompressedSize) {
            fail(new AppError('invalid_gcode', 'Empty G-code', 422));
            return;
          }
          if (entry.uncompressedSize > maxBytes) {
            fail(new AppError('too_large', 'G-code size limit exceeded', 413));
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError);
              return;
            }
            done = true;
            const out = bounded(stream, maxBytes);
            out.once('close', () => {
              stream.destroy();
              zip.close();
            });
            resolve(out);
          });
        });
        zip.readEntry();
      },
    );
  });
}
function bounded(source: Readable, limit: number): Readable {
  let bytes = 0;
  const out = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      cb(
        bytes > limit ? new AppError('too_large', 'G-code size limit exceeded', 413) : null,
        chunk,
      );
    },
  });
  source.on('error', (e) => out.destroy(e));
  out.once('close', () => source.destroy());
  source.pipe(out);
  return out;
}
export async function inspectGcode(stream: Readable) {
  let remainder = '',
    lines = 0,
    hasMovement = false,
    estimatedSeconds: number | null = null,
    filamentGrams: number | null = null,
    filamentMillimeters: number | null = null;
  function line(text: string) {
    if (text.length > (text.trimStart().startsWith(';') ? 65536 : 4096))
      throw new AppError('invalid_gcode', 'G-code line length limit exceeded', 422);
    if (/^G[0123]\s/i.test(text.trim())) {
      if (/(?:NaN|Infinity)/i.test(text))
        throw new AppError('invalid_gcode', 'Non-finite toolpath coordinate', 422);
      const code = text.split(';')[0] ?? '';
      for (const match of code.matchAll(/[XYZEFRIJK]([^\s]+)/gi))
        if (!Number.isFinite(Number(match[1])) || Math.abs(Number(match[1])) > 1000000)
          throw new AppError('invalid_gcode', 'Invalid or excessive toolpath coordinate', 422);
      if (/[XY]/i.test(code)) hasMovement = true;
    }
    const time =
      text.match(/total estimated time:\s*([^;]+)/i) ??
      text.match(/estimated printing time.*?=\s*(.*)/i);
    if (time) {
      const t = time[1] ?? '';
      let s = 0;
      for (const m of t.matchAll(/([\d.]+)\s*([dhms])/g))
        s += Number(m[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 }[m[2] ?? 's'] ?? 0);
      if (s > 0) estimatedSeconds = s;
    }
    const seconds = text.match(/^;\s*TIME:\s*([\d.]+)/);
    if (seconds) estimatedSeconds = Number(seconds[1]);
    const grams = text.match(/filament used \[g\]\s*=\s*([\d.]+)/i);
    if (grams) filamentGrams = Number(grams[1]);
    const mm = text.match(/filament used \[mm\]\s*=\s*([\d.]+)/i);
    if (mm) filamentMillimeters = Number(mm[1]);
  }
  try {
    for await (const chunk of stream) {
      remainder += Buffer.from(chunk).toString('utf8');
      let newline: number;
      while ((newline = remainder.indexOf('\n')) >= 0) {
        line(remainder.slice(0, newline));
        remainder = remainder.slice(newline + 1);
        if (++lines % 10000 === 0) await setImmediate();
      }
      if (remainder.length > 65536)
        throw new AppError('invalid_gcode', 'G-code line length limit exceeded', 422);
    }
    if (remainder) line(remainder);
    if (!hasMovement)
      throw new AppError('invalid_gcode', 'G-code contains no supported toolpath', 422);
    return { estimatedSeconds, filamentGrams, filamentMillimeters };
  } finally {
    stream.destroy();
  }
}
