import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { DeliveryMode, WorkerStreamEvent } from '@meepo/protocol';

const RESULT_SUMMARY_MAX_CHARS = 2_000;

/**
 * Structural subset of pi's `Agent` used by {@link SessionRunner}. The real
 * `Agent` satisfies this interface; tests substitute a fake.
 */
export interface RunnerAgent {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(input: string): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
}

interface TaskContext {
  workerId: string;
  sessionId?: string;
  ticketId?: string;
}

/**
 * Maps pi agent events to Meepo stream events and tracks per-task outcome
 * (final assistant text, token usage, failure) so the owner can emit
 * `task_completed` / `task_failed` when a run settles.
 */
export class StreamForwarder {
  private taskId?: string;
  private lastAssistantText = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private failure?: { error: string; code?: string };

  constructor(private readonly emit: (event: WorkerStreamEvent) => void) {}

  get currentTaskId(): string | undefined {
    return this.taskId;
  }

  get failed(): { error: string; code?: string } | undefined {
    return this.failure;
  }

  beginTask(taskId: string, context: TaskContext): void {
    this.taskId = taskId;
    this.lastAssistantText = '';
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.failure = undefined;
    this.emit({
      type: 'task_started',
      taskId,
      workerId: context.workerId,
      sessionId: context.sessionId,
      ticketId: context.ticketId,
    });
  }

  handleEvent(event: AgentEvent): void {
    if (!this.taskId) return;
    const taskId = this.taskId;
    switch (event.type) {
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e.type === 'text_delta') this.emit({ type: 'text_delta', taskId, delta: e.delta });
        if (e.type === 'thinking_delta') {
          this.emit({ type: 'thinking_delta', taskId, delta: e.delta });
        }
        break;
      }
      case 'tool_execution_start':
        this.emit({
          type: 'tool_execution_start',
          taskId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args as unknown,
        });
        break;
      case 'tool_execution_update':
        this.emit({
          type: 'tool_execution_update',
          taskId,
          toolCallId: event.toolCallId,
          partialResult: event.partialResult as unknown,
        });
        break;
      case 'tool_execution_end':
        this.emit({
          type: 'tool_execution_end',
          taskId,
          toolCallId: event.toolCallId,
          result: event.result as unknown,
          isError: event.isError,
        });
        break;
      case 'message_end':
        if (event.message.role === 'assistant') this.trackAssistantMessage(event.message);
        break;
      default:
        break;
    }
  }

  /** Emit the terminal event for the current task: failed if the run errored/aborted, else completed. */
  completeTask(): void {
    if (!this.taskId) return;
    if (this.failure) {
      this.emit({ type: 'task_failed', taskId: this.taskId, ...this.failure });
    } else {
      this.emit({
        type: 'task_completed',
        taskId: this.taskId,
        resultSummary: this.lastAssistantText.slice(0, RESULT_SUMMARY_MAX_CHARS) || undefined,
        usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      });
    }
    this.taskId = undefined;
  }

  /** Unconditionally fail the current task (timeout, abort before any assistant output, ...). */
  failTask(error: string, code?: string): void {
    if (!this.taskId) return;
    this.emit({ type: 'task_failed', taskId: this.taskId, error, code });
    this.taskId = undefined;
  }

  /** Fail a task that never started (dropped from a queue); does not touch the current task. */
  failPendingTask(taskId: string, error: string, code?: string): void {
    this.emit({ type: 'task_failed', taskId, error, code });
  }

  private trackAssistantMessage(message: AssistantMessage): void {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text) this.lastAssistantText = text;
    this.inputTokens += message.usage.input;
    this.outputTokens += message.usage.output;
    if (message.stopReason === 'error') {
      this.failure = { error: message.errorMessage ?? 'model request failed', code: 'error' };
    } else if (message.stopReason === 'aborted') {
      this.failure = { error: message.errorMessage ?? 'turn aborted', code: 'aborted' };
    }
  }
}

interface QueuedTurn {
  taskId: string;
  prompt: string;
  timeoutSeconds?: number;
}

export interface SessionRunnerOptions {
  agent: RunnerAgent;
  sessionId: string;
  workerId: string;
  emit: (event: WorkerStreamEvent) => void;
  now?: () => number;
}

/**
 * Wraps one pi Agent (one Meepo session). Turns are executed serially:
 * - `urgent` steers into the in-flight run and takes over the stream at the
 *   point the steered message enters the transcript;
 * - `wait` queues behind the current turn;
 * - `if_idle` is dropped while busy.
 */
