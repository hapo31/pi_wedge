import { z } from 'zod';
const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_TOKEN: z.string().min(32),
  DATA_DIR: z.string().default('./.data/app'),
  STORAGE_BACKEND: z.enum(['local', 's3']).default('s3'),
  S3_ENDPOINT: z.url().default('http://127.0.0.1:8333'),
  S3_BUCKET: z.string().default('pi-wedge'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(50),
  MAX_ARTIFACT_MB: z.coerce.number().int().min(1).max(1024).default(200),
  MAX_PREVIEW_MB: z.coerce.number().int().min(1).max(32).default(32),
  SLICE_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  MAX_QUEUED_JOBS: z.coerce.number().int().min(1).max(100).default(20),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3600000).default(600000),
  TOOLS_BACKEND: z.enum(['native', 'docker']).default('native'),
  TOOLS_IMAGE: z
    .string()
    .regex(/^[a-zA-Z0-9_./:@-]+$/)
    .default('pi-wedge-tools:0.1'),
  ORCA_BIN: z.string().default('/opt/orcaslicer/AppRun'),
  ORCA_XVFB: bool,
  PROFILE_DIR: z.string().default('./profiles/generated'),
  FREECAD_PYTHON: z.string().default('/usr/bin/python3'),
  FREECAD_MODULE_PATH: z.string().default('/usr/lib/freecad-python3/lib'),
  PRINTER_ENABLED: bool,
  PRINTER_HOST: z
    .string()
    .regex(/^[a-zA-Z0-9.-]*$/)
    .default(''),
  PRINTER_SERIAL: z
    .string()
    .regex(/^[A-Za-z0-9]*$/)
    .default(''),
  PRINTER_ACCESS_CODE: z.string().default(''),
  PRINTER_CA_FILE: z.string().default(''),
  PRINTER_INSECURE_TLS: bool,
  PRINTER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
});
export type Config = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration keys: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const c = parsed.data;
  if (c.STORAGE_BACKEND === 's3' && (!c.S3_ACCESS_KEY || !c.S3_SECRET_KEY))
    throw new Error('S3 credentials required');
  if (c.PRINTER_ENABLED && (!c.PRINTER_HOST || !c.PRINTER_SERIAL || !c.PRINTER_ACCESS_CODE))
    throw new Error('Printer host, serial and access code required');
  return c;
}
