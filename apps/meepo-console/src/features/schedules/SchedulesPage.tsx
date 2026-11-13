// Schedules: recurring or one-off automation that creates tickets or resumes conversations.

import { useEffect, useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import type { ScheduleItem } from '../../api/types';
import { useSpace } from '../../app/context';
import { navigate, spaceHref, type SectionProps } from '../../app/router';
import { absoluteTime, oneLine } from '../../lib/format';
import { actionKindLabel, actionLabel, timingLabel } from '../../lib/schedule';
import { sessionName } from '../../lib/session';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import {
  EmptyState,
  ErrorState,
  ListSkeleton,
  Page,
  PageHeader,
  SectionTitle,
  Time,
} from '../../ui/Misc';
import { useConfirm } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';
import { NewScheduleModal } from './NewScheduleModal';

export function SchedulesPage({ query }: SectionProps): React.JSX.Element {
  const space = useSpace();
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();
  const schedules = useQuery(keys.schedules(space.id), () => api.listSchedules(space.id), {
    interval: 10_000,
  });
  const sessions = useQuery(keys.sessions(space.id), () => api.listSessions(space.id), {
    interval: 15_000,
  });
  const [creating, setCreating] = useState(Boolean(query.get('new')));

  useEffect(() => {
    if (!query.get('new')) return;
    setCreating(true);
    navigate(spaceHref(space.id, 'schedules'), { replace: true });
  }, [query, space.id]);

  const visible = (schedules.data ?? []).filter((s) => s.status !== 'deleted');
  const active = visible
    .filter((s) => s.status === 'active')
    .sort((a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity));
  const finished = visible
    .filter((s) => s.status === 'done')
    .sort((a, b) => (b.lastFiredAt ?? 0) - (a.lastFiredAt ?? 0));

  const cancel = async (schedule: ScheduleItem): Promise<void> => {
    const ok = await confirm({
      title: 'Cancel this schedule?',
      message: 'It will not fire again. Work it has already created is not affected.',
      confirmLabel: 'Cancel schedule',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.cancelSchedule(schedule.id), {
      success: 'Schedule cancelled',
      key: schedule.id,
    });
    if (done) invalidate(keys.schedules(space.id));
  };

  const sessionTitle = (id: string): string => {
    const found = sessions.data?.find((s) => s.id === id);
    return found ? sessionName(found) : 'a conversation';
  };

  const row = (schedule: ScheduleItem, canCancel: boolean): React.JSX.Element => (
    <li key={schedule.id} className='sched-row'>
      <span className='sched-icon'>
        <Icon name={schedule.timing.kind === 'cron' ? 'refresh' : 'clock'} size={16} />
      </span>
      <div className='sched-main'>
        <div className='sched-title'>{oneLine(actionLabel(schedule.action), 140)}</div>
        <div className='sched-sub'>
          <span>{timingLabel(schedule.timing)}</span>
          {schedule.timing.kind === 'cron' && schedule.timing.timezone ? (
            <span className='faint'>({schedule.timing.timezone})</span>
          ) : null}
          <span className='faint'>·</span>
          <span>
            {actionKindLabel(schedule.action)}
            {schedule.action.kind === 'resume_session' ? (
              <>
                {': '}
                <a href={spaceHref(space.id, 'conversations', schedule.action.sessionId)}>
                  {oneLine(sessionTitle(schedule.action.sessionId), 50)}
                </a>
              </>
            ) : null}
          </span>
        </div>
      </div>
      <div className='sched-when'>
        {schedule.status === 'active' && schedule.nextFireAt !== null ? (
          <Badge tone='info' icon='clock'>
            Next <Time at={schedule.nextFireAt} />
          </Badge>
        ) : (
          <Badge>Finished</Badge>
        )}
        {schedule.lastFiredAt ? (
          <span
            className='faint'
            style={{ fontSize: 12 }}
            title={absoluteTime(schedule.lastFiredAt)}
          >
            Last ran <Time at={schedule.lastFiredAt} />
          </span>
        ) : (
          <span className='faint' style={{ fontSize: 12 }}>
            Has not run yet
          </span>
        )}
      </div>
      {canCancel ? (
        <Button
          variant='ghost'
          size='sm'
          icon='x'
          aria-label='Cancel schedule'
          title='Cancel schedule'
          loading={pendingKey === schedule.id}
          onClick={() => void cancel(schedule)}
        />
      ) : null}
    </li>
  );

  return (
    <div className='view'>
      <PageHeader
        title='Schedules'
        subtitle='Make the agent act on its own: at a set time, or on a repeating rhythm.'
        actions={
          <Button variant='primary' icon='plus' onClick={() => setCreating(true)}>
            New schedule
          </Button>
        }
      />
      <Page>
        {schedules.error && !schedules.data ? (
          <ErrorState message={schedules.error} onRetry={() => void schedules.refresh()} />
        ) : !schedules.data ? (
          <ListSkeleton />
        ) : visible.length === 0 ? (
          <EmptyState
            icon='clock'
            title='Nothing scheduled'
            action={
              <Button variant='primary' icon='plus' onClick={() => setCreating(true)}>
                New schedule
              </Button>
            }
          >
            Have the agent start a task or continue a conversation on a recurring or one-time
            schedule.
          </EmptyState>
        ) : (
          <>
            <section>
              <SectionTitle>Active ({active.length})</SectionTitle>
              {active.length === 0 ? (
                <div className='card card-pad muted'>No active schedules.</div>
              ) : (
                <ul className='card sched-list'>{active.map((s) => row(s, true))}</ul>
              )}
            </section>
            {finished.length > 0 ? (
              <section>
                <SectionTitle>Finished ({finished.length})</SectionTitle>
                <ul className='card sched-list'>{finished.map((s) => row(s, false))}</ul>
              </section>
            ) : null}
          </>
        )}
      </Page>
      {creating ? (
        <NewScheduleModal
          onClose={() => setCreating(false)}
          sessions={(sessions.data ?? []).filter((s) => s.status !== 'closed')}
        />
      ) : null}
    </div>
  );
}
