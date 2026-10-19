import {
  HatchetClient,
  type Context,
  type TaskWorkflowDeclaration,
} from '@hatchet-dev/typescript-sdk/v1/index.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../observability/logger.js';
import type {
  CronOptions,
  DispatchOptions,
  ScheduleOptions,
  TaskDefinition,
  WorkflowEngine,
} from './engine.js';

interface TaskEnvelope<Input> {
  payload: Input;
  concurrencyKey?: string | undefined;
}

type HatchetTaskOptions = Parameters<HatchetClient['task']>[0];

/* eslint-disable @typescript-eslint/no-explicit-any */
export class HatchetWorkflowEngine implements WorkflowEngine {
  private readonly hatchet: HatchetClient;
  private readonly definitions = new Map<string, TaskDefinition<unknown, unknown>>();
  private readonly declarations = new Map<string, TaskWorkflowDeclaration<any, any>>();
  private worker: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  constructor(
    config: Pick<AppConfig, 'hatchet'>,
    private readonly logger: Logger,
  ) {
    this.hatchet = HatchetClient.init({
      token: config.hatchet.token,
      tls_config: { tls_strategy: config.hatchet.tlsStrategy },
    });
  }

  registerTask<Input, Output>(definition: TaskDefinition<Input, Output>): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Task "${definition.name}" is already registered`);
    }
    this.definitions.set(definition.name, definition as TaskDefinition<unknown, unknown>);

    const options = {
      name: definition.name,
      retries: definition.retries ?? 3,
      ...(definition.concurrencyKey
        ? { concurrency: { expression: 'input.concurrencyKey', maxRuns: 1 } }
        : {}),
      fn: (input: TaskEnvelope<Input>, ctx: Context<TaskEnvelope<Input>>) =>
        definition.handler(input.payload, {
          taskName: definition.name,
          attempt: ctx.retryCount() + 1,
          logger: {
            info: (msg, meta) => this.logger.info(meta ?? {}, `[${definition.name}] ${msg}`),
            error: (msg, meta) => this.logger.error(meta ?? {}, `[${definition.name}] ${msg}`),
          },
        }),
    } as unknown as HatchetTaskOptions;

    const declaration = this.hatchet.task(options) as unknown as TaskWorkflowDeclaration<any, any>;

    this.declarations.set(definition.name, declaration);
  }

  private getDeclaration(taskName: string): TaskWorkflowDeclaration<any, any> {
    const declaration = this.declarations.get(taskName);
    if (!declaration) {
      throw new Error(`Task "${taskName}" has not been registered via registerTask()`);
    }
    return declaration;
  }

  private resolveConcurrencyKey<Input>(taskName: string, input: Input): string | undefined {
    return this.definitions.get(taskName)?.concurrencyKey?.(input);
  }

  async dispatch<Input>(taskName: string, input: Input, options?: DispatchOptions): Promise<void> {
    const envelope: TaskEnvelope<Input> = {
      payload: input,
      concurrencyKey: this.resolveConcurrencyKey(taskName, input),
    };
    await this.getDeclaration(taskName).runNoWait(
      envelope,
      options?.key ? { additionalMetadata: { idempotencyKey: options.key } } : undefined,
    );
  }

  async schedule<Input>(taskName: string, input: Input, options: ScheduleOptions): Promise<void> {
    const envelope: TaskEnvelope<Input> = {
      payload: input,
      concurrencyKey: this.resolveConcurrencyKey(taskName, input),
    };
    await this.getDeclaration(taskName).schedule(
      options.at,
      envelope,
      options.key ? { additionalMetadata: { idempotencyKey: options.key } } : undefined,
    );
  }

  async cron<Input>(taskName: string, input: Input, options: CronOptions): Promise<void> {
    const envelope: TaskEnvelope<Input> = {
      payload: input,
      concurrencyKey: this.resolveConcurrencyKey(taskName, input),
    };
    await this.getDeclaration(taskName).cron(`${taskName}-cron`, options.expression, envelope);
  }

  async start(): Promise<void> {
    this.worker = await this.hatchet.worker('payment-orchestrator-worker', {
      workflows: [...this.declarations.values()],
    });
    await this.worker.start();
  }

  async stop(): Promise<void> {
    await this.worker?.stop();
  }
}
