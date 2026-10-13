import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { PreviewService } from './services/preview.js';
import { registerPreviewRoutes } from './preview-routes.js';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Services } from './bootstrap.js';
import {
  ErrorResponse,
  FileSchema,
  JobSchema,
  OperationSchema,
  PrintRequestSchema,
  PrinterOperationSchema,
  StopOperationSchema,
  StopRequestSchema,
  SliceOptionsSchema,
  Uuid,
} from './domain/schemas.js';
import { AppError, safeError, logError } from './domain/errors.js';
const json = <T extends z.ZodType>(schema: T, description: string, example?: unknown) => ({
  description,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});
const errors = {
  500: json(ErrorResponse, 'Unexpected internal error; inspect server logs by request/job UUID'),
  400: json(ErrorResponse, 'Invalid request, UUID or model content'),
  401: json(ErrorResponse, 'Missing or invalid Bearer token'),
  404: json(ErrorResponse, 'UUID does not exist'),
  409: json(
    ErrorResponse,
    'File not ready, wrong format, full queue, busy printer, or conflicting idempotency request',
  ),
  413: json(ErrorResponse, 'File/request size limit exceeded'),
  415: json(ErrorResponse, 'Unsupported model format'),
  422: json(ErrorResponse, 'Invalid G-code or print container'),
  502: json(ErrorResponse, 'Printer rejected a command or transport failed'),
  503: json(ErrorResponse, 'Storage/slicer/printer unavailable or disabled'),
  504: json(ErrorResponse, 'Print result unknown: check the physical device before a new request'),
};
const secured = [{ BearerAuth: [] }];
const fileParams = z.object({ uuid: Uuid });
const exampleId = '0198cdf0-b8f1-4de0-8d67-2d9e95ed019c';
const UploadSchema = z
  .object({ file: z.instanceof(File).openapi({ type: 'string', format: 'binary' }) })
  .strict();
const SliceBody = z
  .object({ fileId: Uuid, options: SliceOptionsSchema.default(SliceOptionsSchema.parse({})) })
  .strict();
const SliceMultipart = z
  .object({
    file: z.instanceof(File).openapi({ type: 'string', format: 'binary' }),
    options: z.string().max(4096).optional().openapi({
      description: 'JSON-encoded SliceOptions. Omit for A1 mini defaults.',
      example: '{"layerHeight":0.2,"infillDensity":15,"support":false}',
    }),
  })
  .strict();
