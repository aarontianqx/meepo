// Conversations: every chat window the agent is part of, with its live transcript.

import { useMemo, useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { useQuery } from '../../api/query';
import type { SessionItem } from '../../api/types';
import { useSpace } from '../../app/context';
import { spaceHref, type SectionProps } from '../../app/router';
import { oneLine } from '../../lib/format';
import { sessionName, sessionWhere } from '../../lib/session';
import { FLAVOR_LABEL, sessionFlavor, sessionStatus, type SessionFlavor } from '../../lib/status';
import { StatusDot } from '../../ui/Badge';
import { Segmented, Select } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, SplitView, Time } from '../../ui/Misc';
import { ConversationDetail } from './ConversationDetail';

type Scope = 'open' | 'closed';

export function ConversationsPage({ item }: SectionProps): React.JSX.Element {
  const space = useSpace();
  const sessions = useQuery(keys.sessions(space.id), () => api.listSessions(space.id), {
    interval: 4_000,
  });
  const [chosenScope, setScope] = useState<Scope>();
  const [flavor, setFlavor] = useState<SessionFlavor | 'all'>('all');
  const [search, setSearch] = useState('');

  const all = sessions.data;
  const selected = all?.find((s) => s.id === item);
  // A deep-linked closed conversation opens the Closed list unless the user picked a tab.
  const scope: Scope = chosenScope ?? (selected?.status === 'closed' ? 'closed' : 'open');

  const counts = useMemo(
    () => ({
      open: all?.filter((s) => s.status !== 'closed').length ?? 0,
      closed: all?.filter((s) => s.status === 'closed').length ?? 0,
    }),
    [all]
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (all ?? [])
      .filter((s) => (scope === 'open' ? s.status !== 'closed' : s.status === 'closed'))
      .filter((s) => flavor === 'all' || sessionFlavor(s) === flavor)
      .filter(
        (s) =>
          !needle ||
          `${sessionName(s)} ${sessionWhere(s)} ${s.author ?? ''}`.toLowerCase().includes(needle)
      )
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [all, scope, flavor, search]);

  return (
    <div className='view'>
      <PageHeader
        title='Conversations'
        subtitle='Chats where teammates work with the agent. Read along live, or leave a note.'
      />
      <SplitView
        detailOpen={Boolean(item)}
        listWidth={348}
        list={
          <>
            <div className='list-toolbar'>
              <div className='input-group'>
                <Icon name='search' size={14} />
                <input
                  className='input'
                  placeholder='Search conversations'
                  aria-label='Search conversations'
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className='row'>
                <Segmented
                  label='Conversation state'
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: 'open', label: 'Open', count: counts.open },
                    { value: 'closed', label: 'Closed', count: counts.closed },
                  ]}
                />
                <span className='spacer' />
                <Select
                  aria-label='Source'
                  value={flavor}
                  onChange={(e) => setFlavor(e.target.value as SessionFlavor | 'all')}
                  style={{ width: 'auto' }}
                >
                  <option value='all'>All sources</option>
                  {(Object.keys(FLAVOR_LABEL) as SessionFlavor[]).map((f) => (
                    <option key={f} value={f}>
                      {FLAVOR_LABEL[f]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className='list-scroll'>
              {sessions.error && !all ? (
                <div style={{ padding: 14 }}>
                  <ErrorState message={sessions.error} onRetry={() => void sessions.refresh()} />
                </div>
              ) : !all ? (
                <ListSkeleton />
              ) : visible.length === 0 ? (
                <EmptyState
                  icon='message'
                  title={
                    counts.open + counts.closed === 0 ? 'No conversations yet' : 'Nothing matches'
                  }
                >
                  {counts.open + counts.closed === 0
                    ? 'A conversation starts when someone messages the agent in a connected chat.'
                    : 'Try another filter or search term.'}
                </EmptyState>
              ) : (
                visible.map((session) => (
                  <ConversationRow
                    key={session.id}
                    session={session}
                    spaceId={space.id}
                    selected={session.id === item}
                  />
                ))
              )}
            </div>
          </>
        }
        detail={
          item ? (
            selected ? (
              <ConversationDetail key={selected.id} session={selected} />
            ) : all ? (
              <div className='detail-placeholder'>
                <EmptyState icon='ban' title='Conversation not found'>
                  It may belong to another space or was removed.
                </EmptyState>
              </div>
            ) : (
              <ListSkeleton />
            )
          ) : (
            <div className='detail-placeholder'>
              <EmptyState icon='message' title='Select a conversation'>
                Pick one on the left to read the transcript.
              </EmptyState>
            </div>
          )
        }
      />
    </div>
  );
}

function ConversationRow({
  session,
  spaceId,
  selected,
}: {
  session: SessionItem;
  spaceId: string;
  selected: boolean;
}): React.JSX.Element {
  const status = sessionStatus(session.status);
  return (
    <a
      className='list-row'
      href={spaceHref(spaceId, 'conversations', session.id)}
      aria-current={selected}
    >
      <div className='list-row-top'>
        <span className='list-row-title truncate'>{oneLine(sessionName(session), 100)}</span>
        <StatusDot status={status} />
      </div>
      <div className='list-row-meta'>
        <span className='truncate'>{sessionWhere(session)}</span>
        <span className='spacer' />
        <Time at={session.lastActiveAt} />
      </div>
    </a>
  );
}
