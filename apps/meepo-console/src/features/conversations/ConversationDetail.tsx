// One conversation: header, live transcript, run controls and the console note composer.

import { useMemo, useState, type KeyboardEvent } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import type { SessionItem } from '../../api/types';
import { useSessionStream, type StreamState } from '../../api/stream';
import { useSpace } from '../../app/context';
import { spaceHref } from '../../app/router';
import { absoluteTime, compactNumber } from '../../lib/format';
import { sessionName, sessionWhere } from '../../lib/session';
import { ACTIVE_RUN, sessionStatus } from '../../lib/status';
import { Badge, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { ErrorState, ListSkeleton, CopyButton } from '../../ui/Misc';
import { useConfirm } from '../../ui/Modal';
import { Textarea } from '../../ui/Form';
import { useAction } from '../../ui/useAction';
import { useStickToBottom } from '../../ui/useStickToBottom';
import { buildTimeline } from '../transcript/model';
import { Transcript } from '../transcript/Transcript';

const NOTE_LIMIT = 32_000;

export function ConversationDetail({ session }: { session: SessionItem }): React.JSX.Element {
  const space = useSpace();
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();
  const stream = useSessionStream(session.id);
  const runs = useQuery(keys.sessionRuns(session.id), () => api.sessionRuns(session.id), {
    interval: 3_000,
  });

  const items = useMemo(() => buildTimeline(stream.events), [stream.events]);
  const activeRun = runs.data?.find((r) => ACTIVE_RUN.has(r.status));
  const { ref, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>(
    `${items.length}:${activeRun?.id ?? ''}`
  );

  const tokens = (runs.data ?? []).reduce(
    (sum, r) => sum + (r.usage ? r.usage.inputTokens + r.usage.outputTokens : 0),
    0
  );
  const closed = session.status === 'closed';

  const close = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Close this conversation?',
      message:
        'It stays readable here, but the agent stops taking part in it. The chat window starts a new conversation on its next message.',
      confirmLabel: 'Close conversation',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.closeSession(session.id), {
      success: 'Conversation closed',
      key: 'close',
    });
    if (done) invalidate(keys.sessions(space.id));
  };

  const stop = async (): Promise<void> => {
    if (!activeRun) return;
    await run(() => api.abortRun(session.id, activeRun.id), {
      success: 'Stop requested',
      key: 'stop',
    });
    invalidate(keys.sessionRuns(session.id));
  };

  return (
    <>
      <div className='detail-head'>
        <a className='back-link only-mobile' href={spaceHref(space.id, 'conversations')}>
          <Icon name='arrowLeft' size={13} /> Conversations
        </a>
        <div className='detail-head-row'>
          <div className='detail-head-text'>
            <h2 className='truncate' title={session.title}>
              {sessionName(session)}
            </h2>
            <div className='detail-head-sub'>
              <span>{sessionWhere(session)}</span>
              <span className='faint'>·</span>
              <span title={absoluteTime(session.createdAt)}>
                started{' '}
                {new Date(session.createdAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              {(runs.data?.length ?? 0) > 0 ? (
                <>
                  <span className='faint'>·</span>
                  <span>
                    {runs.data?.length} run{runs.data?.length === 1 ? '' : 's'}
                  </span>
                </>
              ) : null}
              {tokens > 0 ? (
                <>
                  <span className='faint'>·</span>
                  <span>{compactNumber(tokens)} tokens</span>
                </>
              ) : null}
            </div>
          </div>
          <div className='row'>
            <LiveBadge state={stream.state} closed={closed} />
            <StatusBadge status={sessionStatus(session.status)} />
            <CopyButton text={session.id} label='' variant='ghost' size='sm' />
            {!closed ? (
              <Button
                variant='ghost'
                size='sm'
                icon='ban'
                loading={pendingKey === 'close'}
                onClick={() => void close()}
              >
                Close
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className='transcript-wrap'>
        <div ref={ref} className='transcript-scroll'>
          {stream.state === 'error' && !stream.historyLoaded ? (
            <div style={{ padding: 20 }}>
              <ErrorState message={stream.error ?? 'Failed to load transcript'} />
            </div>
          ) : !stream.historyLoaded ? (
            <ListSkeleton rows={4} />
          ) : items.length === 0 ? (
            <div className='detail-placeholder'>
              <span className='muted'>No messages yet.</span>
            </div>
          ) : (
            <Transcript items={items} working={Boolean(activeRun)} />
          )}
        </div>
        {!atBottom ? (
          <button type='button' className='jump-latest' onClick={scrollToBottom}>
            <Icon name='arrowDown' size={14} /> Latest
          </button>
        ) : null}
      </div>

      {activeRun ? (
        <div className='run-bar'>
          <span className='dot dot-live tone-accent' style={{ color: 'var(--accent)' }} />
          <span>Agent is working{activeRun.status === 'dispatched' ? ' (starting)' : ''}</span>
          <span className='spacer' />
          <Button size='sm' icon='stop' loading={pendingKey === 'stop'} onClick={() => void stop()}>
            Stop
          </Button>
        </div>
      ) : null}

      <Composer sessionId={session.id} disabled={closed} busy={Boolean(activeRun)} />
    </>
  );
}

function LiveBadge({
  state,
  closed,
}: {
  state: StreamState;
  closed: boolean;
}): React.JSX.Element | null {
  if (closed) return null;
  if (state === 'live')
    return (
      <Badge tone='ok' size='sm'>
        <span className='dot dot-live' />
        Live
      </Badge>
    );
  if (state === 'loading') return null;
  return (
    <Badge tone='warn' size='sm'>
      {state === 'error' ? 'Offline' : 'Reconnecting'}
    </Badge>
  );
}

function Composer({
  sessionId,
  disabled,
  busy,
}: {
  sessionId: string;
  disabled: boolean;
  busy: boolean;
}): React.JSX.Element {
  const { run, pending } = useAction();
  const [text, setText] = useState('');
  const trimmed = text.trim();

  const send = async (): Promise<void> => {
    if (!trimmed || pending) return;
    const sent = await run(() => api.sendMailbox(sessionId, trimmed), { key: 'send' });
    if (sent === undefined) return;
    setText('');
    invalidate(keys.sessionRuns(sessionId));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  if (disabled)
    return (
      <div className='composer composer-closed'>
        <Icon name='ban' size={14} /> This conversation is closed.
      </div>
    );

  return (
    <form
      className='composer'
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        aria-label='Note to the agent'
        placeholder='Leave a note for the agent…'
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        value={text}
        maxLength={NOTE_LIMIT}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className='composer-foot'>
        <span className='faint'>
          {busy
            ? 'The agent is busy: your note is delivered after the current run, never interrupting it. '
            : 'The agent replies in the chat window; your note shows here as a console note. '}
          <kbd>⌘</kbd> <kbd>Enter</kbd> to send
        </span>
        <Button
          type='submit'
          variant='primary'
          size='sm'
          icon='send'
          loading={pending}
          disabled={!trimmed}
        >
          Send note
        </Button>
      </div>
    </form>
  );
}
