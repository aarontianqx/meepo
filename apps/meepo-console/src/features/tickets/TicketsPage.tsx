// Tickets: background tasks the agent works on by itself, with review and retry controls.

import type { Ticket } from '@meepo/core';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { useQuery } from '../../api/query';
import { useSpace } from '../../app/context';
import { navigate, spaceHref, type SectionProps } from '../../app/router';
import { MAX_TICKET_ATTEMPTS, ACTIVE_TICKET, ticketStatus } from '../../lib/status';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, SplitView, Time } from '../../ui/Misc';
import { NewTicketModal, type TicketDraft } from './NewTicketModal';
import { TicketDetail } from './TicketDetail';

type Filter = 'all' | 'active' | 'review' | 'completed' | 'failed';

const FILTERS: Array<{ id: Filter; label: string; match: (t: Ticket) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'active', label: 'Active', match: (t) => ACTIVE_TICKET.has(t.status) },
  { id: 'review', label: 'Review', match: (t) => t.status === 'manual_review' },
  { id: 'completed', label: 'Done', match: (t) => t.status === 'completed' },
  {
    id: 'failed',
    label: 'Failed',
    match: (t) => t.status === 'failed' || t.status === 'cancelled',
  },
];

function parseFilter(value: string | null): Filter {
  return FILTERS.some((f) => f.id === value) ? (value as Filter) : 'all';
}

export function TicketsPage({ item, query }: SectionProps): React.JSX.Element {
  const space = useSpace();
  const tickets = useQuery(keys.tickets(space.id), () => api.listTickets(space.id), {
    interval: 4_000,
  });
  const [filter, setFilter] = useState<Filter>(parseFilter(query.get('filter')));
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<TicketDraft | 'blank' | undefined>(
    query.get('new') ? 'blank' : undefined
  );

  // `?filter=` links (overview alerts) apply even when the page is already open.
  const filterParam = query.get('filter');
  useEffect(() => {
    if (filterParam) setFilter(parseFilter(filterParam));
  }, [filterParam]);

  // `?new=1` links (overview, empty states) open the dialog once and are then cleaned from the URL.
  useEffect(() => {
    if (!query.get('new')) return;
    setDraft('blank');
    navigate(spaceHref(space.id, 'tickets', item), { replace: true });
  }, [query, space.id, item]);

  const all = tickets.data;
  const selected = all?.find((t) => t.id === item);

  const counts = useMemo(() => {
    const result = {} as Record<Filter, number>;
    for (const f of FILTERS) result[f.id] = (all ?? []).filter(f.match).length;
    return result;
  }, [all]);

  const visible = useMemo(() => {
    const matcher = FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
    const needle = search.trim().toLowerCase();
    return (all ?? [])
      .filter(matcher)
      .filter((t) => !needle || `${t.title} ${t.objective}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [all, filter, search]);

  return (
    <div className='view'>
      <PageHeader
        title='Tickets'
        subtitle='Background tasks: hand the agent a goal, it works on it and reports back.'
        actions={
          <Button variant='primary' icon='plus' onClick={() => setDraft('blank')}>
            New ticket
          </Button>
        }
      />
      <SplitView
        detailOpen={Boolean(item)}
        listWidth={400}
        list={
          <>
            <div className='list-toolbar'>
              <div className='input-group'>
                <Icon name='search' size={14} />
                <input
                  className='input'
                  placeholder='Search tickets'
                  aria-label='Search tickets'
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className='pill-row' role='group' aria-label='Filter tickets'>
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type='button'
                    className={`pill ${f.id === 'review' && counts.review > 0 ? 'pill-warn' : ''}`}
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                    <span className='pill-count'>{counts[f.id]}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className='list-scroll'>
              {tickets.error && !all ? (
                <div style={{ padding: 14 }}>
                  <ErrorState message={tickets.error} onRetry={() => void tickets.refresh()} />
                </div>
              ) : !all ? (
                <ListSkeleton />
              ) : visible.length === 0 ? (
                <EmptyState
                  icon='tickets'
                  title={all.length === 0 ? 'No tickets yet' : 'Nothing matches'}
                  action={
                    all.length === 0 ? (
                      <Button variant='primary' icon='plus' onClick={() => setDraft('blank')}>
                        New ticket
                      </Button>
                    ) : undefined
                  }
                >
                  {all.length === 0
                    ? 'Tickets are tasks the agent works on in the background. Create one, or let the agent open them from chat.'
                    : 'Try another filter or search term.'}
                </EmptyState>
              ) : (
                visible.map((ticket) => (
                  <a
                    key={ticket.id}
                    className='list-row'
                    href={spaceHref(space.id, 'tickets', ticket.id)}
                    aria-current={ticket.id === item}
                  >
                    <div className='list-row-top'>
                      <span className='list-row-title truncate'>{ticket.title}</span>
                      <StatusBadge status={ticketStatus(ticket.status)} size='sm' />
                    </div>
                    <div className='list-row-meta'>
                      <Time at={ticket.updatedAt} />
                      {(ticket.attempt ?? 0) > 1 ? (
                        <span>
                          · attempt {ticket.attempt}/{MAX_TICKET_ATTEMPTS}
                        </span>
                      ) : null}
                    </div>
                  </a>
                ))
              )}
            </div>
          </>
        }
        detail={
          item ? (
            selected ? (
              <TicketDetail key={selected.id} ticket={selected} onDuplicate={(d) => setDraft(d)} />
            ) : all ? (
              <div className='detail-placeholder'>
                <EmptyState icon='ban' title='Ticket not found'>
                  It may belong to another space.
                </EmptyState>
              </div>
            ) : (
              <ListSkeleton />
            )
          ) : (
            <div className='detail-placeholder'>
              <EmptyState icon='tickets' title='Select a ticket'>
                Pick one on the left to see its result and attempts.
              </EmptyState>
            </div>
          )
        }
      />
      {draft ? (
        <NewTicketModal
          spaceId={space.id}
          initial={draft === 'blank' ? undefined : draft}
          onClose={() => setDraft(undefined)}
        />
      ) : null}
    </div>
  );
}
