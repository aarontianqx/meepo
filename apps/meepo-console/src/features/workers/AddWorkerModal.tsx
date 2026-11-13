import type { Space, WorkerEnrollmentToken } from '@meepo/core';
import { useEffect, useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, setQueryData, useQuery } from '../../api/query';
import { useSpace } from '../../app/context';
import { reusableWorkers, type ReusableWorker } from '../../lib/workers';
import { workerStatus } from '../../lib/status';
import { Chip, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Checkbox, Field, Input, Radio, Segmented, Select } from '../../ui/Form';
import { Callout, CopyBox, ListSkeleton } from '../../ui/Misc';
import { Modal } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

const HOUR = 3_600_000;
const EXPIRY: Array<{ id: string; label: string; ms: number | undefined }> = [
  { id: 'never', label: 'Never expires (recommended for a long-running worker)', ms: undefined },
  { id: '1h', label: 'In 1 hour (one-time setup)', ms: HOUR },
  { id: '1d', label: 'In 1 day', ms: 24 * HOUR },
  { id: '7d', label: 'In 7 days', ms: 7 * 24 * HOUR },
  { id: '30d', label: 'In 30 days', ms: 30 * 24 * HOUR },
];

type Mode = 'existing' | 'new';

function workerCommand(token: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return [
    `MEEPO_SERVER_URL=${scheme}://${window.location.host}/ws/worker \\`,
    `MEEPO_ENROLLMENT_TOKEN=${token} \\`,
    'node apps/meepo-worker/dist/index.js',
  ].join('\n');
}

/**
 * Adds a worker to the space: either one the user already runs for other spaces (no restart
 * needed) or a new machine that joins with a fresh token.
 */
export function AddWorkerModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const space = useSpace();
  const mine = useQuery(keys.myEnrollments, api.listMyEnrollments);
  const workers = useQuery(keys.allWorkers, () => api.listWorkers());
  const [chosen, setChosen] = useState<Mode>();

  // Wait for both lists so the form does not switch under the user's hands.
  const loading = (!mine.data && !mine.error) || (!workers.data && !workers.error);
  if (loading)
    return (
      <Modal title='Add a worker' onClose={onClose}>
        <ListSkeleton rows={2} />
      </Modal>
    );

  const candidates = reusableWorkers(mine.data ?? [], workers.data ?? [], space.id, Date.now());
  const mode = chosen ?? (candidates.length > 0 ? 'existing' : 'new');
  const switcher =
    candidates.length > 0 ? (
      <Segmented
        label='Where the worker runs'
        value={mode}
        onChange={setChosen}
        options={[
          { value: 'existing', label: 'A worker I already run', count: candidates.length },
          { value: 'new', label: 'A new machine' },
        ]}
      />
    ) : null;

  return mode === 'existing' ? (
    <ExistingWorkerForm candidates={candidates} switcher={switcher} onClose={onClose} />
  ) : (
    <NewWorkerForm switcher={switcher} onClose={onClose} />
  );
}

/** Picks one of the user's running workers and lets it serve this space as well. */
function ExistingWorkerForm({
  candidates,
  switcher,
  onClose,
}: {
  candidates: ReusableWorker[];
  switcher: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const space = useSpace();
  const { run, pending } = useAction();
  const allSpaces = useQuery(keys.spaces, api.listSpaces);
  const [selected, setSelected] = useState(candidates[0]?.enrollment.id);

  const add = async (): Promise<void> => {
    if (!selected) return;
    const done = await run(() => api.addEnrollmentSpace(selected, space.id), {
      success: 'Worker added to this space',
    });
    if (!done) return;
    invalidate(keys.workers(space.id));
    invalidate(keys.allWorkers);
    invalidate(keys.enrollments(space.id));
    invalidate(keys.myEnrollments);
    // The first worker of a space becomes its primary, which changes the space itself.
    const fresh = await api.getSpace(space.id);
    setQueryData<Space[]>(keys.spaces, (list) =>
      (list ?? []).map((s) => (s.id === fresh.id ? fresh : s))
    );
    onClose();
  };

  return (
    <Modal
      title='Add a worker'
      description='A worker is a machine that runs the agent for this space.'
      onClose={onClose}
      locked={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending} disabled={!selected}>
            Add to this space
          </Button>
        </>
      }
    >
      {switcher}
      <div className='field'>
        <span className='field-label'>Workers you run</span>
        <div className='stack-sm'>
          {candidates.map(({ enrollment, worker }) => {
            const serving = worker.spaceIds
              .map((id) => allSpaces.data?.find((s) => s.id === id)?.name)
              .filter((name): name is string => name !== undefined);
            return (
              <Radio
                key={enrollment.id}
                name='worker'
                checked={selected === enrollment.id}
                onSelect={() => setSelected(enrollment.id)}
                label={
                  <span className='row-wrap'>
                    <span>{enrollment.label ?? worker.hostname}</span>
                    <StatusBadge status={workerStatus(worker.status)} size='sm' />
                    {worker.tags.map((tag) => (
                      <Chip key={tag} mono>
                        {tag}
                      </Chip>
                    ))}
                  </span>
                }
                hint={
                  serving.length > 0
                    ? `${enrollment.label ? `${worker.hostname} · ` : ''}Serves ${serving.join(', ')}`
                    : enrollment.label
                      ? worker.hostname
                      : undefined
                }
              />
            );
          })}
        </div>
      </div>
      <Callout tone='info' title='Spaces that share a worker share its machine'>
        They use the same files, credentials and tools on that host. It starts serving this space
        right away; nothing needs to be restarted.
      </Callout>
    </Modal>
  );
}

