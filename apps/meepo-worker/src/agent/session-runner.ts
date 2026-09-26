import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { DeliveryMode, WorkerStreamEvent } from '@meepo/protocol';

import type { SlotSemaphore } from './slot-semaphore.js';

const RESULT_SUMMARY_MAX_CHARS = 2_000;
/** Messages kept when compaction is unavailable and history must be truncated. */
export const FALLBACK_KEEP_RECENT_MESSAGES = 20;

/**
 * Structural subset of pi's `Agent` used by {@link SessionRunner}. The real
 * `Agent` satisfies this interface; tests substitute a fake.
 */
export interface RunnerAgent {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(input: string): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
  readonly state: { messages: AgentMessage[] };
}

/** Pre-turn history compaction, implemented over pi's harness/compaction helpers. */
export interface SessionCompactor {
  /** Estimated context tokens for the current messages. */
  estimate(messages: AgentMessage[]): number;
  /** Whether the estimated usage crosses the compaction threshold. */
  shouldCompact(tokens: number): boolean;
  /**
   * Produce a compacted replacement for `messages` (summary + retained tail),
   * or undefined when summarization is unavailable — the runner then falls
   * back to keeping only the most recent messages.
   */
  compact(messages: AgentMessage[]): Promise<AgentMessage[] | undefined>;
}

/** Keep only the last `count` messages (crude truncation fallback). */
export function keepRecentMessages(messages: AgentMessage[], count: number): AgentMessage[] {
  return messages.slice(Math.max(0, messages.length - count));
}

interface RunContext {
  workerId: string;
  sessionId?: string;
  ticketId?: string;
}

/**
 * Maps pi agent events to Meepo stream events and tracks per-run outcome
 * (final assistant text, token usage, failure) so the owner can emit
 * `run_completed` / `run_failed` when a run settles.
 */
export class StreamForwarder {
  private runId?: string;
  private lastAssistantText = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private failure?: { error: string; code?: string };

  constructor(private readonly emit: (event: WorkerStreamEvent) => void) {}

  get currentRunId(): string | undefined {
    return this.runId;
  }

  get failed(): { error: string; code?: string } | undefined {
    return this.failure;
  }

  beginRun(runId: string, context: RunContext): void {
    this.runId = runId;
    this.lastAssistantText = '';
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.failure = undefined;
    this.emit({
      type: 'run_started',
      runId,
      workerId: context.workerId,
      sessionId: context.sessionId,
      ticketId: context.ticketId,
    });
  }

