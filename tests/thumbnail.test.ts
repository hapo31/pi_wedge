import { expect, it } from 'vitest';
import { toolpathThumbnail } from '../src/services/thumbnail.js';
it('renders Orca extrusion values without leading zeroes and bounds sampled thumbnail geometry', () => {
  const square =
    'G90\nM83\nG1 X80 Y80\n; CHANGE_LAYER\nG1 X100 Y80 E.01\nG1 X100 Y100 E.02\nG1 X80 Y100 E.03\nG1 X80 Y80 E.04\n';
  const svg = toolpathThumbnail(square);
  expect(svg).toContain(
    'M32.00 108.00L128.00 108.00M128.00 108.00L128.00 12.00M128.00 12.00L32.00 12.00M32.00 12.00L32.00 108.00',
  );
  const large = toolpathThumbnail(square.repeat(10000));
  expect(large.match(/L/g)!.length).toBeLessThanOrEqual(4096);
  expect(large).not.toMatch(/NaN|Infinity/);
});
