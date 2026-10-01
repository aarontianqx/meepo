import { MemoryEditor } from './MemoryPage';
import { request, getUserId } from '../api/client';
import { useEffect, useState } from 'react';

import type { Space, SpaceModelRef, WorkerEnrollmentToken } from '@meepo/core';

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
  const ownership = usePolling(() => api.listMembers(spaceId), 10000);
  const [operationError, setOperationError] = useState<string | null>(null);

  return (
    <div>
      <p>
        <button className='clickable' onClick={onBack}>
          &larr; Back to spaces
        </button>
      </p>
      <h2>{space.data?.name ?? 'Space'}</h2>
      <ErrorBanner error={space.error ?? operationError} />
      {space.data ? (
        <>
          <InfoSection space={space.data} />
          <UsageSection spaceId={spaceId} />
          <Section title='Prompt preset'>
            <select
              aria-label='Prompt preset'
              value={space.data.promptPreset ?? 'general'}
              onChange={(e) => {
                void request('PATCH', `/api/spaces/${spaceId}`, { promptPreset: e.target.value })
                  .then(space.refresh)
                  .catch((e) => setOperationError(String(e)));
              }}
            >
              <option value='general'>General purpose</option>
              <option value='coding'>Coding (isolated git worktree)</option>
            </select>
            <p className='muted'>
              Applies to new sessions. Existing session identity and presets stay frozen.
            </p>
          </Section>
          <ModelSection space={space.data} onChanged={space.refresh} />
          <MembersSection spaceId={spaceId} />
          <WorkerBindingSection space={space.data} onChanged={space.refresh} />
          <ChatsSection space={space.data} onChanged={space.refresh} />
          <Section title='Memory'>
            <MemoryEditor spaceId={spaceId} />
          </Section>
          <EnrollmentSection spaceId={spaceId} />
          <WebhookSection spaceId={spaceId} />
          {ownership.data?.some((m) => m.userId === getUserId() && m.role === 'owner') && (
            <button
              className='danger'
              onClick={() => {
                if (confirm('Delete this space and stop its work?'))
                  void request('DELETE', `/api/spaces/${spaceId}`)
                    .then(onBack)
                    .catch((e) => setOperationError(String(e)));
              }}
            >
              Delete space
            </button>
          )}
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

const THINKING_LEVELS = ['low', 'high', 'max'] as const;

function ModelSection({
  space,
  onChanged,
}: {
  space: Space;
  onChanged: () => void;
}): React.JSX.Element {
  const models = usePolling(() => api.listModels(), 10_000);
  const [modelId, setModelId] = useState(space.model?.modelId ?? '');
  const [thinkingLevel, setThinkingLevel] = useState(space.model?.thinkingLevel ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirty =
    modelId !== (space.model?.modelId ?? '') ||
    thinkingLevel !== (space.model?.thinkingLevel ?? '');

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const model: SpaceModelRef | undefined = modelId
        ? {
            modelId,
            ...(thinkingLevel
              ? { thinkingLevel: thinkingLevel as SpaceModelRef['thinkingLevel'] }
              : {}),
          }
        : undefined;
      await api.updateSpaceModel(space.id, model);
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save model');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title='Model'>
      <ErrorBanner error={models.error ?? error} />
      <div className='row-inline'>
        <select
          value={modelId}
          onChange={(e) => {
            setModelId(e.target.value);
            setSaved(false);
          }}
        >
          <option value=''>Inherit server default</option>
          {(models.data ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id} ({entry.provider}){entry.isDefault ? ' — default' : ''}
            </option>
          ))}
        </select>
        <select
          value={thinkingLevel}
          onChange={(e) => {
            setThinkingLevel(e.target.value);
            setSaved(false);
          }}
          disabled={!modelId}
        >
          <option value=''>Thinking: default</option>
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              Thinking: {level}
            </option>
          ))}
        </select>
        <button className='primary' onClick={() => void save()} disabled={busy || !dirty}>
          Save
        </button>
        {saved ? <span className='muted'>Saved.</span> : null}
      </div>
      {modelId && !(models.data ?? []).some((entry) => entry.id === modelId) ? (
        <p className='muted'>Current model &quot;{modelId}&quot; is not in the registry.</p>
      ) : null}
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
              <td>
                {members.data?.some((m) => m.userId === getUserId() && m.role === 'owner') &&
                  member.role !== 'owner' && (
                    <>
                      <button
                        onClick={() => {
                          if (confirm(`Remove ${member.userId}?`))
                            void request(
                              'DELETE',
                              `/api/spaces/${spaceId}/members/${encodeURIComponent(member.userId)}`
                            )
                              .then(members.refresh)
                              .catch((e) => setError(String(e)));
                        }}
                      >
                        Remove
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Transfer ownership to ${member.userId}?`))
                            void request('POST', `/api/spaces/${spaceId}/owner`, {
                              userId: member.userId,
                            })
                              .then(members.refresh)
                              .catch((e) => setError(String(e)));
                        }}
                      >
                        Make owner
                      </button>
                    </>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={(event) => void add(event)} style={{ marginTop: 12 }}>
        <div className='row-inline'>
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder='user id to add as operator'
            required
          />
          <button type='submit' disabled={busy}>
            Add operator
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

function ChatsSection({ space }: { space: Space; onChanged: () => void }): React.JSX.Element {
  const channels = usePolling(
    () =>
      request<{ id: string; name: string; boundChatIds: string[] }[]>(
        'GET',
        `/api/spaces/${space.id}/channels`
      ),
    5000
  );
  const [channelId, setChannelId] = useState(''),
    [chatId, setChatId] = useState(''),
    [error, setError] = useState<string | null>(null);
  const selected = channels.data?.find((c) => c.id === channelId) ?? channels.data?.[0];
  const save = async (chatIds: string[]) => {
    if (!selected) return;
    try {
      await request('PUT', `/api/spaces/${space.id}/channels/${selected.id}/chats`, { chatIds });
      channels.refresh();
      setError(null);
      setChatId('');
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Section title='Bound chats'>
      <ErrorBanner error={error ?? channels.error} />
      <label>
        Channel{' '}
        <select value={selected?.id ?? ''} onChange={(e) => setChannelId(e.target.value)}>
          {channels.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {!selected ? (
        <p>No channel registered for this space.</p>
      ) : (
        <>
          <ul>
            {selected.boundChatIds.map((id) => (
              <li key={id}>
                <code>{id}</code>{' '}
                <button onClick={() => void save(selected.boundChatIds.filter((c) => c !== id))}>
                  Unbind
                </button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save([...selected.boundChatIds, chatId.trim()]);
            }}
          >
            <label>
              Chat ID
              <input
                required
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder='oc_…'
              />
            </label>
            <button>Bind chat</button>
          </form>
        </>
      )}
    </Section>
  );
}

function EnrollmentSection({ spaceId }: { spaceId: string }): React.JSX.Element {
  const tokens = usePolling(
    () =>
      request<Omit<WorkerEnrollmentToken, 'token'>[]>(
        'GET',
        `/api/enrollments?spaceId=${encodeURIComponent(spaceId)}`
      ),
    5000
  );
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
      <ErrorBanner error={tokens.error} />
      <table>
        <thead>
          <tr>
            <th>Label / ID</th>
            <th>Worker</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tokens.data?.map((t) => (
            <tr key={t.id}>
              <td>{t.label ?? t.id}</td>
              <td>{t.workerId ?? 'Unbound'}</td>
              <td>
                {t.revokedAt
                  ? 'Revoked'
                  : t.expiresAt && t.expiresAt < Date.now()
                    ? 'Expired'
                    : 'Active'}
              </td>
              <td>
                {!t.revokedAt && (
                  <button
                    onClick={() => {
                      void request('POST', `/api/enrollments/${encodeURIComponent(t.id)}/revoke`)
                        .then(tokens.refresh)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

function WebhookSection({ spaceId }: { spaceId: string }) {
  const [token, setToken] = useState(''),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const act = async (rotate: boolean) => {
    setBusy(true);
    try {
      if (rotate) {
        const result = await request<{ token: string }>(
          'POST',
          `/api/spaces/${encodeURIComponent(spaceId)}/webhook-token`
        );
        setToken(result.token);
      } else {
        await request('DELETE', `/api/spaces/${encodeURIComponent(spaceId)}/webhook-token`);
        setToken('');
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title='Inbound webhook'>
      <ErrorBanner error={error} />
      <p>
        POST /api/webhooks/{spaceId}/tickets with a Bearer token. Issuing a token replaces the
        previous one.
      </p>
      <button
        disabled={busy}
        onClick={() => {
          if (confirm('Issue a new webhook token and invalidate the previous one?')) void act(true);
        }}
      >
        Issue / rotate token
      </button>
      <button
        disabled={busy}
        onClick={() => {
          if (confirm('Revoke webhook access for this space?')) void act(false);
        }}
      >
        Revoke token
      </button>
      {token && (
        <div className='token-box'>
          <p>Shown once. Save this token now.</p>
          <code>{token}</code>
        </div>
      )}
    </Section>
  );
}

function UsageSection({ spaceId }: { spaceId: string }): React.JSX.Element {
  const usage = usePolling(
    () =>
      request<{
        runCount: number;
        reportedRunCount: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        costReportedRunCount: number;
      }>('GET', `/api/spaces/${spaceId}/usage`),
    10000
  );
  return (
    <Section title='Model usage'>
      <ErrorBanner error={usage.error} />
      {usage.data && (
        <>
          <p>
            Input: {usage.data.inputTokens.toLocaleString()} tokens · Output:{' '}
            {usage.data.outputTokens.toLocaleString()} tokens
          </p>
          <p className='muted'>
            Provider reports available for {usage.data.reportedRunCount} of {usage.data.runCount}{' '}
            runs. Cumulative across sessions and ticket attempts.
          </p>
          {usage.data.costReportedRunCount > 0 && (
            <p>
              Reported cost: ${usage.data.costUsd.toFixed(4)} ({usage.data.costReportedRunCount}{' '}
              runs)
            </p>
          )}
        </>
      )}
    </Section>
  );
}
