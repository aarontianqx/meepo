import { useState } from 'react';

import type { Ticket } from '@meepo/core';

import { api } from '../api/client';
import { ErrorBanner, Section } from '../components/common';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime, nonEmpty, parseTags } from '../util';

const ALL_SPACES = '';

export function TicketsPage(): React.JSX.Element {
  const spaces = usePolling(() => api.listSpaces(), 10_000);
  const [spaceFilter, setSpaceFilter] = useState(ALL_SPACES);
  const tickets = usePolling(
    () => api.listTickets(spaceFilter === ALL_SPACES ? undefined : spaceFilter),
    10_000
  );

  return (
    <div>
      <h2>Tickets</h2>
      <ErrorBanner error={tickets.error ?? spaces.error} />
      <Section title={`Tickets (${tickets.data?.length ?? 0})`}>
        <div className='row-inline' style={{ marginBottom: 12 }}>
          <select value={spaceFilter} onChange={(e) => setSpaceFilter(e.target.value)}>
            <option value={ALL_SPACES}>All spaces</option>
            {(spaces.data ?? []).map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </select>
        </div>
        {tickets.data?.length === 0 ? <p className='muted'>No tickets.</p> : null}
        {tickets.data && tickets.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Space</th>
                <th>Status</th>
                <th>Assigned worker</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tickets.data.map((ticket) => (
                <tr key={ticket.id}>
                  <td>
                    {ticket.title}
                    <div className='muted'>{ticket.objective}</div>
                  </td>
                  <td>
                    <code>{ticket.spaceId}</code>
                  </td>
                  <td>
                    <TicketStatus status={ticket.status} />
                  </td>
                  <td>
                    {ticket.assignedWorkerId ? (
                      <code>{ticket.assignedWorkerId}</code>
                    ) : (
                      <span className='muted'>—</span>
                    )}
                  </td>
                  <td>{formatDateTime(ticket.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
      <CreateTicketForm
        spaces={(spaces.data ?? []).map((space) => ({ id: space.id, name: space.name }))}
        onCreated={() => tickets.refresh()}
      />
    </div>
  );
}

const TICKET_STATUS_CLASS: Record<Ticket['status'], string> = {
  pending: 'status-offline',
  claimed: 'status-busy',
  running: 'status-busy',
  completed: 'status-online',
  failed: 'status-offline',
};

function TicketStatus({ status }: { status: Ticket['status'] }): React.JSX.Element {
  return <span className={`status-pill ${TICKET_STATUS_CLASS[status]}`}>{status}</span>;
}

function CreateTicketForm({
  spaces,
  onCreated,
}: {
  spaces: Array<{ id: string; name: string }>;
  onCreated: () => void;
}): React.JSX.Element {
  const [spaceId, setSpaceId] = useState('');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [contextSummary, setContextSummary] = useState('');
  const [requiredTags, setRequiredTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSpaceId = spaceId || spaces[0]?.id || '';

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTicket({
        spaceId: effectiveSpaceId,
        title: title.trim(),
        objective: objective.trim(),
        contextSummary: nonEmpty(contextSummary),
        requiredTags: parseTags(requiredTags),
      });
      setTitle('');
      setObjective('');
      setContextSummary('');
      setRequiredTags('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create ticket');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title='Create ticket'>
      {spaces.length === 0 ? (
        <p className='muted'>Create a space first.</p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <div className='form-grid'>
            <label>
              <span>Space *</span>
              <select value={effectiveSpaceId} onChange={(e) => setSpaceId(e.target.value)}>
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Title *</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              <span>Required tags (comma separated)</span>
              <input value={requiredTags} onChange={(e) => setRequiredTags(e.target.value)} />
            </label>
            <label>
              <span>Context summary</span>
              <input value={contextSummary} onChange={(e) => setContextSummary(e.target.value)} />
            </label>
          </div>
          <label>
            <span>Objective *</span>
            <textarea value={objective} onChange={(e) => setObjective(e.target.value)} required />
          </label>
          <ErrorBanner error={error} />
          <div className='form-actions'>
            <button className='primary' type='submit' disabled={busy}>
              Create ticket
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}
