import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Services } from '../src/bootstrap.js';
import { validateModel } from '../src/services/files.js';
import { MODEL, TOKEN, setup } from './helpers.js';

const app = createApp({ config: { API_TOKEN: TOKEN } } as Services);
const headers = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
const body = (size: number) => {
  const prefix = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"';
  const suffix = '"}}';
  return prefix + 'a'.repeat(size - prefix.length - suffix.length) + suffix;
};

describe('bounded inputs', () => {
  it('validates normal STL and rejects invalid coordinates and excess facets', () => {
    expect(validateModel('model.stl', Buffer.from(MODEL))).toBe('stl');
    expect(validateModel('model.stl', Buffer.from(MODEL.replace('solid', 'SOLID')))).toBe('stl');
    expect(() =>
      validateModel('model.stl', Buffer.from(MODEL.replace('10 0 0', 'NaN 0 0'))),
    ).toThrow();
    expect(() =>
      validateModel(
        'model.stl',
        Buffer.from('solid x\n' + 'endfacet\n'.repeat(1000001) + 'endsolid'),
      ),
    ).toThrow();
    expect(() =>
      validateModel(
        'model.stl',
        Buffer.from('solid x\n' + 'vertex 0 0 0\n'.repeat(100000) + 'endsolid'),
      ),
    ).toThrow();
    const binary = Buffer.alloc(134);
    binary.writeUInt32LE(1, 80);
    expect(validateModel('model.stl', binary)).toBe('stl');
    binary.writeFloatLE(Infinity, 84);
    expect(() => validateModel('model.stl', binary)).toThrow();
  });
  it('accepts the coordinate token limit and rejects longer tokens', () => {
    for (const length of [1024, 1025]) {
      const bytes = Buffer.from(MODEL.replace('vertex 0 0 0', `vertex ${'0'.repeat(length)} 0 0`));
      if (length === 1024) expect(validateModel('model.stl', bytes)).toBe('stl');
      else expect(() => validateModel('model.stl', bytes)).toThrow();
    }
  });
  it('lets the event loop progress while checking large ASCII and binary uploads', async () => {
    const binary = Buffer.alloc(84 + 1400 * 50);
    binary.writeUInt32LE(1400, 80);
    const cases = [
      Buffer.from(' '.repeat(70000) + MODEL),
      Buffer.from(MODEL.replace('vertex 0', `vertex ${' '.repeat(70000)}0`)),
      Buffer.from(MODEL.replace('solid triangle', 'solid ' + 'x'.repeat(70000))),
      binary,
    ];
    const context = await setup();
    try {
      const insert = vi.spyOn(context.repository, 'insert');
      for (const bytes of cases) {
        insert.mockClear();
        const file = new File([Uint8Array.from(bytes)], 'model.stl');
        // Avoid depending on the runtime's Blob reader scheduling for this assertion.
        vi.spyOn(file, 'arrayBuffer').mockResolvedValue(Uint8Array.from(bytes).buffer);
        let insertsAtFirstTurn = -1;
        const firstTurn = setImmediate().then(() => {
          insertsAtFirstTurn = insert.mock.calls.length;
        });
        const upload = context.files.upload(file);
        await firstTurn;
        expect(insertsAtFirstTurn).toBe(0);
        expect(await upload).toMatchObject({ format: 'stl', state: 'ready' });
      }
    } finally {
      await context.close();
    }
  });
  it('limits actual MCP bytes even with a false Content-Length', async () => {
    expect((await app.request('/mcp', { method: 'POST', headers, body: body(16384) })).status).toBe(
      200,
    );
    expect(
      (
        await app.request('/mcp', {
          method: 'POST',
          headers: { ...headers, 'content-length': '1' },
          body: body(16385),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request('/mcp', {
          method: 'POST',
          headers: { ...headers, authorization: '' },
          body: body(16385),
        })
      ).status,
    ).toBe(401);
    const multibyte = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { x: 'あ'.repeat(5500) },
    });
    expect(multibyte.length).toBeLessThan(16384);
    expect((await app.request('/mcp', { method: 'POST', headers, body: multibyte })).status).toBe(
      413,
    );
  });
  it('preserves normal MCP initialization and tool listing', async () => {
    for (const method of ['initialize', 'tools/list']) {
      const params = method === 'initialize' ? { protocolVersion: '2025-11-25' } : {};
      const response = await app.request('/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty('result');
    }
  });
  it('limits streamed MCP bodies with no Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body(16385));
        controller.enqueue(bytes.subarray(0, 8000));
        controller.enqueue(bytes.subarray(8000));
        controller.close();
      },
    });
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect((await app.fetch(request)).status).toBe(413);
  });
});
