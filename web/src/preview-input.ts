/** Keep startup motion state but exclude purge extrusion from the slicer's layer display. */
export function previewInput(text: string): string {
  const marker = text.search(/^\s*;\s*(?:CHANGE_LAYER|LAYER_CHANGE)\s*$/m);
  if (marker < 0) return text;
  const startup = text
    .slice(0, marker)
    .split('\n')
    .map((line) => {
      if (!/^\s*G(?:0?[0-3])\b/i.test(line)) return line;
      const comment = line.indexOf(';'),
        code = comment >= 0 ? line.slice(0, comment) : line;
      if (!/[XY]/i.test(code)) return line;
      return (
        code.replace(/\bE[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gi, '') +
        (comment >= 0 ? line.slice(comment) : '')
      );
    })
    .join('\n');
  return startup + text.slice(marker);
}
