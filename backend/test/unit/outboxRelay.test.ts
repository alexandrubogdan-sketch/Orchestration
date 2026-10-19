import { describe, expect, it } from 'vitest';
import type { TaskDefinition, WorkflowEngine } from '../../src/workflow/engine.js';
import type { OutboxEventEnvelope } from '../../src/workflow/tasks/outboxRelay.js';

class DedupingInMemoryWorkflowEngine implements WorkflowEngine {
  private tasks = new Map<string, TaskDefinition<unknown, unknown>>();
  private seenKeys = new Set<string>();

  registerTask<Input, Output>(definition: TaskDefinition<Input, Output>): void {
    this.tasks.set(definition.name, definition as TaskDefinition<unknown, unknown>);
  }

  async dispatch<Input>(taskName: string, input: Input, options?: { key?: string }): Promise<void> {
    const definition = this.tasks.get(taskName);
    if (!definition) throw new Error(`unknown task ${taskName}`);

    if (options?.key) {
      if (this.seenKeys.has(options.key)) {
        return;
      }
      this.seenKeys.add(options.key);
    }

    await definition.handler(input, {
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

describe('outbox relay — consumer-side dedupe contract', () => {
  it('redelivering the same outbox event id does not run the consumer twice', async () => {
    const engine = new DedupingInMemoryWorkflowEngine();

    let sideEffectCount = 0;
    engine.registerTask<OutboxEventEnvelope, void>({
      name: 'outbox.payment.captured',
      handler: (envelope) => {
        sideEffectCount += 1;
        expect(envelope.outboxEventId).toBe('outbox-row-1');
        return Promise.resolve();
      },
    });

    const envelope: OutboxEventEnvelope = {
      outboxEventId: 'outbox-row-1',
      aggregateType: 'payment',
      aggregateId: 'payment-1',
      eventType: 'payment.captured',
      payload: { amountMinorUnits: 1999, currency: 'USD' },
    };

    await engine.dispatch('outbox.payment.captured', envelope, { key: envelope.outboxEventId });

    await engine.dispatch('outbox.payment.captured', envelope, { key: envelope.outboxEventId });

    expect(sideEffectCount).toBe(1);
  });

  it('two different outbox rows (different keys) both run, even for the same event type', async () => {
    const engine = new DedupingInMemoryWorkflowEngine();
    let sideEffectCount = 0;
    engine.registerTask<OutboxEventEnvelope, void>({
      name: 'outbox.payment.captured',
      handler: () => {
        sideEffectCount += 1;
        return Promise.resolve();
      },
    });

    await engine.dispatch(
      'outbox.payment.captured',
      {
        outboxEventId: 'row-1',
        aggregateType: 'payment',
        aggregateId: 'p1',
        eventType: 'payment.captured',
        payload: {},
      },
      { key: 'row-1' },
    );
    await engine.dispatch(
      'outbox.payment.captured',
      {
        outboxEventId: 'row-2',
        aggregateType: 'payment',
        aggregateId: 'p2',
        eventType: 'payment.captured',
        payload: {},
      },
      { key: 'row-2' },
    );

    expect(sideEffectCount).toBe(2);
  });
});
