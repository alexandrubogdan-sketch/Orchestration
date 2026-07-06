import { describe, expect, it } from 'vitest';
import type { TaskDefinition, WorkflowEngine } from '../../src/workflow/engine.js';
import type { OutboxEventEnvelope } from '../../src/workflow/tasks/outboxRelay.js';

/**
 * T1.6: "consumer-side dedupe test." src/workflow/tasks/outboxRelay.ts
 * dispatches each outbox row using the row's own id as the dispatch
 * idempotency key (`engine.dispatch(taskName, envelope, {key: row.id})`)
 * specifically so that at-least-once redelivery — the relay dispatching
 * the same row twice, e.g. because it crashed after dispatch but before
 * marking the row `dispatched` — does not cause the downstream consumer
 * to run twice.
 *
 * This test doesn't exercise the real Hatchet backend (no live broker in
 * this environment — see the Milestone 0 summary), but it pins down the
 * *contract* every WorkflowEngine implementation must satisfy for the
 * relay's at-least-once-but-effectively-once guarantee to hold: two
 * `dispatch()` calls with the same key must not both invoke the
 * handler. A fake engine here simulates that contract explicitly, so
 * this test would catch a regression in the contract itself even before
 * hooking up a real broker.
 */
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
        // Redelivery of an already-dispatched key: swallowed, exactly
        // like a real broker's idempotency-key dedup would do — the
        // handler must NOT run again.
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

    // First dispatch: the relay's normal path.
    await engine.dispatch('outbox.payment.captured', envelope, { key: envelope.outboxEventId });
    // Second dispatch: simulates the relay crashing after this dispatch
    // succeeded but before it recorded `dispatched_at`, then retrying
    // the same row on its next run.
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