  handleEvent(event: AgentEvent): void {
    if (!this.runId) return;
    const runId = this.runId;
    switch (event.type) {
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e.type === 'text_delta') this.emit({ type: 'text_delta', runId, delta: e.delta });
        if (e.type === 'thinking_delta') {
          this.emit({ type: 'thinking_delta', runId, delta: e.delta });
        }
        break;
      }
      case 'tool_execution_start':
        this.emit({
          type: 'tool_execution_start',
          runId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args as unknown,
        });
        break;
      case 'tool_execution_update':
        this.emit({
          type: 'tool_execution_update',
          runId,
          toolCallId: event.toolCallId,
          partialResult: event.partialResult as unknown,
        });
        break;
      case 'tool_execution_end':
        this.emit({
          type: 'tool_execution_end',
          runId,
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

  /** Emit the terminal event for the current run: failed if it errored/aborted, else completed. */
  completeRun(): void {
    if (!this.runId) return;
    if (this.failure) {
      this.emit({ type: 'run_failed', runId: this.runId, ...this.failure });
    } else {
      this.emit({
        type: 'run_completed',
        runId: this.runId,
        resultSummary: this.lastAssistantText.slice(0, RESULT_SUMMARY_MAX_CHARS) || undefined,
        usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      });
    }
    this.runId = undefined;
  }

  /** Unconditionally fail the current run (timeout, abort before any assistant output, ...). */
  failRun(error: string, code?: string): void {
    if (!this.runId) return;
    this.emit({ type: 'run_failed', runId: this.runId, error, code });
    this.runId = undefined;
  }

  /** Fail a run that never started (dropped from a queue); does not touch the current run. */
  failPendingRun(runId: string, error: string, code?: string): void {
    this.emit({ type: 'run_failed', runId, error, code });
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

export interface QueuedTurn {
  runId: string;
  prompt: string;
  timeoutSeconds?: number;
}

/**
 * Merge queued `wait` turns into a single turn: several chat messages that
 * arrived while the agent was busy are answered together. Each prompt keeps
 * its `[author]` prefix (if any) and is annotated with its position; the
 * merged turn takes the last runId, which identifies all stream events.
 */
export function mergeQueuedTurns(turns: QueuedTurn[]): QueuedTurn | undefined {
  if (turns.length === 0) return undefined;
  if (turns.length === 1) return turns[0];
  const last = turns[turns.length - 1];
  const prompt = turns
    .map((turn, index) => `[${index + 1}/${turns.length}] ${turn.prompt}`)
    .join('\n\n');
  return { runId: last.runId, prompt, timeoutSeconds: last.timeoutSeconds };
}

export interface SessionRunnerOptions {
  agent: RunnerAgent;
  sessionId: string;
  workerId: string;
  emit: (event: WorkerStreamEvent) => void;
  now?: () => number;
  /** Pre-turn history compaction; omit to disable (tickets, tests). */
  compactor?: SessionCompactor;
  /** Worker-global run concurrency limit; omit for unbounded (tests). */
  slots?: SlotSemaphore;
}

/**
 * Wraps one pi Agent (one Meepo session). Turns are executed serially:
 * - `urgent` steers into the in-flight run and takes over the stream at the
 *   point the steered message enters the transcript;
 * - `wait` queues behind the current turn; queued waits are merged into one
 *   turn when drained (chat bursts produce a single reply);
 * - `if_idle` is dropped while busy.
 * Before each turn the history is compacted when it crosses the context
 * threshold (see {@link SessionCompactor}).
 */
export class SessionRunner {
  private readonly agent: RunnerAgent;
  private readonly sessionId: string;
  private readonly workerId: string;
  private readonly forwarder: StreamForwarder;
  private readonly now: () => number;
  private readonly compactor?: SessionCompactor;
  private readonly slots?: SlotSemaphore;
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
    this.compactor = options.compactor;
    this.slots = options.slots;
    this.forwarder = new StreamForwarder(options.emit);
    this.idleSince = this.now();
    this.agent.subscribe((event) => this.onAgentEvent(event));
  }

  get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  runTurn(runId: string, prompt: string, delivery: DeliveryMode, timeoutSeconds?: number): void {
    const turn: QueuedTurn = { runId, prompt, timeoutSeconds };
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

  /** Inject a free-form steering message into the in-flight run. */
  steer(message: string): void {
    this.agent.steer({ role: 'user', content: message, timestamp: this.now() });
  }

  /**
   * Abort a run: the running turn via the agent's abort signal; queued or
   * steered-but-not-started runs are failed immediately. Returns false when
   * the run is unknown to this runner.
   */
  abort(runId: string, reason?: string): boolean {
    if (this.current?.runId === runId) {
      this.abortedCurrent = true;
      this.agent.abort();
      return true;
    }
    const queued =
      this.removePending(this.queue, runId) ?? this.removePending(this.steeredTurns, runId);
    if (queued) {
      this.forwarder.failPendingRun(runId, reason ?? 'aborted before execution', 'aborted');
      return true;
    }
    return false;
  }

  private removePending(list: QueuedTurn[], runId: string): QueuedTurn | undefined {
    const index = list.findIndex((turn) => turn.runId === runId);
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
   * injected: hand the stream over from the interrupted run to the steered one.
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
    this.forwarder.beginRun(next.runId, { workerId: this.workerId, sessionId: this.sessionId });
  }

  private async startTurn(turn: QueuedTurn): Promise<void> {
    this.running = true;
    this.current = turn;
    this.sawInitialUserMessage = false;
    this.timedOut = false;
    this.abortedCurrent = false;
    this.armTimeout(turn);
    // Awaited only when configured, keeping prompt() same-tick otherwise.
    if (this.slots) await this.slots.acquire();
    try {
      if (this.timedOut || this.abortedCurrent) {
        // Aborted or timed out while queued for a slot: never started.
        this.forwarder.failPendingRun(
          turn.runId,
          this.timedOut ? 'turn timed out' : 'turn aborted',
          this.timedOut ? 'timeout' : 'aborted'
        );
      } else {
        this.forwarder.beginRun(turn.runId, { workerId: this.workerId, sessionId: this.sessionId });
        if (this.compactor) await this.maybeCompactHistory();
        await this.agent.prompt(turn.prompt);
        this.completeCurrent();
      }
    } catch (err) {
      this.forwarder.failRun((err as Error).message, 'internal');
    } finally {
      this.slots?.release();
      this.clearTimeout();
      for (const skipped of this.steeredTurns.splice(0)) {
        this.forwarder.failPendingRun(
          skipped.runId,
          'run ended before steering took effect',
          'aborted'
        );
      }
      this.current = undefined;
      this.running = false;
      this.idleSince = this.now();
      const next = mergeQueuedTurns(this.queue.splice(0));
      if (next) void this.startTurn(next);
    }
  }

  /** Compact the transcript before the turn when it crosses the context threshold. */
  private async maybeCompactHistory(): Promise<void> {
    if (!this.compactor) return;
    const messages = this.agent.state.messages;
    if (messages.length === 0) return;
    if (!this.compactor.shouldCompact(this.compactor.estimate(messages))) return;
    let compacted: AgentMessage[] | undefined;
    try {
      compacted = await this.compactor.compact(messages);
    } catch {
      compacted = undefined;
    }
    this.agent.state.messages =
      compacted ?? keepRecentMessages(messages, FALLBACK_KEEP_RECENT_MESSAGES);
  }

  private completeCurrent(): void {
    if (this.timedOut) {
      this.forwarder.failRun(`turn timed out`, 'timeout');
    } else if (this.abortedCurrent && !this.forwarder.failed) {
      this.forwarder.failRun('turn aborted', 'aborted');
    } else {
      this.forwarder.completeRun();
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
