import { z } from '@hono/zod-openapi';
export const Uuid = z.string().uuid().openapi({ example: '0198cdf0-b8f1-4de0-8d67-2d9e95ed019c' });
export const ErrorInfo = z.object({ code: z.string(), message: z.string() });
export const ErrorResponse = z.object({ error: ErrorInfo }).openapi('ErrorResponse');
export const SliceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (name) =>
      ![...name].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    'Control characters are not allowed',
  );
export const SliceOptionsSchema = z
  .object({
    printerProfile: z.literal('a1-mini-0.4').default('a1-mini-0.4'),
    filamentProfile: z.literal('generic-pla').default('generic-pla'),
    layerHeight: z.number().min(0.08).max(0.28).default(0.2),
    infillDensity: z.number().min(0).max(100).default(15),
    support: z.boolean().default(false),
    mesh: z
      .object({
        linearDeflection: z.number().min(0.01).max(1).default(0.1),
        angularDeflection: z.number().min(0.05).max(1).default(0.5),
      })
      .strict()
      .default({ linearDeflection: 0.1, angularDeflection: 0.5 }),
    settings: z
      .object({
        wallLoops: z.number().int().min(1).max(10).optional(),
        topShellLayers: z.number().int().min(0).max(20).optional(),
        bottomShellLayers: z.number().int().min(0).max(20).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .openapi('SliceOptions');
export type SliceOptions = z.infer<typeof SliceOptionsSchema>;
export const FileSchema = z
  .object({
    id: Uuid,
    name: z.string(),
    displayName: SliceNameSchema.optional(),
    format: z.enum(['stl', 'step', 'gcode', 'gcode.3mf']),
    size: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    sourceModelId: Uuid.nullable(),
    sliceOptions: SliceOptionsSchema.nullable(),
    state: z.enum(['staging', 'ready', 'failed']),
    error: ErrorInfo.nullable(),
    estimatedSeconds: z.number().nonnegative().nullable(),
    filamentGrams: z.number().nonnegative().nullable(),
    filamentMillimeters: z.number().nonnegative().nullable(),
  })
  .openapi('FileMetadata');
export type FileMetadata = z.infer<typeof FileSchema>;
export const JobSchema = z
  .object({
    id: Uuid,
    modelId: Uuid,
    name: SliceNameSchema.optional(),
    options: SliceOptionsSchema,
    state: z.enum(['queued', 'running', 'succeeded', 'failed']),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    resultFileId: Uuid.nullable(),
    error: ErrorInfo.nullable(),
  })
  .openapi('SliceJob');
export type SliceJob = z.infer<typeof JobSchema>;
export const HistoryItemSchema = z
  .object({
    id: Uuid,
    name: z.string(),
    createdAt: z.string().datetime(),
    format: z.enum(['gcode', 'gcode.3mf']),
    estimatedSeconds: z.number().nonnegative().nullable(),
    filamentGrams: z.number().nonnegative().nullable(),
  })
  .openapi('SliceHistoryItem');
export const HistoryResponseSchema = z
  .object({
    items: z.array(HistoryItemSchema),
    nextCursor: Uuid.nullable(),
  })
  .openapi('SliceHistoryPage');
export const PrintOptionsSchema = z
  .object({
    plate: z.literal(1).default(1),
    bedLeveling: z.boolean().default(true),
    flowCalibration: z.boolean().default(false),
    vibrationCalibration: z.boolean().default(false),
    timelapse: z.boolean().default(false),
    useAms: z.boolean().default(false),
    amsMapping: z.array(z.number().int().min(0).max(3)).max(1).optional().openapi({
      description: 'Single-filament AMS Lite slot, zero-based (0–3). Required when useAms is true.',
    }),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.useAms && v.amsMapping?.length !== 1)
      c.addIssue({ code: 'custom', message: 'useAms requires one amsMapping slot' });
    if (!v.useAms && v.amsMapping)
      c.addIssue({ code: 'custom', message: 'amsMapping requires useAms' });
  })
  .openapi('PrintOptions');
export type PrintOptions = z.infer<typeof PrintOptionsSchema>;
export const PrintRequestSchema = z
  .object({
    fileId: Uuid,
    options: PrintOptionsSchema.default({
      plate: 1,
      bedLeveling: true,
      flowCalibration: false,
      vibrationCalibration: false,
      timelapse: false,
      useAms: false,
    }),
  })
  .strict()
  .openapi('PrintRequest');
export const OperationSchema = z
  .object({
    id: Uuid,
    fileId: Uuid,
    options: PrintOptionsSchema,
    state: z.enum(['pending', 'accepted', 'failed', 'unknown']),
    createdAt: z.string().datetime(),
    error: ErrorInfo.nullable(),
  })
  .openapi('PrintOperation');
export type PrintOperation = z.infer<typeof OperationSchema>;
export const StopRequestSchema = z.object({}).strict().openapi('StopPrintRequest');
export const StopOperationSchema = z
  .object({
    id: Uuid,
    action: z.literal('stop'),
    state: z.enum(['pending', 'accepted', 'failed', 'unknown']),
    createdAt: z.string().datetime(),
    error: ErrorInfo.nullable(),
  })
  .openapi('StopPrintOperation');
export type StopPrintOperation = z.infer<typeof StopOperationSchema>;
export const PrinterOperationSchema = z
  .union([OperationSchema, StopOperationSchema])
  .openapi('PrinterOperation');

export const PrinterStatusSchema = z
  .object({
    observedAt: z.string().datetime(),
    gcodeState: z.string().max(40).nullable(),
    amsConnected: z.boolean().nullable(),
    currentSlot: z.number().int().min(0).max(3).nullable(),
    externalSpoolActive: z.boolean().nullable(),
    slots: z
      .array(
        z.object({
          slot: z.number().int().min(0).max(3),
          present: z.boolean().nullable(),
          material: z.string().max(40).nullable(),
          color: z
            .string()
            .regex(/^#[0-9A-F]{6}$/)
            .nullable(),
          remainingPercent: z.number().int().min(0).max(100).nullable(),
          active: z.boolean(),
        }),
      )
      .max(4),
  })
  .openapi('PrinterStatus');
export type PrinterStatus = z.infer<typeof PrinterStatusSchema>;
export const BrowserPrintSchema = z
  .object({
    useAms: z.boolean().default(false),
    amsMapping: z.array(z.number().int().min(0).max(3)).length(1).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.useAms !== Boolean(v.amsMapping))
      c.addIssue({
        code: 'custom',
        message: 'AMS use requires exactly one slot; external spool must omit amsMapping',
      });
  })
  .openapi('BrowserPrintSettings');
