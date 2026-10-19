import type { TaskDefinition } from '../engine.js';

export interface HelloWorldInput {
  message: string;
}

export interface HelloWorldOutput {
  echoedAt: string;
  message: string;
}

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
