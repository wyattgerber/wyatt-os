/** An error whose `message` is safe and friendly to show to an accountant. `detail` is for logs only. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

export function toErrorBody(e: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (e instanceof ApiError) {
    return { status: e.status, body: { error: { code: e.code, message: e.message } } };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'Something went wrong on the server. Please try again; if it keeps happening, contact the report owner.' } },
  };
}
