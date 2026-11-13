// Space landing page: what needs attention, what is running, and how to get set up.

import type { Space, Ticket, WorkerNode } from '@meepo/core';
import type { ReactNode } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { useQuery } from '../../api/query';
import type { ScheduleItem, SessionItem, SpaceUsage } from '../../api/types';
import { useSpace } from '../../app/context';
import { spaceHref } from '../../app/router';
import { compactNumber, oneLine } from '../../lib/format';
import { actionLabel, timingLabel } from '../../lib/schedule';
import { sessionName, sessionWhere } from '../../lib/session';
import { ACTIVE_TICKET, sessionStatus, ticketStatus } from '../../lib/status';
import { Badge, StatusBadge, StatusDot } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { EmptyState, Page, PageHeader, SectionTitle, Skeleton, Time } from '../../ui/Misc';

const DAY_MS = 24 * 60 * 60 * 1000;

export function OverviewPage(): React.JSX.Element {
  const space = useSpace();
  const tickets = useQuery(keys.tickets(space.id), () => api.listTickets(space.id), {
    interval: 5_000,
  });
  const sessions = useQuery(keys.sessions(space.id), () => api.listSessions(space.id), {
    interval: 5_000,
  });
  const workers = useQuery(keys.workers(space.id), () => api.listWorkers(space.id), {
    interval: 10_000,
  });
  const schedules = useQuery(keys.schedules(space.id), () => api.listSchedules(space.id), {
    interval: 15_000,
  });
  const usage = useQuery(keys.usage(space.id), () => api.spaceUsage(space.id), {
    interval: 30_000,
  });

  const loaded = tickets.data && sessions.data && workers.data;
  return (
    <div className='view'>
      <PageHeader
        title={space.name}
        subtitle={space.description || 'Space overview'}
        actions={
          <Button
            icon='plus'
            onClick={() =>
              (window.location.hash = spaceHref(space.id, 'tickets', undefined, { new: '1' }))
            }
          >
            New ticket
          </Button>
        }
      />
      <Page>
        {loaded ? (
          <>
            <SetupChecklist
              space={space}
              tickets={tickets.data!}
              sessions={sessions.data!}
              workers={workers.data!}
            />
            <Attention space={space} tickets={tickets.data!} workers={workers.data!} />
            <Stats
              tickets={tickets.data!}
              sessions={sessions.data!}
              workers={workers.data!}
              usage={usage.data}
            />
            <div className='grid-2 grid-2-wide'>
              <RecentConversations space={space} sessions={sessions.data!} />
              <RecentTickets space={space} tickets={tickets.data!} />
            </div>
            <UpcomingSchedules space={space} schedules={schedules.data} />
          </>
        ) : (
          <OverviewSkeleton />
        )}
      </Page>
    </div>
  );
}

function OverviewSkeleton(): React.JSX.Element {
  return (
    <>
      <div className='stat-grid'>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className='card card-pad stack-sm'>
            <Skeleton width={80} height={11} />
            <Skeleton width={56} height={26} />
            <Skeleton width={110} height={11} />
          </div>
        ))}
      </div>
      <div className='card card-pad'>
        <Skeleton height={120} />
      </div>
    </>
  );
}

// ---------- Setup ----------

interface Step {
  done: boolean;
  title: string;
  detail: string;
  action: { label: string; href: string };
}

