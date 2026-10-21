import { setImmediate } from 'node:timers/promises';

// A bounded top view also covers headless Orca exports without embedded PNGs.
export async function toolpathThumbnail(text: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let x = 0,
    y = 0,
    e = 0,
    absolute = true,
    relativeE = false,
    stride = 1,
    seen = 0;
  let segments: number[][] = [];
  const marker = /;\s*(?:CHANGE_LAYER|LAYER_CHANGE)\b/.exec(text);
  let offset = 0,
    lines = 0;
  while (offset < text.length) {
    if (++lines % 1000 === 0) {
      await setImmediate();
      signal?.throwIfAborted();
    }
    const end = text.indexOf('\n', offset);
    const line =
      text
        .slice(offset, end < 0 ? text.length : end)
        .split(';')[0]
        ?.trim() ?? '';
    const drawable = !marker || offset >= marker.index;
    offset = end < 0 ? text.length : end + 1;
    const command = line.match(/^(G\d+|M\d+)\b/i)?.[0]?.toUpperCase();
    if (command === 'G90') absolute = true;
    if (command === 'G91') absolute = false;
    if (command === 'M82') relativeE = false;
    if (command === 'M83') relativeE = true;
    if (!['G0', 'G1', 'G2', 'G3', 'G92'].includes(command ?? '')) continue;
    const values = Object.fromEntries(
      [...line.matchAll(/([XYE])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi)].map((m) => [
        m[1]!.toUpperCase(),
        Number(m[2]),
      ]),
    );
    const nx = values.X === undefined ? x : command === 'G92' || absolute ? values.X : x + values.X;
    const ny = values.Y === undefined ? y : command === 'G92' || absolute ? values.Y : y + values.Y;
    const ne =
      values.E === undefined ? e : command === 'G92' || !relativeE ? values.E : e + values.E;
    if (command !== 'G92' && drawable && ne > e && (nx !== x || ny !== y)) {
      if (seen++ % stride === 0) segments.push([x, y, nx, ny]);
      if (segments.length >= 4096) {
        segments = segments.filter((_, i) => i % 2 === 0);
        stride *= 2;
      }
    }
    x = nx;
    y = ny;
    e = ne;
  }
  signal?.throwIfAborted();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y, nx, ny] of segments) {
    minX = Math.min(minX, x!, nx!);
    minY = Math.min(minY, y!, ny!);
    maxX = Math.max(maxX, x!, nx!);
    maxY = Math.max(maxY, y!, ny!);
  }
  const scale = 96 / Math.max(maxX - minX, maxY - minY, 1);
  const px = (x: number) => (80 + (x - (minX + maxX) / 2) * scale).toFixed(2);
  const py = (y: number) => (60 - (y - (minY + maxY) / 2) * scale).toFixed(2);
  const path = segments
    .map(([x, y, nx, ny]) => `M${px(x!)} ${py(y!)}L${px(nx!)} ${py(ny!)}`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><rect x="8" y="8" width="144" height="104" rx="5" fill="#101a25" stroke="#344657"/><path d="${path}" fill="none" stroke="#4bd5bc" stroke-width="1"/></svg>`;
}
