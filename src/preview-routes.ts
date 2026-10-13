import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { Readable } from 'node:stream';
import type { Services } from './bootstrap.js';
import { AppError } from './domain/errors.js';
import {
  ErrorResponse,
  FileSchema,
  OperationSchema,
  PrintOptionsSchema,
  Uuid,
} from './domain/schemas.js';
import type { PreviewService } from './services/preview.js';

const params = z.object({ uuid: Uuid });
const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponse } },
});
const errors = {
  400: error('Invalid UUID, idempotency key or unexpected request body'),
  404: error('Slice UUID does not exist'),
  409: error('File not ready, wrong format, busy printer or idempotency conflict'),
  413: error('Preview or request exceeds size limit'),
  422: error('Invalid G-code or print container'),
  503: error('Storage/printer unavailable or printer disabled'),
  500: error('Internal error; inspect server logs by UUID'),
};
const operation = (description: string) => ({
  description,
  content: { 'application/json': { schema: OperationSchema } },
});

export function registerPreviewRoutes(
  app: OpenAPIHono,
  services: Services & { ready?: boolean },
  preview: PreviewService,
) {
  app.use('/preview/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (services.ready === false)
      throw new AppError('dependency_unavailable', 'Restore storage and restart the server', 503);
    await next();
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/preview/{uuid}/data',
      operationId: 'getBrowserPreviewData',
      security: [],
      summary: 'Load a LAN preview without token entry',
      description:
        'Public on the trusted LAN. Returns ready slice metadata, original model display name and printer availability for this UUID only. Does not expose the model body or API token. No physical printer action.',
      request: { params },
      responses: {
        200: {
          description: 'Preview statistics and printer availability',
          content: {
            'application/json': {
              schema: z
                .object({ file: FileSchema, displayName: z.string(), printerEnabled: z.boolean() })
                .openapi('BrowserPreviewData'),
            },
          },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        {
          ...preview.details(c.req.valid('param').uuid),
          printerEnabled: services.config.PRINTER_ENABLED,
        },
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/preview/{uuid}/gcode',
      operationId: 'getBrowserPreviewGcode',
      security: [],
      summary: 'Read the selected slice toolpath without token entry',
      description: `Public on the trusted LAN. Extracts the G-code for this slice UUID only. Limit ${services.config.MAX_PREVIEW_MB} MiB and 250,000 lines. No physical printer action.`,
      request: { params },
      responses: {
        200: {
          description: 'Bounded G-code text',
          content: {
            'text/plain': { schema: z.string(), example: 'G21\nG90\nM83\nG1 X10 Y10 Z0.2 E1\n' },
          },
        },
        ...errors,
      },
    }),
    async (c) => c.text(await preview.text(c.req.valid('param').uuid), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/preview/{uuid}/download',
      operationId: 'downloadBrowserSlice',
      security: [],
      summary: 'Download the selected slice without token entry',
      description:
        'Public on the trusted LAN. Streams only a ready G-code/gcode.3mf slice; model download and file listing are not available here. No physical printer action.',
      request: { params },
      responses: {
        200: {
          description: 'Stored print artifact',
          content: {
            'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const id = c.req.valid('param').uuid;
      preview.file(id);
      const { file, stream } = await services.files.download(id);
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(file.size),
          'Content-Disposition': `attachment; filename="${file.id}.${file.format}"`,
          'Cache-Control': 'no-store',
        },
      });
    },
  );
  app.use('/preview/:uuid/print', async (c, next) => {
    if (c.req.method === 'POST' && c.req.header('Origin') !== new URL(c.req.url).origin)
      throw new AppError(
        'forbidden_origin',
        'Print must be requested from the same preview origin',
        403,
      );
    await next();
  });
  app.use(
    '/preview/:uuid/print',
    bodyLimit({
      maxSize: 1024,
      onError: (c) =>
        c.json({ error: { code: 'too_large', message: 'Request size limit exceeded' } }, 413),
    }),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/preview/{uuid}/print',
      operationId: 'startBrowserPrint',
      security: [],
      summary: 'Start the previewed print after explicit browser confirmation',
      description:
        'PHYSICAL SIDE EFFECT: uploads, heats and moves the printer. Trusted LAN browser action, no token entry. Origin must match the request origin; cross-origin and missing-Origin requests are rejected and CORS is not enabled. Send an empty body and an Idempotency-Key UUID. Uses default print options and the same persistent PrinterService as the authenticated API. pending → accepted/failed/unknown. accepted is command ACK, not completed printing. Repeat the same key to read the prior result; never automatically retry with a new key.',
      request: {
        params,
        headers: z.object({
          Origin: z.url().openapi({ example: 'http://raspberrypi.local:3000' }),
          'Idempotency-Key': Uuid,
        }),
      },
      responses: {
        200: operation('Command accepted or previous operation returned'),
        502: operation('Transfer or command failed'),
        504: operation('Unknown result; inspect physical printer before another operation'),
        403: error('Missing or cross-origin Origin header'),
        ...errors,
      },
    }),
    async (c) => {
      if ((await c.req.arrayBuffer()).byteLength)
        throw new AppError('invalid_request', 'Browser print accepts an empty body only', 400);
      if (!services.config.PRINTER_ENABLED)
        throw new AppError('printer_disabled', 'Printer is not configured', 503);
      const op = await services.printer.print(
        c.req.valid('param').uuid,
        PrintOptionsSchema.parse({}),
        c.req.valid('header')['Idempotency-Key'],
      );
      return c.json(op, op.state === 'unknown' ? 504 : op.state === 'failed' ? 502 : 200);
    },
  );
}