function SetupChecklist({
  space,
  tickets,
  sessions,
  workers,
}: {
  space: Space;
  tickets: Ticket[];
  sessions: SessionItem[];
  workers: WorkerNode[];
}): React.JSX.Element | null {
  const steps: Step[] = [
    {
      done: workers.length > 0,
      title: 'Connect a worker',
      detail:
        'Workers are the machines where the agent actually runs. Create an enrollment token and start one.',
      action: { label: 'Add a worker', href: spaceHref(space.id, 'workers') },
    },
    {
      done: space.boundChatIds.length > 0,
      title: 'Connect a chat',
      detail: 'Bind a Feishu group so teammates can talk to the agent where they already work.',
      action: { label: 'Connect chat', href: spaceHref(space.id, 'settings', 'chats') },
    },
    {
      done: sessions.length > 0 || tickets.length > 0,
      title: 'Give it a first task',
      detail: 'Say hello in the bound chat, or hand the agent a background task as a ticket.',
      action: {
        label: 'Create a ticket',
        href: spaceHref(space.id, 'tickets', undefined, { new: '1' }),
      },
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  const nextIndex = steps.findIndex((s) => !s.done);

  return (
    <section className='card'>
      <div className='card-head'>
        <h2>Get started</h2>
        <span className='muted' style={{ fontSize: 12.5 }}>
          {doneCount} of {steps.length} done
        </span>
        <div
          className='progress'
          role='progressbar'
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={doneCount}
        >
          <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
      </div>
      <ol className='steps'>
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={`step ${step.done ? 'step-done' : ''} ${index === nextIndex ? 'step-next' : ''}`}
          >
            <span className='step-mark'>
              {step.done ? <Icon name='check' size={13} strokeWidth={2.6} /> : index + 1}
            </span>
            <div className='step-text'>
              <div className='step-title'>{step.title}</div>
              {!step.done ? <div className='muted step-detail'>{step.detail}</div> : null}
            </div>
            {!step.done ? (
              <a
                className={`btn btn-sm ${index === nextIndex ? 'btn-primary' : ''}`}
                href={step.action.href}
              >
                {step.action.label}
              </a>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- Attention ----------

function Attention({
  space,
  tickets,
  workers,
}: {
  space: Space;
  tickets: Ticket[];
  workers: WorkerNode[];
}): React.JSX.Element | null {
  const items: Array<{
    key: string;
    tone: 'warn' | 'danger';
    icon: IconName;
    text: ReactNode;
    href: string;
    cta: string;
  }> = [];

  const review = tickets.filter((t) => t.status === 'manual_review').length;
  if (review > 0)
    items.push({
      key: 'review',
      tone: 'warn',
      icon: 'eye',
      text: (
        <>
          <strong>{review}</strong> {review === 1 ? 'ticket needs' : 'tickets need'} your review.
          The outcome of an interrupted run is unknown.
        </>
      ),
      href: spaceHref(space.id, 'tickets', undefined, { filter: 'review' }),
      cta: 'Review',
    });

  const recentFailures = tickets.filter(
    (t) => t.status === 'failed' && Date.now() - t.updatedAt < DAY_MS
  ).length;
  if (recentFailures > 0)
    items.push({
      key: 'failed',
      tone: 'danger',
      icon: 'xCircle',
      text: (
        <>
          <strong>{recentFailures}</strong> {recentFailures === 1 ? 'ticket' : 'tickets'} failed in
          the last 24 hours.
        </>
      ),
      href: spaceHref(space.id, 'tickets', undefined, { filter: 'failed' }),
      cta: 'See failures',
    });

  if (workers.length > 0 && !workers.some((w) => w.status !== 'offline'))
    items.push({
      key: 'offline',
      tone: 'danger',
      icon: 'server',
      text: <>No worker is online. Conversations and tickets will wait until one reconnects.</>,
      href: spaceHref(space.id, 'workers'),
      cta: 'Open workers',
    });

  const queuedLong = tickets.filter(
    (t) => t.status === 'pending' && Date.now() - t.pendingSince > 10 * 60_000
  ).length;
  if (queuedLong > 0 && workers.some((w) => w.status !== 'offline'))
    items.push({
      key: 'queued',
      tone: 'warn',
      icon: 'clock',
      text: (
        <>
          <strong>{queuedLong}</strong> {queuedLong === 1 ? 'ticket has' : 'tickets have'} waited
          over 10 minutes. Check that a worker carries the required tags.
        </>
      ),
      href: spaceHref(space.id, 'tickets', undefined, { filter: 'active' }),
      cta: 'View queue',
    });

  if (items.length === 0) return null;
  return (
    <section className='stack-sm' aria-label='Needs attention'>
      {items.map((item) => (
        <div key={item.key} className={`attention attention-${item.tone}`}>
          <Icon name={item.icon} size={16} />
          <div className='attention-text'>{item.text}</div>
          <a className='btn btn-sm' href={item.href}>
            {item.cta}
          </a>
        </div>
      ))}
    </section>
  );
}

// ---------- Stats ----------

function Stats({
  tickets,
  sessions,
  workers,
  usage,
}: {
  tickets: Ticket[];
  sessions: SessionItem[];
  workers: WorkerNode[];
  usage: SpaceUsage | undefined;
}): React.JSX.Element {
  const running = tickets.filter((t) => ACTIVE_TICKET.has(t.status));
  const queued = running.filter((t) => t.status === 'pending').length;
  const openSessions = sessions.filter((s) => s.status !== 'closed');
  const activeNow = sessions.filter((s) => s.status === 'active').length;
  const online = workers.filter((w) => w.status !== 'offline').length;
  const slotsUsed = workers.reduce((sum, w) => sum + w.activeSlots, 0);
  const slotsMax = workers
    .filter((w) => w.status !== 'offline')
    .reduce((sum, w) => sum + w.maxSlots, 0);

  return (
    <div className='stat-grid'>
      <Stat
        label='Tickets in progress'
        value={String(running.length)}
        sub={queued > 0 ? `${queued} waiting in queue` : 'Nothing waiting'}
      />
      <Stat
        label='Open conversations'
        value={String(openSessions.length)}
        sub={activeNow > 0 ? `${activeNow} active now` : 'All quiet'}
      />
      <Stat
        label='Workers online'
        value={`${online}/${workers.length}`}
        sub={workers.length === 0 ? 'None connected' : `${slotsUsed} of ${slotsMax} slots busy`}
        tone={workers.length > 0 && online === 0 ? 'danger' : undefined}
      />
      <Stat
        label='Agent runs'
        value={usage ? compactNumber(usage.runCount) : '–'}
        sub={
          usage
            ? usage.inputTokens + usage.outputTokens > 0
              ? `${compactNumber(usage.inputTokens)} in · ${compactNumber(usage.outputTokens)} out tokens${usage.costReportedRunCount > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ''}`
              : 'No usage reported yet'
            : 'Loading usage'
        }
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'danger';
}): React.JSX.Element {
  return (
    <div className='card card-pad stat'>
      <div className='stat-label'>{label}</div>
      <div className={`stat-value tabular ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</div>
      <div className='stat-sub'>{sub}</div>
    </div>
  );
}

// ---------- Lists ----------

function RecentConversations({
  space,
  sessions,
}: {
  space: Space;
  sessions: SessionItem[];
}): React.JSX.Element {
  const recent = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 5);
  return (
    <section className='card'>
      <div className='card-head'>
        <h2>Recent conversations</h2>
        <a href={spaceHref(space.id, 'conversations')} className='card-head-link'>
          View all
        </a>
      </div>
      {recent.length === 0 ? (
        <EmptyState icon='message' title='No conversations yet'>
          Conversations appear here as soon as someone talks to the agent in a bound chat.
        </EmptyState>
      ) : (
        <ul className='mini-list'>
          {recent.map((session) => (
            <li key={session.id}>
              <a className='mini-row' href={spaceHref(space.id, 'conversations', session.id)}>
                <StatusDot status={sessionStatus(session.status)} />
                <span className='mini-main'>
                  <span className='mini-title truncate'>{oneLine(sessionName(session), 90)}</span>
                  <span className='mini-sub truncate'>{sessionWhere(session)}</span>
                </span>
                <span className='faint mini-time'>
                  <Time at={session.lastActiveAt} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentTickets({ space, tickets }: { space: Space; tickets: Ticket[] }): React.JSX.Element {
  const recent = [...tickets].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  return (
    <section className='card'>
      <div className='card-head'>
        <h2>Recent tickets</h2>
        <a href={spaceHref(space.id, 'tickets')} className='card-head-link'>
          View all
        </a>
      </div>
      {recent.length === 0 ? (
        <EmptyState icon='tickets' title='No tickets yet'>
          Tickets are background tasks the agent works on by itself and reports back.
        </EmptyState>
      ) : (
        <ul className='mini-list'>
          {recent.map((ticket) => (
            <li key={ticket.id}>
              <a className='mini-row' href={spaceHref(space.id, 'tickets', ticket.id)}>
                <span className='mini-main'>
                  <span className='mini-title truncate'>{ticket.title}</span>
                  <span className='mini-sub'>
                    <Time at={ticket.updatedAt} />
                  </span>
                </span>
                <StatusBadge status={ticketStatus(ticket.status)} size='sm' />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UpcomingSchedules({
  space,
  schedules,
}: {
  space: Space;
  schedules: ScheduleItem[] | undefined;
}): React.JSX.Element | null {
  const active = (schedules ?? [])
    .filter((s) => s.status === 'active' && s.nextFireAt !== null)
    .sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0))
    .slice(0, 4);
  if (active.length === 0) return null;
  return (
    <section>
      <SectionTitle
        action={
          <a href={spaceHref(space.id, 'schedules')} className='card-head-link'>
            Manage
          </a>
        }
      >
        Coming up
      </SectionTitle>
      <div className='card'>
        <ul className='mini-list'>
          {active.map((schedule) => (
            <li key={schedule.id}>
              <a className='mini-row' href={spaceHref(space.id, 'schedules')}>
                <Icon name='clock' size={15} />
                <span className='mini-main'>
                  <span className='mini-title truncate'>
                    {oneLine(actionLabel(schedule.action), 100)}
                  </span>
                  <span className='mini-sub'>{timingLabel(schedule.timing)}</span>
                </span>
                <Badge tone='info' size='sm'>
                  {schedule.nextFireAt !== null ? <Time at={schedule.nextFireAt} /> : null}
                </Badge>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
