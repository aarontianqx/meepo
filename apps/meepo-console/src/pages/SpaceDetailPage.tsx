import { useEffect, useState } from 'react';

import type { Space, WorkerEnrollmentToken } from '@meepo/core';

import { api } from '../api/client';
import { ErrorBanner, Section } from '../components/common';
import { usePolling } from '../hooks/usePolling';
import { relativeTime } from '../util';

interface SpaceDetailPageProps {
  spaceId: string;
  onBack: () => void;
}

export function SpaceDetailPage({ spaceId, onBack }: SpaceDetailPageProps): React.JSX.Element {
  const space = usePolling(() => api.getSpace(spaceId), 10_000);

  return (
    <div>
      <p>
        <button className='clickable' onClick={onBack}>
          &larr; Back to spaces
        </button>
      </p>
      <h2>{space.data?.name ?? 'Space'}</h2>
      <ErrorBanner error={space.error} />
      {space.data ? (
        <>
          <InfoSection space={space.data} />
          <MembersSection spaceId={spaceId} />
          <WorkerBindingSection space={space.data} onChanged={space.refresh} />
          <ChatsSection space={space.data} onChanged={space.refresh} />
          <MemorySection space={space.data} onChanged={space.refresh} />
          <EnrollmentSection spaceId={spaceId} />
        </>
      ) : null}
    </div>
  );
}

function InfoSection({ space }: { space: Space }): React.JSX.Element {
  return (
    <Section title='Overview'>
      <dl className='info-list'>
        <dt>ID</dt>
        <dd>
          <code>{space.id}</code>
        </dd>
        <dt>Repo</dt>
        <dd>
          <code>{space.repoUrl}</code> ({space.defaultBranch})
        </dd>
        <dt>Timezone</dt>
        <dd>{space.timezone}</dd>
        <dt>Required tags</dt>
        <dd>
          {space.requiredTags.length > 0 ? (
            space.requiredTags.map((tag) => (
              <span key={tag} className='tag'>
                {tag}
              </span>
            ))
          ) : (
            <span className='muted'>none</span>
          )}
        </dd>
        {space.description ? (
          <>
            <dt>Description</dt>
            <dd>{space.description}</dd>
          </>
        ) : null}
      </dl>
    </Section>
  );
}

function MembersSection({ spaceId }: { spaceId: string }): React.JSX.Element {
  const members = usePolling(() => api.listMembers(spaceId), 10_000);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addMember(spaceId, userId.trim());
      setUserId('');
      members.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add member');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title='Members'>
      <ErrorBanner error={members.error ?? error} />
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {(members.data ?? []).map((member) => (
            <tr key={member.userId}>
              <td>
                <code>{member.userId}</code>
              </td>
              <td>{member.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={(event) => void add(event)} style={{ marginTop: 12 }}>
        <div className='row-inline'>
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder='user id to add as manager'
            required
          />
          <button type='submit' disabled={busy}>
            Add manager
          </button>
        </div>
      </form>
    </Section>
  );
}

function WorkerBindingSection({
  space,
  onChanged,
}: {
  space: Space;
  onChanged: () => void;
}): React.JSX.Element {
  const workers = usePolling(() => api.listWorkers(space.id), 10_000);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selected && workers.data && workers.data.length > 0) {
      setSelected(workers.data[0].id);
    }
  }, [workers.data, selected]);

  const bind = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.switchBinding(space.id, selected);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to switch binding');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title='Worker binding'>
      <ErrorBanner error={workers.error ?? error} />
      <p>
        Bound worker:{' '}
        {space.boundWorkerId ? (
          <code>{space.boundWorkerId}</code>
        ) : (
          <span className='muted'>unbound</span>
        )}
      </p>
      {workers.data && workers.data.length > 0 ? (
        <div className='row-inline'>
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {workers.data.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.id} — {worker.hostname} ({worker.status}, slots {worker.activeSlots}/
                {worker.maxSlots}, heartbeat {relativeTime(worker.lastHeartbeatAt)})
              </option>
            ))}
          </select>
          <button
            onClick={() => void bind()}
            disabled={busy || !selected || selected === space.boundWorkerId}
          >
            Switch binding
          </button>
        </div>
      ) : (
        <p className='muted'>
          No enrolled workers for this space. Issue an enrollment token below.
        </p>
      )}
    </Section>
  );
}

function ChatsSection({
  space,
  onChanged,
}: {
  space: Space;
  onChanged: () => void;
}): React.JSX.Element {
  const [chatId, setChatId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'chat operation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title='Bound chats'>
      <ErrorBanner error={error} />
      {space.boundChatIds.length === 0 ? <p className='muted'>No chats bound.</p> : null}
      <ul>
        {space.boundChatIds.map((id) => (
          <li key={id}>
            <code>{id}</code>{' '}
            <button
              className='danger'
              disabled={busy}
              onClick={() => void run(() => api.unbindChat(space.id, id))}
            >
              Unbind
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api.bindChat(space.id, chatId.trim());
            setChatId('');
          });
        }}
      >
        <div className='row-inline'>
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder='Feishu chat id (oc_...)'
            required
          />
          <button type='submit' disabled={busy}>
            Bind chat
          </button>
        </div>
      </form>
    </Section>
  );
}

function MemorySection({
  space,
  onChanged,
}: {
  space: Space;
  onChanged: () => void;
}): React.JSX.Element {
  const [memory, setMemory] = useState(space.longTermMemory);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateMemory(space.id, memory);
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save memory');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title='Long-term memory'>
      <ErrorBanner error={error} />
      <textarea
        value={memory}
        onChange={(e) => {
          setMemory(e.target.value);
          setSaved(false);
        }}
        rows={8}
      />
      <div className='form-actions' style={{ marginTop: 8 }}>
        <button
          className='primary'
          onClick={() => void save()}
          disabled={busy || memory === space.longTermMemory}
        >
          Save memory
        </button>
        {saved ? <span className='muted'>Saved.</span> : null}
      </div>
    </Section>
  );
}

function EnrollmentSection({ spaceId }: { spaceId: string }): React.JSX.Element {
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<WorkerEnrollmentToken | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const token = await api.issueEnrollment({
        spaceIds: [spaceId],
        label: label.trim() || undefined,
      });
      setIssued(token);
      setLabel('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to issue enrollment');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Section title='Worker enrollment'>
      <ErrorBanner error={error} />
      <form onSubmit={(event) => void issue(event)}>
        <div className='row-inline'>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='label (optional, e.g. ci-runner-01)'
          />
          <button type='submit' disabled={busy}>
            Issue token
          </button>
        </div>
      </form>
      {issued ? (
        <div className='token-box' style={{ marginTop: 12 }}>
          <p style={{ marginTop: 0 }}>
            <strong>Token issued{issued.label ? ` (${issued.label})` : ''}</strong> — shown once,
            store it now:
          </p>
          <code>{issued.token}</code>
          <div className='form-actions' style={{ marginTop: 8 }}>
            <button onClick={() => void copy()}>Copy token</button>
            {copied ? <span className='muted'>Copied to clipboard.</span> : null}
          </div>
        </div>
      ) : null}
    </Section>
  );
}
