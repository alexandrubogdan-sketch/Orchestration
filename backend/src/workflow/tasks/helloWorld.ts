import type { TaskDefinition } from '../engine.js';

export interface HelloWorldInput {
  message: string;
}

export interface HelloWorldOutput {
  echoedAt: string;
  message: string;
}

/**
 * T0.6: "worker process registering a hello-world Hatchet task; prove
 * dispatch round-trip." This is the whole proof surface for Milestone 0 —
 * no domain logic, just confirms api -> dispatch -> worker -> handler
 * executes through the WorkflowEngine abstraction end-to-end.
 */
export const helloWorldTask: TaskDefinition<HelloWorldInput, HelloWorldOutput> = {
  name: 'system.hello-world',
  retries: 1,
  handler: (input, ctx) => {
    ctx.logger.info('hello-world task executed', { message: input.message });
    return Promise.resolve({
      echoedAt: new Date().toISOString(),
      message: input.message,
    });
  },
};
