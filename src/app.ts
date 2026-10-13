import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
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
  SliceOptionsSchema,
  Uuid,
} from './domain/schemas.js';
import { AppError, safeError, logError } from './domain/errors.js';
const json = <T extends z.ZodType>(schema: T, description: string, example?: unknown) => ({
  description,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});
const errors = {
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
  app.use('/api/*', async (c, next) => {
    if (!services) throw new AppError('unavailable', 'Services are not configured', 503);
    const supplied = Buffer.from(c.req.header('Authorization')?.replace(/^Bearer /, '') ?? ''),
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
        method: 'get',
        path: '/api/printer/operations/{operationId}',
        operationId: 'getPrintOperation',
        security: secured,
        summary: 'Read a persisted print dispatch result',
        description:
          'Read-only. No physical printer side effects. unknown/pending does not trigger a retry.',
        request: { params: z.object({ operationId: Uuid }) },
        responses: { 200: json(OperationSchema, 'Persisted print operation'), ...errors },
      }),
      (c) => c.json(printer.get(c.req.valid('param').operationId), 200),
    );
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/printer/operations/{operationId}/resolve',
        operationId: 'resolvePrintOutcome',
        security: secured,
        summary: 'Record a physically inspected unknown print outcome',
        description:
          'Administrator action after checking the actual printer. Updates local operation state only; does not contact or move the device. Resolving as failed permits a new explicit print with a new key. Never use this as automatic retry logic.',
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
        responses: { 200: json(OperationSchema, 'Unknown state manually resolved'), ...errors },
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
  const require = createRequire(import.meta.url),
    swaggerRoot = dirname(require.resolve('swagger-ui-dist/package.json'));
  app.get(
    '/swagger/*',
    serveStatic({ root: swaggerRoot, rewriteRequestPath: (p) => p.replace('/swagger/', '') }),
  );
  app.get('/docs', (c) =>
    c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>pi_wedge API</title><link rel="stylesheet" href="/swagger/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/swagger/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false})</script></body></html>`,
    ),
  );
  app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Administrator API_TOKEN. Required for all data and printer operations.',
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
