import { expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { toolpathThumbnail } from '../src/services/thumbnail.js';
it('renders Orca extrusion values without leading zeroes and bounds sampled thumbnail geometry', async () => {
  const square =
    'G90\nM83\nG1 X80 Y80\n; CHANGE_LAYER\nG1 X100 Y80 E.01\nG1 X100 Y100 E.02\nG1 X80 Y100 E.03\nG1 X80 Y80 E.04\n';
  const svg = await toolpathThumbnail(square);
  expect(svg).toContain(
    'M32.00 108.00L128.00 108.00M128.00 108.00L128.00 12.00M128.00 12.00L32.00 12.00M32.00 12.00L32.00 108.00',
  );
  const large = await toolpathThumbnail(square.repeat(10000));
  expect(large.match(/L/g)!.length).toBeLessThanOrEqual(4096);
  expect(large).not.toMatch(/NaN|Infinity/);
});
it('yields while scanning large toolpaths and cancels before completing the scan', async () => {
  const abort = new AbortController();
  let finished = false;
  const result = toolpathThumbnail(
    'M83\n' + 'G1 X10 Y10 E.01\nG1 X20 Y20 E.01\n'.repeat(50000),
    abort.signal,
  ).finally(() => {
    finished = true;
  });
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await setImmediate();
  expect(finished).toBe(false);
  abort.abort();
  await rejected;
});
