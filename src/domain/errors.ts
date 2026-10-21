export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 500,
    public readonly parentId?: string,
  ) {
    super(message);
  }
}
export function safeError(error: unknown): { code: string; message: string; parentId?: string } {
  return error instanceof AppError
    ? {
        code: error.code,
        message: error.message,
        ...(error.parentId ? { parentId: error.parentId } : {}),
      }
    : { code: 'internal_error', message: 'Internal operation failed. See server logs by ID.' };
}
export function logError(scope: string, id: string, error: unknown) {
  console.error(JSON.stringify({ level: 'error', scope, id, ...safeError(error) }));
}
