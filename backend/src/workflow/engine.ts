/**
 * Durable-task engine interface. SPEC.md: "Hatchet (self-hosted via
 * Docker) for durable tasks/workflows/cron — wrap it behind
 * src/workflow/engine.ts interface (dispatch, schedule, cron) so it is
 * swappable for Inngest/Temporal."
 *
 * Nothing outside this file and workflow/hatchetEngine.ts may import the
 * Hatchet SDK directly — mirrors the adapter isolation rule for PSPs
 * (Non-negotiable #7), applied to the workflow engine so swapping it out
 * later is a one-file change plus a new implementation of this interface.
 */

export interface TaskContext {
  readonly taskName: string;
  readonly attempt: number;
  readonly logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export type TaskHandler<Input, Output> = (input: Input, ctx: TaskContext) => Promise<Output>;

export interface TaskDefinition<Input = unknown, Output = unknown> {
  /** Globally unique task name, e.g. "webhook.apply-event". */
  name: string;
  handler: TaskHandler<Input, Output>;
  /**
   * Concurrency key extractor. Tasks sharing the same resolved key are
   * serialized (concurrency 1); tasks with different keys run in
   * parallel. Used in M3 to serialize webhook processing per payment_id
   * while allowing cross-payment parallelism.
   */
  concurrencyKey?: (input: Input) => string;
  retries?: number;
}

export interface DispatchOptions {
  /** Idempotency/dedupe key for this specific dispatch. */
  key?: string;
}

export interface ScheduleOptions {
  /** ISO-8601 timestamp or Date to run at. */
  at: Date;
  key?: string;
}

export interface CronOptions {
  /** Standard 5-field cron expression, evaluated in UTC. */
  expression: string;
}

/**
 * The engine contract every task-runner backend (Hatchet today; Inngest/
 * Temporal are drop-in replacements later) must satisfy.
 */
export interface WorkflowEngine {
  /** Register a task definition. Must be called before start(). */
  registerTask<Input, Output>(definition: TaskDefinition<Input, Output>): void;

  /** Enqueue a task for immediate (durable, at-least-once) execution. */
  dispatch<Input>(taskName: string, input: Input, options?: DispatchOptions): Promise<void>;

  /** Enqueue a task for execution at a specific future time. */
  schedule<Input>(taskName: string, input: Input, options: ScheduleOptions): Promise<void>;

  /** Register a recurring cron trigger for a task. */
  cron<Input>(taskName: string, input: Input, options: CronOptions): Promise<void>;

  /** Start the worker loop (long-running; resolves on graceful shutdown). */
  start(): Promise<void>;

  /** Graceful shutdown. */
  stop(): Promise<void>;
}
