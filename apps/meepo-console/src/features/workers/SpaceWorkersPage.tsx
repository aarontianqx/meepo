// Space workers: who runs the agent, which one hosts conversations, and how workers join.

import type { Space } from '@meepo/core';
import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, setQueryData, useQuery } from '../../api/query';
import type { EnrollmentRecord } from '../../api/types';
import { useSpace } from '../../app/context';
import { absoluteTime } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
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
import { AddWorkerModal } from './AddWorkerModal';
import { WorkerRow } from './WorkerRow';

export function SpaceWorkersPage(): React.JSX.Element {
  const space = useSpace();
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();
  const workers = useQuery(keys.workers(space.id), () => api.listWorkers(space.id), {
    interval: 5_000,
  });
  const spaces = useQuery(keys.spaces, api.listSpaces);
  const enrollments = useQuery(keys.enrollments(space.id), () => api.listEnrollments(space.id), {
    interval: 10_000,
  });
  const [adding, setAdding] = useState(false);

  const list = workers.data;

  const makePrimary = async (id: string, hostname: string): Promise<void> => {
    const ok = await confirm({
      title: `Make ${hostname} the primary worker?`,
      message:
        'Ongoing private and group conversations move to it, interrupting any run in progress. Thread conversations stay with the worker they started on.',
      confirmLabel: 'Make primary',
    });
    if (!ok) return;
    const updated = await run(() => api.switchBinding(space.id, id), {
      success: `${hostname} is now primary`,
      key: id,
    });
    if (updated)
      setQueryData<Space[]>(keys.spaces, (cur) =>
        (cur ?? []).map((s) => (s.id === updated.id ? updated : s))
      );
  };

  const revoke = async (record: EnrollmentRecord): Promise<void> => {
    const ok = await confirm({
      title: 'Revoke this token?',
      message: record.workerId
        ? 'The worker that uses it can no longer connect. A worker that is connected now stays online until it disconnects.'
        : 'Nobody will be able to join with it.',
      confirmLabel: 'Revoke token',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.revokeEnrollment(record.id), {
      success: 'Token revoked',
      key: record.id,
    });
    if (done) invalidate(keys.enrollments(space.id));
  };

  return (
    <div className='view'>
      <PageHeader
        title='Workers'
        subtitle='Machines that run the agent for this space.'
        actions={
          <Button variant='primary' icon='plus' onClick={() => setAdding(true)}>
            Add worker
          </Button>
        }
      />
      <Page>
        {workers.error && !list ? (
          <ErrorState message={workers.error} onRetry={() => void workers.refresh()} />
        ) : !list ? (
          <ListSkeleton rows={3} />
        ) : list.length === 0 ? (
          <EmptyState
            icon='server'
            title='No worker connected'
            action={
              <Button variant='primary' icon='plus' onClick={() => setAdding(true)}>
                Add your first worker
              </Button>
            }
          >
            The agent needs a machine to run on. Create a token, start a worker with it, and it
            appears here within seconds.
          </EmptyState>
        ) : (
          <section>
            <SectionTitle>Connected workers ({list.length})</SectionTitle>
            <ul className='card worker-list'>
              {[...list]
                .sort(
                  (a, b) =>
                    Number(b.id === space.boundWorkerId) - Number(a.id === space.boundWorkerId) ||
                    a.hostname.localeCompare(b.hostname)
                )
                .map((worker) => (
                  <WorkerRow
                    key={worker.id}
                    worker={worker}
                    spaces={spaces.data ?? []}
                    label={enrollments.data?.find((e) => e.workerId === worker.id)?.label}
                    badge={
                      worker.id === space.boundWorkerId ? (
                        <Badge
                          tone='accent'
                          size='sm'
                          title='Hosts this space’s ongoing conversations'
                        >
                          Primary
                        </Badge>
                      ) : undefined
                    }
                    actions={
                      worker.id !== space.boundWorkerId ? (
                        <Button
                          size='sm'
                          loading={pendingKey === worker.id}
                          onClick={() => void makePrimary(worker.id, worker.hostname)}
                        >
                          Make primary
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
            </ul>
            <p className='hint-text'>
              The <strong>primary</strong> worker hosts ongoing conversations. Tickets can run on
              any online worker that has the tags they require.
            </p>
          </section>
        )}

        <section>
          <SectionTitle>Join tokens</SectionTitle>
          {!enrollments.data ? (
            <ListSkeleton rows={2} />
          ) : enrollments.data.length === 0 ? (
            <div className='card card-pad muted'>No tokens issued yet.</div>
          ) : (
            <div className='card table-wrap'>
              <table className='table'>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>State</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th aria-label='Actions' />
                  </tr>
                </thead>
                <tbody>
                  {[...enrollments.data]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((record) => {
                      const state = tokenState(record);
                      return (
                        <tr key={record.id}>
                          <td>
                            <div>{record.label || <span className='faint'>Unnamed</span>}</div>
                            <div className='faint' style={{ fontSize: 12 }}>
                              by {record.issuedByUserId}
                              {record.spaceIds.length > 1
                                ? ` · ${record.spaceIds.length} spaces`
                                : ''}
                            </div>
                          </td>
                          <td>
                            <Badge tone={state.tone} size='sm'>
                              {state.label}
                            </Badge>
                          </td>
                          <td title={absoluteTime(record.createdAt)}>
                            <Time at={record.createdAt} />
                          </td>
                          <td>
                            {record.lastUsedAt ? (
                              <Time at={record.lastUsedAt} />
                            ) : (
                              <span className='faint'>Never</span>
                            )}
                          </td>
                          <td className='num'>
                            {!record.revokedAt ? (
                              <Button
                                size='sm'
                                variant='ghost'
                                loading={pendingKey === record.id}
                                onClick={() => void revoke(record)}
                              >
                                Revoke
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </Page>
      {adding ? <AddWorkerModal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function tokenState(record: EnrollmentRecord): {
  label: string;
  tone: 'ok' | 'neutral' | 'warn' | 'info';
} {
  if (record.revokedAt) return { label: 'Revoked', tone: 'neutral' };
  if (record.expiresAt && record.expiresAt <= Date.now()) return { label: 'Expired', tone: 'warn' };
  if (record.workerId) return { label: 'In use', tone: 'ok' };
  return { label: 'Waiting for a worker', tone: 'info' };
}
