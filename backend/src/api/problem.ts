import type { FastifyReply } from 'fastify';
import type { ZodError } from 'zod';

/** RFC 7807 problem+json — the one shared shape every M4 route uses. */
export function sendProblem(reply: FastifyReply, status: number, title: string, detail?: string) {
  return reply
    .status(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) });
}

export function sendValidationError(reply: FastifyReply, error: ZodError) {
  return sendProblem(
    reply,
    400,
    'Validation failed',
    error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  );
}
