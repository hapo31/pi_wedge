import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { Readable } from 'node:stream';
import type { Services } from './bootstrap.js';
import { AppError } from './domain/errors.js';
import {
  ErrorResponse,
  PreviewSelectionQuery,
  PreviewPlateSchema,
  OperationSchema,
  PrintOptionsSchema,
  BrowserPrintSchema,
  PrinterStatusSchema,
  Uuid,
  HistoryResponseSchema,
  SliceNameSchema,
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
  app.use('/history/data', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (services.ready === false)
      throw new AppError('dependency_unavailable', 'Restore storage and restart the server', 503);
    await next();
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/history/data',
      operationId: 'listBrowserSliceHistory',
      security: [],
      summary: 'List ready slices on the trusted LAN',
      description:
        'Public on the trusted LAN. Reads SQLite only and returns up to 24 ready slice summaries in newest-first order. Plate IDs/counts are included after first preview access; otherwise use the result UUID URL. Optional q searches display names and source model filenames; cursor is the last result UUID from the previous page. No model bodies, settings, tokens, printer state or physical side effects.',
      request: {
        query: z.object({ cursor: Uuid.optional(), q: SliceNameSchema.optional() }).strict(),
      },
      responses: {
        200: {
          description: 'Ready slice summaries',
          content: { 'application/json': { schema: HistoryResponseSchema } },
        },
        400: errors[400],
        404: errors[404],
        409: errors[409],
        503: errors[503],
      },
    }),
    async (c) =>
      c.json(await preview.history(c.req.valid('query').cursor, c.req.valid('query').q), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/preview/{uuid}/data',
      operationId: 'getBrowserPreviewData',
      security: [],
      summary: 'Load a LAN preview without token entry',
      description:
        'Public on the trusted LAN. Returns ready slice metadata, chosen display name or original model filename, and printer availability for this UUID only. Does not expose the model body or API token. No physical printer action.',
      request: { params, query: PreviewSelectionQuery },
      responses: {
        200: {
          description: 'Preview statistics and printer availability',
          content: {
            'application/json': {
              schema: z
                .object({
                  file: z.object({
                    id: Uuid,
                    name: z.string(),
                    format: z.enum(['gcode', 'gcode.3mf']),
                    state: z.literal('ready'),
                    estimatedSeconds: z.number().nullable(),
                    filamentGrams: z.number().nullable(),
                    filamentMillimeters: z.number().nullable(),
                  }),
                  displayName: z.string(),
                  printerEnabled: z.boolean(),
                  plateId: Uuid,
                  previewId: Uuid,
                  plate: z.number().int(),
                  plates: z.array(PreviewPlateSchema),
                })
                .openapi('BrowserPreviewData'),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        {
          ...(await preview.details(c.req.valid('param').uuid, c.req.valid('query').previewId)),
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
      description: `Public on the trusted LAN. Extracts the full G-code for previewId within this plate UUID (default first available). Limit ${services.config.MAX_PREVIEW_MB} MiB after decompression; no total line-count limit. No physical printer action.`,
      request: { params, query: PreviewSelectionQuery },
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
    async (c) =>
      c.text(
        await preview.selectedText(c.req.valid('param').uuid, c.req.valid('query').previewId),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/preview/{uuid}/thumbnail',
      operationId: 'getBrowserPlateThumbnail',
      security: [],
      summary: 'Read a bounded top view of the selected plate',
      description:
        'Trusted LAN, ready slice only. Generates a top view from the selected plate G-code with at most 4096 sampled segments. Generation yields in bounded batches, supports cancellation and shares the two-preview processing limit; busy returns 503 preview_busy. No model bodies, settings or physical action.',
      request: { params, query: PreviewSelectionQuery },
      responses: {
        200: {
          description: 'Plate thumbnail',
          content: { 'image/svg+xml': { schema: z.string() } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const svg = await preview.thumbnail(
        c.req.valid('param').uuid,
        c.req.valid('query').previewId,
        c.req.raw.signal,
      );
      c.header('Content-Type', 'image/svg+xml');
      return c.body(svg, 200);
    },
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
      const { group } = await preview.selection(id);
      const { file, stream } = await services.files.download(group.fileId);
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
  app.openapi(
    createRoute({
      method: 'get',
      path: '/preview/{uuid}/printer',
      operationId: 'getBrowserPrinterStatus',
      security: [],
      summary: 'Read AMS Lite state for a ready LAN preview',
      description:
        'Trusted LAN, ready slice UUID required. Returns only the bounded printer state and AMS Lite slot snapshot; no identifiers, RFID, credentials or raw telemetry. Read-only: does not change AMS or start a print. Snapshot may be cached for five seconds.',
      request: { params },
      responses: {
        200: {
          description: 'Printer and AMS Lite snapshot',
          content: { 'application/json': { schema: PrinterStatusSchema } },
        },
        502: error('Printer status unavailable'),
        ...errors,
      },
    }),
    async (c) => {
      await preview.selection(c.req.valid('param').uuid);
      if (!services.config.PRINTER_ENABLED)
        throw new AppError('printer_disabled', 'Printer is not configured', 503);
      return c.json(await services.printer.status(), 200);
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
  app.use('/preview/:uuid/print', async (c, next) => {
    if (
      c.req.method === 'POST' &&
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' &&
      (await c.req.text()).length
    )
      throw new AppError('invalid_request', 'AMS settings require application/json', 400);
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/preview/{uuid}/print',
      operationId: 'startBrowserPrint',
      security: [],
      summary: 'Start the previewed print after explicit browser confirmation',
      description:
        'PHYSICAL SIDE EFFECT: uploads, heats and moves the printer. Trusted LAN browser action, no token entry. Origin must match the request origin; cross-origin and missing-Origin requests are rejected and CORS is not enabled. Send an empty body for external-spool defaults, or application/json with useAms and one zero-based amsMapping slot (0–3), plus an Idempotency-Key UUID. The selected supply source must be shown in the browser confirmation. Query previewId selects the confirmed preview within the plate set (default first available). Other print options use defaults and the same persistent PrinterService as the authenticated API. pending → accepted/failed/unknown. accepted is command ACK, not completed printing. Repeat the same key to read the prior result; never automatically retry with a new key.',
      request: {
        params,
        query: PreviewSelectionQuery,
        headers: z.object({
          Origin: z.url().openapi({ example: 'http://raspberrypi.local:3000' }),
          'Idempotency-Key': Uuid,
        }),
        body: {
          required: false,
          content: {
            'application/json': {
              schema: BrowserPrintSchema,
              example: { useAms: true, amsMapping: [0] },
            },
          },
        },
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
      const raw = await c.req.text();
      let settings = BrowserPrintSchema.parse({});
      if (raw.length) {
        if (
          c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        )
          throw new AppError('invalid_request', 'AMS settings require application/json', 400);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new AppError('invalid_request', 'Invalid print settings JSON', 400);
        }
        settings = BrowserPrintSchema.parse(body);
      }
      const { selected } = await preview.selection(
        c.req.valid('param').uuid,
        c.req.valid('query').previewId,
      );
      if (!services.config.PRINTER_ENABLED)
        throw new AppError('printer_disabled', 'Printer is not configured', 503);
      const op = await services.printer.print(
        selected.fileId,
        PrintOptionsSchema.parse({ ...settings, plate: selected.sourcePlate }),
        c.req.valid('header')['Idempotency-Key'],
      );
      return c.json(op, op.state === 'unknown' ? 504 : op.state === 'failed' ? 502 : 200);
    },
  );
}
