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
  name: string;
  handler: TaskHandler<Input, Output>;

  concurrencyKey?: (input: Input) => string;
  retries?: number;
}

export interface DispatchOptions {
  key?: string;
}

export interface ScheduleOptions {
  at: Date;
  key?: string;
}

export interface CronOptions {
  expression: string;
}

export interface WorkflowEngine {
  registerTask<Input, Output>(definition: TaskDefinition<Input, Output>): void;

  dispatch<Input>(taskName: string, input: Input, options?: DispatchOptions): Promise<void>;

  schedule<Input>(taskName: string, input: Input, options: ScheduleOptions): Promise<void>;

  cron<Input>(taskName: string, input: Input, options: CronOptions): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;
}
