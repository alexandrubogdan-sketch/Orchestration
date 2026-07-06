import { describe, expect, it } from 'vitest';
import { helloWorldTask } from '../../src/workflow/tasks/helloWorld.js';

describe('helloWorldTask', () => {
  it('echoes the input message with a timestamp', async () => {
    const result = await helloWorldTask.handler(
      { message: 'ping' },
      {
        taskName: helloWorldTask.name,
        attempt: 1,
        logger: { info: () => {}, error: () => {} },
      },
    );
    expect(result.message).toBe('ping');
    expect(new Date(result.echoedAt).toISOString()).toBe(result.echoedAt);
  });
});
