// The package root export (`@hatchet-dev/typescript-sdk`) is the
// deprecated v0 SDK (removed at runtime as of Hatchet 1.14 — importing it
// only logs deprecation warnings, but the real v1 client class lives in
// the `v1` subpath). That subpath has no package.json/"exports" entry of
// its own, so under Node's strict ESM resolution (our package.json is
// "type": "module") TypeScript won't infer the directory's index.js the
// way plain CJS `require()` does — the explicit file extension below is
// required. This is a third-party packaging quirk in the Hatchet SDK,
// not a project decision; revisit if a future SDK release adds proper
// "exports" map entries.
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

/**
 * Hatchet's own `InputType`/`OutputType` constraints require plain JSON
 * objects (see @hatchet-dev/typescript-sdk/v1/types.d.ts). Our
 * WorkflowEngine interface (engine.ts) deliberately keeps `Input`/`Output`
 * unconstrained generics so it stays engine-agnostic (Inngest/Temporal
 * wouldn't necessarily share Hatchet's JSON-object constraint). That
 * mismatch means TypeScript can't cleanly unify `HatchetClient.task<I,
 * O>()`'s generics with our own generics — the cast below is the single,
 * well-contained place where we assert "trust us, TaskEnvelope<Input> is
 * JSON-safe," which is true in practice for every task this codebase
 * defines (payment/webhook payloads are always JSON).
 */
type HatchetTaskOptions = Parameters<HatchetClient['task']>[0];

/**
 * Hatchet-backed implementation of WorkflowEngine, targeting the v1
 * TypeScript SDK (`@hatchet-dev/typescript-sdk/v1` — the root package
 * export is the deprecated v0 SDK, removed as of Hatchet 1.14; see
 * https://docs.hatchet.run/home/v1-sdk-improvements).
 *
 * This is the ONLY file (besides engine.ts) that may import the Hatchet
 * SDK — everything else in the codebase talks to the WorkflowEngine
 * interface, per the same isolation rule SPEC.md applies to PSP adapters.
 *
 * Each registered TaskDefinition becomes a single Hatchet task (Hatchet
 * v1 tasks are directly runnable — no separate workflow wrapper needed
 * for our single-step use case). Concurrency keys map to Hatchet's
 * `concurrency.expression` (a CEL expression over the run input) with
 * `maxRuns: 1` — serialize-per-key, parallel-across-keys, per engine.ts.
 *
 * `TaskWorkflowDeclaration<any, any>` shows up repeatedly below: the SDK
 * constrains its generics to `JsonObject`, which our own engine-agnostic
 * `Input`/`Output` generics (engine.ts) don't satisfy structurally. `any`
 * sidesteps that constraint without weakening real safety, since every
 * caller of getDeclaration() only ever round-trips envelopes it built
 * itself (see registerTask/dispatch/schedule/cron below).
 */
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
