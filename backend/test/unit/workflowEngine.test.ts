import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEngine, TaskDefinition } from '../../src/workflow/engine.js';

class InMemoryWorkflowEngine implements WorkflowEngine {
  private tasks = new Map<string, TaskDefinition<any, any>>();
  public dispatched: Array<{ taskName: string; input: unknown }> = [];

  registerTask<Input, Output>(definition: TaskDefinition<Input, Output>): void {
    this.tasks.set(definition.name, definition);
  }

  async dispatch<Input>(taskName: string, input: Input): Promise<void> {
    const def = this.tasks.get(taskName);
    if (!def) throw new Error(`unknown task ${taskName}`);
    this.dispatched.push({ taskName, input });
    await def.handler(input, {
      taskName,
      attempt: 1,
      logger: { info: () => {}, error: () => {} },
    });
  }

  async schedule(): Promise<void> {}
  async cron(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe('WorkflowEngine contract', () => {
  it('round-trips a registered task through dispatch()', async () => {
    const engine = new InMemoryWorkflowEngine();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    engine.registerTask({ name: 'system.hello-world', handler });

    await engine.dispatch('system.hello-world', { message: 'hi' });

    expect(handler).toHaveBeenCalledWith(
      { message: 'hi' },
      expect.objectContaining({ taskName: 'system.hello-world', attempt: 1 }),
    );
    expect(engine.dispatched).toEqual([
      { taskName: 'system.hello-world', input: { message: 'hi' } },
    ]);
  });

  it('rejects dispatch to a task name that was never registered', async () => {
    const engine = new InMemoryWorkflowEngine();
    await expect(engine.dispatch('nonexistent.task', {})).rejects.toThrow(/unknown task/);
  });
});