export class SessionRunner {
  private readonly agent: RunnerAgent;
  private readonly sessionId: string;
  private readonly workerId: string;
  private readonly forwarder: StreamForwarder;
  private readonly now: () => number;
  private readonly queue: QueuedTurn[] = [];
  private readonly steeredTurns: QueuedTurn[] = [];
  private current?: QueuedTurn;
  private running = false;
  private sawInitialUserMessage = false;
  private timedOut = false;
  private abortedCurrent = false;
  private timeoutTimer?: NodeJS.Timeout;
  /** Last time this runner had no active or queued work. */
  idleSince: number;

  constructor(options: SessionRunnerOptions) {
    this.agent = options.agent;
    this.sessionId = options.sessionId;
    this.workerId = options.workerId;
    this.now = options.now ?? Date.now;
    this.forwarder = new StreamForwarder(options.emit);
    this.idleSince = this.now();
    this.agent.subscribe((event) => this.onAgentEvent(event));
  }

  get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  runTurn(taskId: string, prompt: string, delivery: DeliveryMode, timeoutSeconds?: number): void {
    const turn: QueuedTurn = { taskId, prompt, timeoutSeconds };
    if (!this.running) {
      void this.startTurn(turn);
      return;
    }
    switch (delivery) {
      case 'urgent':
        this.steeredTurns.push(turn);
        this.agent.steer({ role: 'user', content: prompt, timestamp: this.now() });
        break;
      case 'wait':
        this.queue.push(turn);
        break;
      case 'if_idle':
        break;
    }
  }

  /** Inject a free-form steering message into the in-flight turn. */
  steer(message: string): void {
    this.agent.steer({ role: 'user', content: message, timestamp: this.now() });
  }

  /**
   * Abort a task: the running turn via the agent's abort signal; queued or
   * steered-but-not-started tasks are failed immediately. Returns false when
   * the task is unknown to this runner.
   */
  abort(taskId: string, reason?: string): boolean {
    if (this.current?.taskId === taskId) {
      this.abortedCurrent = true;
      this.agent.abort();
      return true;
    }
    const queued =
      this.removePending(this.queue, taskId) ?? this.removePending(this.steeredTurns, taskId);
    if (queued) {
      this.forwarder.failPendingTask(taskId, reason ?? 'aborted before execution', 'aborted');
      return true;
    }
    return false;
  }

  private removePending(list: QueuedTurn[], taskId: string): QueuedTurn | undefined {
    const index = list.findIndex((turn) => turn.taskId === taskId);
    if (index < 0) return undefined;
    return list.splice(index, 1)[0];
  }

  private onAgentEvent(event: AgentEvent): void {
    this.forwarder.handleEvent(event);
    if (event.type === 'message_start' && event.message.role === 'user') {
      this.onUserMessageStart();
    }
  }

  /**
   * A user message entering the transcript mid-run is a steered message being
   * injected: hand the stream over from the interrupted task to the steered one.
   */
  private onUserMessageStart(): void {
    if (!this.running) return;
    if (!this.sawInitialUserMessage) {
      this.sawInitialUserMessage = true;
      return;
    }
    const next = this.steeredTurns.shift();
    if (!next) return;
    this.completeCurrent();
    this.current = next;
    this.abortedCurrent = false;
    this.forwarder.beginTask(next.taskId, { workerId: this.workerId, sessionId: this.sessionId });
  }

  private async startTurn(turn: QueuedTurn): Promise<void> {
    this.running = true;
    this.current = turn;
    this.sawInitialUserMessage = false;
    this.timedOut = false;
    this.abortedCurrent = false;
    this.forwarder.beginTask(turn.taskId, { workerId: this.workerId, sessionId: this.sessionId });
    this.armTimeout(turn);
    try {
      await this.agent.prompt(turn.prompt);
      this.completeCurrent();
    } catch (err) {
      this.forwarder.failTask((err as Error).message, 'internal');
    } finally {
      this.clearTimeout();
      for (const skipped of this.steeredTurns.splice(0)) {
        this.forwarder.failPendingTask(
          skipped.taskId,
          'run ended before steering took effect',
          'aborted'
        );
      }
      this.current = undefined;
      this.running = false;
      this.idleSince = this.now();
      const next = this.queue.shift();
      if (next) void this.startTurn(next);
    }
  }

  private completeCurrent(): void {
    if (this.timedOut) {
      this.forwarder.failTask(`turn timed out`, 'timeout');
    } else if (this.abortedCurrent && !this.forwarder.failed) {
      this.forwarder.failTask('turn aborted', 'aborted');
    } else {
      this.forwarder.completeTask();
    }
  }

  private armTimeout(turn: QueuedTurn): void {
    if (!turn.timeoutSeconds) return;
    this.timeoutTimer = setTimeout(() => {
      this.timedOut = true;
      this.agent.abort();
    }, turn.timeoutSeconds * 1000);
    this.timeoutTimer.unref();
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }
}