export function createApp(services?: Services & { ready?: boolean }) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: 'invalid_request',
              message: 'Request does not match the documented schema',
            },
          },
          400,
        );
    },
  });
  app.use(
    '*',
    secureHeaders({
      crossOriginResourcePolicy: 'same-origin',
      crossOriginOpenerPolicy: 'same-origin',
    }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'Request does not match the documented schema',
          },
        },
        400,
      );
    if (error instanceof HTTPException)
      return c.json(
        {
          error: {
            code: error.status === 415 ? 'unsupported_media_type' : 'invalid_request',
            message:
              error.status === 415 ? 'Unsupported request content type' : 'Malformed request body',
          },
        },
        error.status,
      );
    if (!(error instanceof AppError)) logError('http', c.req.path, error);
    const status = error instanceof AppError ? error.status : 500;
    return c.json({ error: safeError(error) }, status as ContentfulStatusCode);
  });
  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Endpoint does not exist' } }, 404),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      operationId: 'health',
      summary: 'Server liveness',
      description:
        'Public liveness probe. No physical printer side effects; does not check storage or printer.',
      responses: {
        200: json(z.object({ status: z.literal('ok') }), 'Server running', { status: 'ok' }),
      },
    }),
    (c) => c.json({ status: 'ok' as const }, 200),
  );
  app.post('/mcp', async (c) => {
    if (!services)
      return c.json(
        { error: { code: 'unavailable', message: 'Services are not configured' } },
        503,
      );
    const supplied = Buffer.from(c.req.header('Authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? ''),
      expected = Buffer.from(services.config.API_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.json(
        { error: { code: 'unauthorized', message: 'A valid Bearer token is required' } },
        401,
      );
    if (!c.req.header('content-type')?.toLowerCase().includes('application/json'))
      return c.json(
        {
          error: {
            code: 'unsupported_media_type',
            message: 'MCP requests must use application/json',
          },
        },
        415,
      );
    const accept = c.req.header('accept') ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream'))
      return c.text('Accept must include application/json and text/event-stream', 406);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        if (new URL(origin).origin !== new URL(c.req.url).origin)
          return c.text('Origin does not match this server', 403);
      } catch {
        return c.text('Invalid Origin', 403);
      }
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { error: { code: 'invalid_json', message: 'Request body must be valid JSON' } },
        400,
      );
    }
    const request = z
      .object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number(), z.null()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(raw);
    if (!request.success)
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
        400,
      );
    const { id, method, params } = request.data;
    const supported = ['2025-11-25', '2025-06-18', '2025-03-26'];
    if (method !== 'initialize') {
      const protocolVersion = c.req.header('MCP-Protocol-Version');
      if (!protocolVersion || !supported.includes(protocolVersion))
        return c.text('Missing or unsupported MCP-Protocol-Version', 400);
      c.header('MCP-Protocol-Version', protocolVersion);
    }
    if (id === undefined) return c.body(null, 202);
    const response = (result: unknown) => c.json({ jsonrpc: '2.0' as const, id, result });
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0' as const, id, error: { code, message } });
    if (method === 'initialize') {
      const protocolVersion = params?.protocolVersion;
      if (typeof protocolVersion !== 'string') return rpcError(-32602, 'Invalid initialize params');
      return response({
        protocolVersion: supported.includes(protocolVersion) ? protocolVersion : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pi_wedge', version: '0.1.0' },
        instructions:
          'pi_wedge slices STL/STEP models for a LAN-connected Bambu Lab A1 mini and lets the AI and user inspect the resulting 3D preview together in a browser. Read /openapi.json or /docs for the authenticated API. After a slice succeeds, give the user its /preview/{resultFileId} URL. This MCP server only explains the workflow; it does not slice, upload, or print models.',
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled')
      return c.body(null, 202);
    if (method === 'ping') return response({});
    if (method === 'tools/list')
      return response({
        tools: [
          {
            name: 'pi_wedge_workflow',
            title: 'Inspect a 3D print model with pi_wedge',
            description:
              'Explains how to use this Raspberry Pi service to slice an STL/STEP file and open its UUID-based 3D preview so the AI and user can review it together. Does not perform any operation. Use the HTTP API described by /openapi.json for model upload and slicing; then share the preview URL. Printing is a separate, explicit physical action.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      });
    if (method === 'tools/call') {
      if (params?.name !== 'pi_wedge_workflow') return rpcError(-32602, 'Unknown tool');
      return response({
        content: [
          {
            type: 'text',
            text: 'pi_wedge is a LAN service for slicing STL/STEP models for a Bambu Lab A1 mini and reviewing the result in a browser. Read /docs or /openapi.json for the API. Use authenticated POST /api/files and POST /api/slices APIs, then poll GET /api/slices/{jobId} until succeeded. Share /preview/{resultFileId} with the user so you can review the 3D result together. Resolve these paths against the configured pi_wedge server URL. This tool only provides guidance; it does not access files, slice, or print. Printing requires a separate explicit action.',
          },
        ],
      });
    }
    return rpcError(-32601, 'Method not found');
  });
  app.all('/mcp', (c) => {
    c.header('Allow', 'POST');
    return c.text('Method not allowed', 405);
  });
  app.use('/api/*', async (c, next) => {
    if (!services) throw new AppError('unavailable', 'Services are not configured', 503);
    const supplied = Buffer.from(c.req.header('Authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? ''),
      expected = Buffer.from(services.config.API_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.json(
        { error: { code: 'unauthorized', message: 'A valid Bearer token is required' } },
        401,
      );
    if (services.ready === false && c.req.path !== '/api/ready')
      throw new AppError(
        'dependency_unavailable',
        'Startup recovery failed. Restore storage and restart the server.',
        503,
      );
    await next();
  });
  let uploading = 0;
  app.use('/api/*', async (c, next) => {
    const upload =
      c.req.method === 'POST' && c.req.header('content-type')?.includes('multipart/form-data');
    if (!upload) {
      await next();
      return;
    }
    if (uploading >= 2)
      throw new AppError('upload_busy', 'Two model uploads are already being processed', 503);
    uploading++;
    try {
      await next();
    } finally {
      uploading--;
    }
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: (services?.config.MAX_UPLOAD_MB ?? 50) * 1048576 + 65536,
      onError: (c) =>
        c.json({ error: { code: 'too_large', message: 'Request size limit exceeded' } }, 413),
    }),
  );
  if (services) {
    const { files, jobs, printer, config } = services;
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/ready',
        operationId: 'readiness',
        security: secured,
        summary: 'Check metadata and storage readiness',
        description: 'Read-only dependency probe. Does not contact or move the printer.',
        responses: {
          200: json(
            z.object({ status: z.literal('ready'), printerEnabled: z.boolean() }),
            'Dependencies available',
          ),
          ...errors,
        },
      }),
      async (c) => {
        try {
          if (services.ready === false) throw new Error('recovery');
          files.repository.db.prepare('SELECT 1').get();
          await files.storage.check();
        } catch {
          throw new AppError(
            'dependency_unavailable',
            'Metadata or object storage unavailable',
            503,
          );
        }
        return c.json({ status: 'ready' as const, printerEnabled: config.PRINTER_ENABLED }, 200);
      },
    );
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/profiles',
        operationId: 'listProfiles',
        security: secured,
        summary: 'List supported profile IDs and defaults',
        description:
          'Read-only. Local administrator must prepare the profile files; availability is checked by the slicer.',
        responses: {
          200: json(
            z.object({
              printers: z.array(z.string()),
              filaments: z.array(z.string()),
              defaults: SliceOptionsSchema,
            }),
            'Supported profile identifiers',
          ),
          ...errors,
        },
      }),
      (c) =>
        c.json(
          {
            printers: ['a1-mini-0.4'],
            filaments: ['generic-pla'],
            defaults: SliceOptionsSchema.parse({}),
          },
          200,
        ),
    );
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/files',
        operationId: 'uploadModel',
        security: secured,
        summary: 'Store an STL or STEP model and assign a UUID',
        description: `Stores a model only; no slicing or physical printer action. STL coordinates are millimeters. Maximum model size ${config.MAX_UPLOAD_MB} MiB.`,
        request: {
          body: { required: true, content: { 'multipart/form-data': { schema: UploadSchema } } },
        },
        responses: { 201: json(FileSchema, 'Model persisted with ready state'), ...errors },
      }),
      async (c) => c.json(await files.upload(c.req.valid('form').file), 201),
    );
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/files/{uuid}',
        operationId: 'getFileMetadata',
        security: secured,
        summary: 'Retrieve UUID file metadata',
        description:
          'Returns format, model provenance, slice settings, state and available estimates. No physical printer side effects.',
        request: { params: fileParams },
        responses: { 200: json(FileSchema, 'File metadata'), ...errors },
      }),
      (c) => c.json(files.metadata(c.req.valid('param').uuid), 200),
    );
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/files/{uuid}/download',
        operationId: 'downloadFile',
        security: secured,
        summary: 'Stream the original stored file',
        description:
          'Binary download; format is in the metadata endpoint. No physical printer side effects.',
        request: { params: fileParams },
        responses: {
          200: {
            description: 'File body',
            content: {
              'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
            },
          },
          ...errors,
        },
      }),
      async (c) => {
        const { file, stream } = await files.download(c.req.valid('param').uuid);
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
        method: 'post',
        path: '/api/slices',
        operationId: 'createSliceJob',
        security: secured,
        summary: 'Queue a non-blocking A1 mini slice',
        description:
          'Accept an existing model UUID (JSON), or upload STL/STEP and JSON-encoded options (multipart). queued → running → succeeded/failed. Poll GET /api/slices/{jobId}; only succeeded has resultFileId. Result bytes are saved to storage, never returned here. No upload to printer and no physical action.',
        request: {
          body: {
            content: {
              'application/json': {
                schema: SliceBody,
                example: {
                  fileId: exampleId,
                  options: { layerHeight: 0.2, infillDensity: 15, support: false },
                },
              },
              'multipart/form-data': { schema: SliceMultipart },
            },
          },
        },
        responses: { 202: json(JobSchema, 'Persisted asynchronous job'), ...errors },
      }),
      async (c) => {
        jobs.assertCapacity();
        let modelId: string;
        let options;
        if (c.req.header('content-type')?.includes('multipart/form-data')) {
          const body = SliceMultipart.parse(c.req.valid('form'));
          try {
            options = SliceOptionsSchema.parse(body.options ? JSON.parse(body.options) : {});
          } catch {
            throw new AppError(
              'invalid_request',
              'options must be valid JSON matching SliceOptions',
              400,
            );
          }
          modelId = (await files.upload(body.file)).id;
        } else {
          const body = SliceBody.parse(c.req.valid('json'));
          modelId = body.fileId;
          options = body.options;
        }
        const job = jobs.create(modelId, options);
        c.header('Location', `/api/slices/${job.id}`);
        return c.json(job, 202);
      },
    );
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/slices/{jobId}',
        operationId: 'getSliceJob',
        security: secured,
        summary: 'Poll asynchronous slice state',
        description:
          'queued → running → succeeded/failed. Failed records carry error code/message. succeeded returns a persisted resultFileId; retrieve metadata/download separately. No physical printer side effects.',
        request: { params: z.object({ jobId: Uuid }) },
        responses: { 200: json(JobSchema, 'Current job state'), ...errors },
      }),
      (c) => c.json(jobs.get(c.req.valid('param').jobId), 200),
    );
    const FileRequest = z.object({ fileId: Uuid }).strict();
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/printer/upload',
        operationId: 'uploadToPrinter',
        security: secured,
        summary: 'Transfer a slice UUID to the A1 mini',
        description:
          'Reads a server-generated ready gcode.3mf from storage and sends it by FTPS. Writes printer storage only; does not start heating or motion. Can be called independently of print.',
        request: {
          body: {
            required: true,
            content: {
              'application/json': { schema: FileRequest, example: { fileId: exampleId } },
            },
          },
        },
        responses: {
          200: json(
            z.object({ fileId: Uuid, remotePath: z.string() }),
            'Transfer completed and remote size verified',
          ),
          ...errors,
        },
      }),
      async (c) => c.json(await printer.upload(c.req.valid('json').fileId), 200),
    );
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/printer/print',
        operationId: 'startPrint',
        security: secured,
        summary: 'Explicitly start physical printing',
        description:
          'PHYSICAL SIDE EFFECT: heats and moves the printer. Uploads the selected gcode.3mf first, then dispatches one MQTT print command. Idempotency-Key (UUID) is mandatory: repeat the same key/content to read the previous operation; never automatically retry with a new key. pending → accepted/failed/unknown. accepted means printer ACK, not completed printing; 504/unknown requires physical inspection. Same key with different content is 409. Other data APIs never invoke this action.',
        request: {
          headers: z.object({ 'Idempotency-Key': Uuid }),
          body: {
            required: true,
            content: {
              'application/json': {
                schema: PrintRequestSchema,
                example: { fileId: exampleId, options: { bedLeveling: true, useAms: false } },
              },
            },
          },
        },
        responses: {
          200: json(
            OperationSchema,
            'Command accepted or previous pending/accepted operation returned',
          ),
          502: json(OperationSchema, 'Print operation failed before acceptance or was rejected'),
          504: json(
            OperationSchema,
            'Command outcome unknown; inspect device before another operation',
          ),
          ...Object.fromEntries(
            Object.entries(errors).filter(([code]) => !['502', '504'].includes(code)),
          ),
        },
      }),
      async (c) => {
        const body = c.req.valid('json');
        const op = await printer.print(
          body.fileId,
          body.options,
          c.req.valid('header')['Idempotency-Key'],
        );
        return c.json(op, op.state === 'unknown' ? 504 : op.state === 'failed' ? 502 : 200);
      },
    );
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/printer/stop',
        operationId: 'stopPrint',
        security: secured,
        summary: 'Explicitly stop the current physical print',
        description:
          'PHYSICAL SIDE EFFECT: requests cancellation of the current printer job; cleanup motion may continue. No file upload or print start. Bearer and a persistent Idempotency-Key UUID are required. Send an empty JSON object. pending → accepted/failed/unknown; accepted is a stop command ACK, not confirmation that all motion has stopped. Repeat the same key to read the stored result, never automatically resend with a new key. One printer command at a time. An unresolved start permits a stop once dispatch is idle, but remains unresolved. An unresolved stop blocks new stop and print keys until physical inspection and manual resolution.',
        request: {
          headers: z.object({ 'Idempotency-Key': Uuid }),
          body: {
            required: true,
            content: { 'application/json': { schema: StopRequestSchema, example: {} } },
          },
        },
        responses: {
          200: json(
            StopOperationSchema,
            'Stop command accepted or previous pending/accepted result',
            {
              id: exampleId,
              action: 'stop',
              state: 'accepted',
              createdAt: '2026-10-14T00:00:00.000Z',
              error: null,
            },
          ),
          502: json(StopOperationSchema, 'Stop failed before dispatch or was rejected'),
          504: json(StopOperationSchema, 'Stop outcome unknown; inspect the physical printer'),
          ...Object.fromEntries(
            Object.entries(errors).filter(([code]) => !['502', '504'].includes(code)),
          ),
        },
      }),
      async (c) => {
        if (
          c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        )
          throw new AppError(
            'invalid_request',
            'Send an empty JSON object with Content-Type application/json',
            400,
          );
        // Hono substitutes {} when content-type parsing is skipped. Require the
        // actual request body so an absent or unsupported body cannot stop a job.
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          throw new HTTPException(400);
        }
        StopRequestSchema.parse(body);
        const op = await printer.stopPrint(c.req.valid('header')['Idempotency-Key']);
        return c.json(op, op.state === 'unknown' ? 504 : op.state === 'failed' ? 502 : 200);
      },
    );
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/printer/operations/{operationId}',
        operationId: 'getPrintOperation',
        security: secured,
        summary: 'Read a persisted print or stop dispatch result',
        description:
          'Read-only. No physical printer side effects. unknown/pending does not trigger a retry.',
        request: { params: z.object({ operationId: Uuid }) },
        responses: {
          200: json(PrinterOperationSchema, 'Persisted print or stop operation'),
          ...errors,
        },
      }),
      (c) => c.json(printer.get(c.req.valid('param').operationId), 200),
    );
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/printer/operations/{operationId}/resolve',
        operationId: 'resolvePrintOutcome',
        security: secured,
        summary: 'Record a physically inspected unknown print or stop outcome',
        description:
          'Administrator action after checking the actual printer. Updates a print or stop operation locally only; does not contact or move the device. Resolving the operation permits a new explicit request once no other unknown operations remain. Never use this as automatic retry logic.',
        request: {
          params: z.object({ operationId: Uuid }),
          body: {
            required: true,
            content: {
              'application/json': {
                schema: z
                  .object({
                    outcome: z.enum(['accepted', 'failed']),
                    inspectionNote: z.string().min(12).max(240),
                  })
                  .strict(),
                example: {
                  outcome: 'failed',
                  inspectionNote: 'Checked printer screen and bed: no print started.',
                },
              },
            },
          },
        },
        responses: {
          200: json(PrinterOperationSchema, 'Unknown state manually resolved'),
          ...errors,
        },
      }),
      (c) => {
        const body = c.req.valid('json');
        return c.json(
          printer.resolveUnknown(
            c.req.valid('param').operationId,
            body.outcome,
            body.inspectionNote,
          ),
          200,
        );
      },
    );
  }
  if (services) {
    const preview =
      services.preview ??
      new PreviewService(
        services.files,
        services.config.DATA_DIR,
        services.config.MAX_PREVIEW_MB * 1048576,
      );
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/files/{uuid}/gcode',
        operationId: 'getPreviewGcode',
        security: secured,
        summary: 'Get bounded text G-code for browser preview',
        description: `Extracts Metadata/plate_1.gcode from gcode.3mf or reads plain G-code. Limit ${services.config.MAX_PREVIEW_MB} MiB and 250,000 lines; larger artifacts remain downloadable/printable. No physical printer side effects. Invalid ZIP/toolpath returns 422.`,
        request: { params: fileParams },
        responses: {
          200: {
            description: 'UTF-8 G-code text for preview',
            content: {
              'text/plain': { schema: z.string(), example: 'G21\nG90\nM83\nG1 X10 Y10 Z0.2 E1\n' },
            },
          },
          ...errors,
        },
      }),
      async (c) => {
        c.header('Cache-Control', 'no-store');
        return c.text(await preview.text(c.req.valid('param').uuid), 200);
      },
    );
    registerPreviewRoutes(app, services, preview);
  }
  const webRoot = resolve('dist/web');
  app.get('/assets/*', serveStatic({ root: webRoot }));
  app.openapi(
    createRoute({
      method: 'get',
      path: '/preview/{uuid}',
      operationId: 'openPreview',
      summary: 'Open the browser preview shell',
      description:
        'Trusted LAN preview: open this URL to load paths/layers/statistics automatically, without token entry. Browser data/print routes are scoped to this UUID. Physical printing occurs only after the separate confirmed same-origin print action.',
      request: { params: fileParams },
      responses: {
        200: {
          description: 'React preview page',
          content: { 'text/html': { schema: z.string() } },
        },
        400: errors[400],
        404: errors[404],
        503: errors[503],
      },
    }),
    async (c) => {
      try {
        return c.html(await readFile(join(webRoot, 'index.html'), 'utf8'));
      } catch {
        throw new AppError('ui_unbuilt', 'Build the web application with npm run build', 503);
      }
    },
  );
  app.get('/', (c) => c.redirect('/docs'));
  const require = createRequire(import.meta.url),
    swaggerRoot = dirname(require.resolve('swagger-ui-dist/package.json'));
  app.get(
    '/swagger/*',
    serveStatic({ root: swaggerRoot, rewriteRequestPath: (p) => p.replace('/swagger/', '') }),
  );
  app.get('/docs', (c) =>
    c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>pi_wedge API</title><link rel="stylesheet" href="/swagger/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/swagger/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false,validatorUrl:null})</script></body></html>`,
    ),
  );
  app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description:
      'Administrator API_TOKEN. Required for /api/* agent and administration operations and POST /mcp. The trusted LAN browser preview uses /preview/* without token entry.',
  });
  const documentConfig = {
    openapi: '3.1.0',
    info: {
      title: 'pi_wedge',
      version: '0.1.0',
      description:
        'LAN-only asynchronous slicing, persistent UUID files and explicit physical A1 mini printing. Upload/slice/retrieve never start printing.',
    },
  };
  app.get('/openapi.json', (c) => {
    const document = app.getOpenAPI31Document(documentConfig);
    const body = document.paths?.['/api/slices']?.post?.requestBody;
    if (body && !('$ref' in body)) body.required = true;
    return c.json(document);
  });
  return app;
}
