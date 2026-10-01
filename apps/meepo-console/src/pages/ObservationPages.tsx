import { useEffect, useState, type ReactNode } from 'react';
import type { Session, Schedule, Ticket, Run } from '@meepo/core';
import type { CanonicalEvent } from '@meepo/protocol';
import { api, request } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { ErrorBanner, Section } from '../components/common';

export const enc = encodeURIComponent;
export function SpaceScope({ children }: { children: (spaceId: string) => ReactNode }) {
  const spaces = usePolling(api.listSpaces, 10000);
  const [selected, setSelected] = useState('');
  const id = spaces.data?.some((s) => s.id === selected) ? selected : spaces.data?.[0]?.id || '';
  return (
    <>
      <ErrorBanner error={spaces.error} />
      <label>
        Space{' '}
        <select value={id} onChange={(e) => setSelected(e.target.value)}>
          {spaces.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {id ? <div key={id}>{children(id)}</div> : <p>No spaces available. Create a space first.</p>}
    </>
  );
}
export function EventTrace({ events }: { events: CanonicalEvent[] }) {
  return (
    <div className='event-trace'>
      {events.map((e) => {
        const p = e.payload as {
          content?: string;
          toolName?: string;
          toolCallId?: string;
          author?: string;
          result?: unknown;
          args?: unknown;
        };
        return (
          <article key={`${e.runId ?? ''}:${e.seq}`} className={`event event-${e.type}`}>
            <header>
              <strong>{e.type}</strong> · #{e.seq} · {new Date(e.timestamp).toLocaleString()}
              {p.author ? ` · ${p.author}` : ''}
            </header>
            {p.content !== undefined ? (
              <pre>{p.content}</pre>
            ) : (
              <details open={['tool_call', 'tool_result'].includes(e.type)}>
                <summary>{p.toolName ?? p.toolCallId ?? 'Details'}</summary>
                <pre>{JSON.stringify(p, null, 2)}</pre>
              </details>
            )}
          </article>
        );
      })}
      {!events.length && <p className='muted'>No recorded events yet.</p>}
    </div>
  );
}
export function SessionsPage() {
  return (
    <>
      <h2>Sessions</h2>
      <SpaceScope>{(id) => <SessionList spaceId={id} />}</SpaceScope>
    </>
  );
}
function SessionList({ spaceId }: { spaceId: string }) {
  const sessions = usePolling(
    () => request<Session[]>('GET', `/api/sessions?spaceId=${enc(spaceId)}`),
    5000
  );
  const [selected, setSelected] = useState('');
  return (
    <>
      <ErrorBanner error={sessions.error} />
      <table>
        <thead>
          <tr>
            <th>Window</th>
            <th>Worker</th>
            <th>Status</th>
            <th>Last active</th>
          </tr>
        </thead>
        <tbody>
          {sessions.data?.map((s) => (
            <tr key={s.id}>
              <td>
                <button onClick={() => setSelected(s.id)}>
                  {s.kind} · {s.chatId} · {s.id.slice(0, 8)}
                </button>
              </td>
              <td>{s.boundWorkerId ?? 'Unbound'}</td>
              <td>{s.status}</td>
              <td>{new Date(s.lastActiveAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && <SessionDetail key={selected} id={selected} />}
    </>
  );
}
function SessionDetail({ id }: { id: string }) {
  const [events, setEvents] = useState<CanonicalEvent[]>([]),
    [error, setError] = useState<string | null>(null),
    [state, setState] = useState('Connecting');
  const [content, setContent] = useState(''),
    [busy, setBusy] = useState(false);
  const runs = usePolling(() => request<Run[]>('GET', `/api/sessions/${enc(id)}/runs`), 3000);
  useEffect(() => {
    let stopped = false,
      seq = 0;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const initial = await request<CanonicalEvent[]>(
          'GET',
          `/api/sessions/${enc(id)}/events?afterSeq=${seq}`
        );
        if (stopped) return;
        if (initial.length) {
          seq = initial.at(-1)!.seq;
          setEvents((old) => [...old, ...initial.filter((e) => !old.some((o) => o.seq === e.seq))]);
        }
        const { token } = await request<{ token: string }>(
          'POST',
          `/api/sessions/${enc(id)}/stream-token`
        );
        if (stopped) return;
        socket = new WebSocket(
          `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/console/${enc(token)}?afterSeq=${seq}`
        );
        socket.onopen = () => {
          setState('Live');
          setError(null);
        };
        socket.onmessage = (message) => {
          const event = JSON.parse(message.data as string) as CanonicalEvent;
          if (event.seq <= seq) return;
          seq = event.seq;
          setEvents((old) => [...old, event]);
        };
        socket.onclose = () => {
          if (!stopped) {
            setState('Reconnecting');
            timer = setTimeout(() => void connect(), 2000);
          }
        };
      } catch (e) {
        if (!stopped) {
          setError(String(e));
          setState('Retrying');
          timer = setTimeout(() => void connect(), 3000);
        }
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [id]);
  const send = async () => {
    setBusy(true);
    try {
      await request('POST', `/api/sessions/${enc(id)}/mailbox`, { content });
      setContent('');
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={`Transcript · ${state}`}>
      <ErrorBanner error={error ?? runs.error} />
      <p>
        <code>{id}</code>
      </p>
      <div className='run-list'>
        {runs.data?.map((r) => (
          <span className='tag' key={r.id}>
            {r.id.slice(0, 8)}: {r.status}
            {r.terminalReason ? ` (${r.terminalReason})` : ''}
            {['queued', 'dispatched', 'running'].includes(r.status) && (
              <button
                onClick={() => {
                  void request('POST', `/api/sessions/${enc(id)}/runs/${enc(r.id)}/abort`)
                    .then(() => runs.refresh())
                    .catch((e) => setError(String(e)));
                }}
              >
                Stop
              </button>
            )}
          </span>
        ))}
      </div>
      <EventTrace events={events} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label>
          Mailbox message
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            required
          />
        </label>
        <p className='muted'>
          Delivered after the current turn. The reply appears in this session’s chat window.
        </p>
        <button disabled={busy || !content.trim()}>Send message</button>
      </form>
    </Section>
  );
}
export function SchedulesPage() {
  return (
    <>
      <h2>Schedules</h2>
      <SpaceScope>{(id) => <Schedules spaceId={id} />}</SpaceScope>
    </>
  );
}
function Schedules({ spaceId }: { spaceId: string }) {
  const schedules = usePolling(
    () => request<Schedule[]>('GET', `/api/schedules?spaceId=${enc(spaceId)}`),
    5000
  );
  const sessions = usePolling(
    () => request<Session[]>('GET', `/api/sessions?spaceId=${enc(spaceId)}`),
    10000
  );
  const [error, setError] = useState<string | null>(null),
    [prompt, setPrompt] = useState(''),
    [sessionId, setSessionId] = useState(''),
    [timing, setTiming] = useState('at'),
    [when, setWhen] = useState(''),
    [timezone, setTimezone] = useState('Asia/Shanghai');
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      schedules.refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      <ErrorBanner error={error ?? schedules.error} />
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Timing</th>
            <th>Status</th>
            <th>Last fired</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {schedules.data?.map((s) => (
            <tr key={s.id}>
              <td>{s.action.kind === 'resume_session' ? s.action.prompt : s.action.objective}</td>
              <td>
                {s.timing.kind === 'at'
                  ? new Date(s.timing.at).toLocaleString()
                  : `${s.timing.expression} (${s.timing.timezone})`}
              </td>
              <td>{s.status}</td>
              <td>{s.lastFiredAt ? new Date(s.lastFiredAt).toLocaleString() : 'Never'}</td>
              <td>
                {s.status === 'active' && (
                  <button
                    onClick={() =>
                      void act(() => request('POST', `/api/schedules/${enc(s.id)}/cancel`))
                    }
                  >
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Section title='Create schedule'>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request('POST', '/api/schedules', {
                spaceId,
                timing:
                  timing === 'at'
                    ? { kind: 'at', at: new Date(when).getTime() }
                    : { kind: 'cron', expression: when, timezone },
                action: sessionId
                  ? { kind: 'resume_session', sessionId, prompt }
                  : { kind: 'create_ticket', objective: prompt, requiredTags: [] },
              });
              setPrompt('');
            });
          }}
        >
          <label>
            Action
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value=''>Create independent ticket</option>
              {sessions.data
                ?.filter((s) => s.status === 'active')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    Wake session {s.id.slice(0, 8)} ({s.kind})
                  </option>
                ))}
            </select>
          </label>
          <label>
            Timing
            <select
              value={timing}
              onChange={(e) => {
                setTiming(e.target.value);
                setWhen('');
              }}
            >
              <option value='at'>Once</option>
              <option value='cron'>Recurring cron</option>
            </select>
          </label>
          <label>
            {timing === 'at' ? 'Date and time' : 'Cron expression'}
            <input
              type={timing === 'at' ? 'datetime-local' : 'text'}
              required
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          {timing === 'cron' && (
            <label>
              Timezone
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </label>
          )}
          <label>
            Objective / wakeup message
            <textarea required value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <button>Create schedule</button>
        </form>
      </Section>
    </>
  );
}
interface TicketRun extends Run {
  events: CanonicalEvent[];
}
export function TicketDetail({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const ticket = usePolling(() => request<Ticket>('GET', `/api/tickets/${enc(id)}`), 3000);
  const runs = usePolling(() => request<TicketRun[]>('GET', `/api/tickets/${enc(id)}/runs`), 3000);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const action = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await request('POST', `/api/tickets/${enc(id)}/${name}`);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      ticket.refresh();
      runs.refresh();
      onChanged?.();
      setBusy(false);
    }
  };
  return (
    <Section title={ticket.data?.title ?? 'Ticket detail'}>
      <ErrorBanner error={error ?? ticket.error ?? runs.error} />
      <p>{ticket.data?.objective}</p>
      <p>
        Status: {ticket.data?.status} {ticket.data?.terminalReason}
      </p>
      {ticket.data?.status === 'manual_review' && (
        <>
          <p>Execution may have produced side effects. Check the trace before retrying.</p>
          <button disabled={busy} onClick={() => void action('requeue')}>
            Retry after review
          </button>
          <button disabled={busy} onClick={() => void action('abandon')}>
            Abandon
          </button>
        </>
      )}
      {['pending', 'claimed', 'running', 'manual_review'].includes(ticket.data?.status ?? '') && (
        <button disabled={busy} onClick={() => void action('cancel')}>
          Cancel ticket
        </button>
      )}
      {(ticket.data?.status === 'running' || ticket.data?.status === 'cancelled') && (
        <p className='muted'>
          Cancellation requests the worker to stop. Actions already performed are not undone.
        </p>
      )}
      {ticket.data?.result && <pre>{ticket.data.result.summary}</pre>}
      {runs.data?.map((run) => (
        <details key={run.id} open>
          <summary>
            Attempt {run.attempt} · {run.status} · {run.terminalReason} · {run.workerId}
          </summary>
          <p>
            Tokens: {run.usage?.inputTokens ?? 0} in / {run.usage?.outputTokens ?? 0} out
          </p>
          <EventTrace events={run.events} />
        </details>
      ))}
    </Section>
  );
}
