// One ticket: outcome, review controls, brief, and every attempt with its event trace.

import type { Ticket } from '@meepo/core';
import { useMemo, useState } from 'react';

import { api, type TicketRun } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import { useSpace } from '../../app/context';
import { spaceHref } from '../../app/router';
import { absoluteTime, compactNumber, duration, hostOf } from '../../lib/format';
import {
  ACTIVE_TICKET,
  CANCELLABLE_TICKET,
  MAX_TICKET_ATTEMPTS,
  runStatus,
  terminalReason,
  ticketStatus,
} from '../../lib/status';
import { Chip, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Markdown } from '../../ui/Markdown';
import { Callout, CopyButton, ErrorState, ListSkeleton, Time } from '../../ui/Misc';
import { useConfirm } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';
import { buildTimeline } from '../transcript/model';
import { Transcript } from '../transcript/Transcript';
import type { TicketDraft } from './NewTicketModal';

export function TicketDetail({
  ticket,
  onDuplicate,
}: {
  ticket: Ticket;
  onDuplicate: (draft: TicketDraft) => void;
}): React.JSX.Element {
  const space = useSpace();
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();
  const active = ACTIVE_TICKET.has(ticket.status);
  const runs = useQuery(keys.ticketRuns(ticket.id), () => api.ticketRuns(ticket.id), {
    interval: active ? 3_000 : undefined,
  });
  const workers = useQuery(keys.workers(space.id), () => api.listWorkers(space.id), {
    interval: 15_000,
  });
  // The server counts from 0 while a ticket has not been claimed yet.
  const attempt = ticket.attempt ?? 0;
  const status = ticketStatus(ticket.status);

  const act = async (action: 'cancel' | 'requeue' | 'abandon'): Promise<void> => {
    const copy = {
      cancel: {
        title: 'Cancel this ticket?',
        message:
          'The agent stops working on it. Anything already done is kept, and no more attempts are made.',
        confirmLabel: 'Cancel ticket',
        done: 'Ticket cancelled',
        tone: 'danger' as const,
      },
      requeue: {
        title: 'Retry this ticket?',
        message:
          'The agent starts over with a new attempt. If the earlier attempt got partway, some steps may be repeated.',
        confirmLabel: 'Retry',
        done: 'Ticket queued for another attempt',
        tone: 'default' as const,
      },
      abandon: {
        title: 'Abandon this ticket?',
        message:
          'It is closed as failed and will not run again. You can still create a new ticket from it.',
        confirmLabel: 'Abandon',
        done: 'Ticket abandoned',
        tone: 'danger' as const,
      },
    }[action];
    if (
      !(await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        tone: copy.tone,
      }))
    )
      return;
    const result = await run(() => api.ticketAction(ticket.id, action), {
      success: copy.done,
      key: action,
    });
    if (result) {
      invalidate(keys.tickets(space.id));
      invalidate(keys.ticketRuns(ticket.id));
    }
  };

  const workerName = (id: string | undefined): string | undefined =>
    id ? (workers.data?.find((w) => w.id === id)?.hostname ?? id.slice(0, 8)) : undefined;

  const endedAt = ticket.completedAt ?? (active ? Date.now() : ticket.updatedAt);
  const reason = terminalReason(ticket.terminalReason);

  return (
    <div className='detail-scroll'>
      <div className='detail-head'>
        <a className='back-link only-mobile' href={spaceHref(space.id, 'tickets')}>
          <Icon name='arrowLeft' size={13} /> Tickets
        </a>
        <div className='detail-head-row'>
          <div className='detail-head-text'>
            <h2>{ticket.title}</h2>
            <div className='detail-head-sub'>
              <span>
                Created <Time at={ticket.createdAt} />
              </span>
              <span className='faint'>·</span>
              <span>
                {attempt > 0 ? `Attempt ${attempt} of ${MAX_TICKET_ATTEMPTS}` : 'Not started yet'}
              </span>
            </div>
          </div>
          <div className='row'>
            <StatusBadge status={status} />
            <CopyButton text={ticket.id} label='' variant='ghost' size='sm' />
          </div>
        </div>
      </div>

      <div className='detail-body'>
        {ticket.status === 'manual_review' ? (
          <Callout
            tone='warn'
            title='Needs your decision'
            action={
              <div className='row'>
                <Button
                  size='sm'
                  variant='primary'
                  icon='retry'
                  disabled={attempt >= MAX_TICKET_ATTEMPTS}
                  loading={pendingKey === 'requeue'}
                  onClick={() => void act('requeue')}
                >
                  Retry
                </Button>
                <Button
                  size='sm'
                  icon='ban'
                  loading={pendingKey === 'abandon'}
                  onClick={() => void act('abandon')}
                >
                  Abandon
                </Button>
              </div>
            }
          >
            {reason ?? 'The run was interrupted and its outcome is unknown.'}.{' '}
            {attempt >= MAX_TICKET_ATTEMPTS
              ? 'No retries left; abandon it, or create a fresh ticket.'
              : 'Check the last attempt below to see how far it got before retrying.'}
          </Callout>
        ) : null}
        {ticket.status === 'failed' ? (
          <Callout tone='danger' title='Failed'>
            {reason ?? 'The agent could not finish this ticket.'}
          </Callout>
        ) : null}
        {ticket.status === 'cancelled' ? (
          <Callout tone='info' title='Cancelled'>
            {reason ?? 'Stopped before it finished.'}
          </Callout>
        ) : null}

        {ticket.result ? (
          <section className='card'>
            <div className='card-head'>
              <h3>Result</h3>
            </div>
            <div className='card-body stack'>
              <Markdown source={ticket.result.summary} />
              {ticket.result.branch || ticket.result.prUrl || ticket.result.commitSha ? (
                <div className='row-wrap'>
                  {ticket.result.prUrl ? (
                    <a
                      className='chip chip-link'
                      href={ticket.result.prUrl}
                      target='_blank'
                      rel='noreferrer noopener'
                    >
                      <Icon name='external' size={12} /> {hostOf(ticket.result.prUrl)}
                    </a>
                  ) : null}
                  {ticket.result.branch ? (
                    <Chip mono title='Branch'>
                      <Icon name='link' size={11} /> {ticket.result.branch}
                    </Chip>
                  ) : null}
                  {ticket.result.commitSha ? (
                    <Chip mono title='Commit'>
                      {ticket.result.commitSha.slice(0, 8)}
                    </Chip>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className='card'>
          <div className='card-head'>
            <h3>Task</h3>
          </div>
          <div className='card-body stack'>
            <Markdown source={ticket.objective} />
            {ticket.contextSummary ? (
              <div>
                <div className='kv-label'>Background</div>
                <Markdown source={ticket.contextSummary} />
              </div>
            ) : null}
            <dl className='kv'>
              <div>
                <dt>Status</dt>
                <dd>{status.label}</dd>
              </div>
              <div>
                <dt>Time {active ? 'so far' : 'taken'}</dt>
                <dd>{duration(Math.max(0, endedAt - ticket.createdAt))}</dd>
              </div>
              {ticket.assignedWorkerId ? (
                <div>
                  <dt>Worker</dt>
                  <dd>{workerName(ticket.assignedWorkerId)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Last update</dt>
                <dd title={absoluteTime(ticket.updatedAt)}>
                  <Time at={ticket.updatedAt} />
                </dd>
              </div>
              {ticket.originSessionId ? (
                <div>
                  <dt>Started from</dt>
                  <dd>
                    <a href={spaceHref(space.id, 'conversations', ticket.originSessionId)}>
                      A conversation
                    </a>
                  </dd>
                </div>
              ) : null}
              {ticket.requiredTags.length > 0 ? (
                <div>
                  <dt>Needs tags</dt>
                  <dd className='row-wrap'>
                    {ticket.requiredTags.map((t) => (
                      <Chip key={t} mono>
                        {t}
                      </Chip>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </section>

        <section>
          <div className='section-title'>
            <h2>Attempts</h2>
            <div className='row'>
              {CANCELLABLE_TICKET.has(ticket.status) ? (
                <Button
                  size='sm'
                  variant='danger'
                  icon='ban'
                  loading={pendingKey === 'cancel'}
                  onClick={() => void act('cancel')}
                >
                  Cancel ticket
                </Button>
              ) : null}
              <Button
                size='sm'
                icon='copy'
                onClick={() =>
                  onDuplicate({
                    title: ticket.title,
                    objective: ticket.objective,
                    contextSummary: ticket.contextSummary ?? '',
                    requiredTags: ticket.requiredTags,
                  })
                }
              >
                Run again
              </Button>
            </div>
          </div>
          {runs.error && !runs.data ? (
            <ErrorState message={runs.error} onRetry={() => void runs.refresh()} />
          ) : !runs.data ? (
            <ListSkeleton rows={2} />
          ) : runs.data.length === 0 ? (
            <div className='card card-pad muted'>
              {ticket.status === 'pending'
                ? 'Waiting for a worker to pick this up.'
                : 'No attempts recorded.'}
            </div>
          ) : (
            <div className='stack-sm'>
              {[...runs.data]
                .sort((a, b) => b.attempt - a.attempt)
                .map((attemptRun, index) => (
                  <AttemptCard
                    key={attemptRun.id}
                    run={attemptRun}
                    workerName={workerName(attemptRun.workerId)}
                    defaultOpen={index === 0}
                  />
                ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function AttemptCard({
  run,
  workerName,
  defaultOpen,
}: {
  run: TicketRun;
  workerName: string | undefined;
  defaultOpen: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const items = useMemo(() => (open ? buildTimeline(run.events) : []), [open, run.events]);
  const status = runStatus(run.status);
  const reason = terminalReason(run.terminalReason);
  const took =
    run.completedAt && run.startedAt ? duration(run.completedAt - run.startedAt) : undefined;
  return (
    <div className='card attempt'>
      <button
        type='button'
        className='attempt-head'
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <strong>Attempt {run.attempt}</strong>
        <StatusBadge status={status} size='sm' />
        <span className='attempt-meta'>
          {workerName ? <span>{workerName}</span> : null}
          {took ? <span>{took}</span> : null}
          {run.usage ? (
            <span>{compactNumber(run.usage.inputTokens + run.usage.outputTokens)} tokens</span>
          ) : null}
          <Time at={run.createdAt} />
        </span>
      </button>
      {reason && run.status === 'failed' ? <div className='attempt-reason'>{reason}</div> : null}
      {open ? (
        <div className='attempt-body'>
          {items.length === 0 ? (
            <div className='muted' style={{ padding: 16 }}>
              No events recorded for this attempt.
            </div>
          ) : (
            <Transcript items={items} />
          )}
        </div>
      ) : null}
    </div>
  );
}
