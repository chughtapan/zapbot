/**
 * Build a structured JSON error response.
 */
export function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message, status } }, { status });
}
