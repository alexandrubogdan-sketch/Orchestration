import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WorkflowEngine } from '../../workflow/engine.js';
import { helloWorldTask } from '../../workflow/tasks/helloWorld.js';

const helloWorldBodySchema = z.object({
  message: z.string().min(1).max(500),
});

export function registerDevRoutes(app: FastifyInstance, engine: WorkflowEngine): void {
  app.post('/dev/dispatch-hello-world', async (request, reply) => {
    const parsed = helloWorldBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        type: 'about:blank',
        title: 'Invalid request body',
        status: 400,
        detail: parsed.error.message,
      });
    }

    await engine.dispatch(helloWorldTask.name, parsed.data);
    return reply.status(202).send({ status: 'dispatched', task: helloWorldTask.name });
  });
}