/** Two steps: issue a token, then show the one-time start command and wait for the worker. */
function NewWorkerForm({
  switcher,
  onClose,
}: {
  switcher: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const space = useSpace();
  const { run, pending } = useAction();
  const allSpaces = useQuery(keys.spaces, api.listSpaces);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('never');
  const [extra, setExtra] = useState<string[]>([]);
  const [issued, setIssued] = useState<WorkerEnrollmentToken>();

  const issue = async (): Promise<void> => {
    const ms = EXPIRY.find((e) => e.id === expiry)?.ms;
    const token = await run(
      () =>
        api.issueEnrollment({
          spaceIds: [space.id, ...extra],
          label: label.trim() || undefined,
          expiresAt: ms ? Date.now() + ms : undefined,
        }),
      { success: 'Token created' }
    );
    if (token) {
      setIssued(token);
      invalidate(keys.enrollments(space.id));
      invalidate(keys.myEnrollments);
    }
  };

  if (issued) return <Step2 token={issued} onClose={onClose} />;

  const others = (allSpaces.data ?? []).filter((s) => s.id !== space.id);
  return (
    <Modal
      title='Add a worker'
      description='A worker is a machine that runs the agent for this space. First create a token it will use to join.'
      onClose={onClose}
      locked={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void issue();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending}>
            Create token
          </Button>
        </>
      }
    >
      {switcher}
      <Field
        label='Name'
        optional
        hint='Helps you recognize it later, for example the machine’s role or owner.'
      >
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          data-autofocus
        />
      </Field>
      <Field
        label='Token validity'
        hint='An expired token also stops a connected worker from reconnecting.'
      >
        <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          {EXPIRY.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </Select>
      </Field>
      {others.length > 0 ? (
        <div className='field'>
          <span className='field-label'>Also let this worker serve</span>
          <div className='stack-sm'>
            {others.map((s) => (
              <Checkbox
                key={s.id}
                label={s.name}
                checked={extra.includes(s.id)}
                onChange={(on) =>
                  setExtra((cur) => (on ? [...cur, s.id] : cur.filter((id) => id !== s.id)))
                }
              />
            ))}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Step2({
  token,
  onClose,
}: {
  token: WorkerEnrollmentToken;
  onClose: () => void;
}): React.JSX.Element {
  const space = useSpace();
  const enrollments = useQuery(keys.enrollments(space.id), () => api.listEnrollments(space.id), {
    interval: 2_500,
  });
  const record = enrollments.data?.find((e) => e.id === token.id);
  const connected = Boolean(record?.workerId);
  const workers = useQuery(keys.workers(space.id), () => api.listWorkers(space.id), {
    interval: 2_500,
  });
  const worker = workers.data?.find((w) => w.id === record?.workerId);

  useEffect(() => {
    if (connected) invalidate(keys.workers(space.id));
  }, [connected, space.id]);

  return (
    <Modal
      title={connected ? 'Worker connected' : 'Start your worker'}
      onClose={onClose}
      wide
      footer={
        <Button variant='primary' onClick={onClose}>
          {connected ? 'Done' : 'Close'}
        </Button>
      }
    >
      {connected ? (
        <Callout
          tone='ok'
          title={worker ? `${worker.hostname} is online` : 'A worker used this token'}
        >
          It will pick up conversations and tickets for this space.
        </Callout>
      ) : (
        <>
          <p className='muted'>
            On the machine that should run the agent, build the worker and start it with this
            command. Run it from the Meepo checkout (the folder that contains{' '}
            <code>apps/meepo-worker</code>); it does not need to be inside any of your own
            repositories.
          </p>
          <CopyBox text={workerCommand(token.token)} multiline />
          <Callout tone='warn' title='Copy the token now'>
            For safety it is shown only once. If you lose it, create another token and revoke this
            one.
          </Callout>
          <div className='row waiting' role='status'>
            <span className='spinner' aria-hidden='true' />
            <span className='muted'>Waiting for the worker to connect…</span>
          </div>
        </>
      )}
    </Modal>
  );
}
