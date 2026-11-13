// Renders a session or ticket-run event stream as a readable conversation log.

import { useState } from 'react';

import { clockTime, dayKey, dayLabel, duration } from '../../lib/format';
import { Avatar } from '../../ui/Badge';
import { Icon } from '../../ui/Icon';
import { Markdown } from '../../ui/Markdown';
import { argsSummary, type TimelineItem, type ToolItem } from './model';

type Block =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'item'; item: Exclude<TimelineItem, { kind: 'tool' }> }
  | { kind: 'tools'; key: string; tools: Array<{ key: string; tool: ToolItem }> };

/** Inserts day separators and merges consecutive tool calls into one group. */
function toBlocks(items: TimelineItem[]): Block[] {
  const blocks: Block[] = [];
  let lastDay: string | undefined;
  for (const item of items) {
    const day = dayKey(item.at);
    if (day !== lastDay) {
      blocks.push({ kind: 'day', key: `day-${item.key}`, label: dayLabel(item.at) });
      lastDay = day;
    }
    if (item.kind === 'tool') {
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === 'tools') previous.tools.push({ key: item.key, tool: item.tool });
      else
        blocks.push({
          kind: 'tools',
          key: `tools-${item.key}`,
          tools: [{ key: item.key, tool: item.tool }],
        });
    } else {
      blocks.push({ kind: 'item', item });
    }
  }
  return blocks;
}

export function Transcript({
  items,
  working,
}: {
  items: TimelineItem[];
  /** Show the "agent is working" indicator after the last item. */
  working?: boolean;
}): React.JSX.Element {
  const blocks = toBlocks(items);
  return (
    <div className='transcript'>
      {blocks.map((block) => {
        if (block.kind === 'day')
          return (
            <div key={block.key} className='day-sep'>
              <span>{block.label}</span>
            </div>
          );
        if (block.kind === 'tools') return <ToolGroup key={block.key} tools={block.tools} />;
        return <Entry key={block.item.key} item={block.item} />;
      })}
      {working ? (
        <div className='msg'>
          <span className='agent-mark' aria-hidden='true'>
            <Icon name='bot' size={13} strokeWidth={2.2} />
          </span>
          <div className='msg-body'>
            <span className='typing' role='status' aria-label='Agent is working'>
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Entry({ item }: { item: Exclude<TimelineItem, { kind: 'tool' }> }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <div className='msg'>
          <Avatar name={item.author || 'User'} size='sm' round />
          <div className='msg-body'>
            <div className='msg-meta'>
              <strong>{item.author || 'User'}</strong>
              <span className='faint'>{clockTime(item.at)}</span>
            </div>
            {item.quote ? (
              <blockquote className='msg-quote'>
                <div className='msg-quote-from'>Replying to {item.quote.sender}</div>
                <div className='msg-quote-body'>{item.quote.body}</div>
              </blockquote>
            ) : null}
            <div className='msg-user-text'>{item.content}</div>
            {item.imageCount > 0 ? (
              <div className='msg-attach'>
                <Icon name='file' size={13} /> {item.imageCount} image
                {item.imageCount === 1 ? '' : 's'} attached
              </div>
            ) : null}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className='msg'>
          <span className='agent-mark' aria-hidden='true'>
            <Icon name='bot' size={13} strokeWidth={2.2} />
          </span>
          <div className='msg-body'>
            <div className='msg-meta'>
              <strong>Agent</strong>
              <span className='faint'>{clockTime(item.at)}</span>
            </div>
            <Markdown source={item.content} />
          </div>
        </div>
      );
    case 'note':
      return (
        <div className='msg-note'>
          <Icon name='note' size={14} />
          <div>
            <div className='msg-note-from'>
              {item.from ? `Console note from ${item.from}` : 'System note'}
              <span className='faint'> · {clockTime(item.at)}</span>
            </div>
            <div className='msg-note-text'>{item.content}</div>
          </div>
        </div>
      );
    case 'setup':
      return (
        <details className='setup-row'>
          <summary>
            <Icon name='sparkles' size={13} /> Session started with the space prompt
            <span className='faint'> · {clockTime(item.at)}</span>
          </summary>
          <pre>{item.prompt}</pre>
        </details>
      );
    case 'run':
      return (
        <div className={`run-line run-${item.outcome}`}>
          <Icon
            name={
              item.outcome === 'failed'
                ? 'xCircle'
                : item.outcome === 'completed'
                  ? 'checkCircle'
                  : 'play'
            }
            size={13}
          />
          <span>
            {item.outcome === 'started'
              ? 'Run started'
              : item.outcome === 'completed'
                ? 'Run completed'
                : `Run failed${item.text ? `: ${item.text}` : ''}`}
          </span>
          <span className='faint'>{clockTime(item.at)}</span>
        </div>
      );
  }
}

const COLLAPSED_TOOL_COUNT = 3;

function ToolGroup({
  tools,
}: {
  tools: Array<{ key: string; tool: ToolItem }>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hidden = expanded ? 0 : Math.max(0, tools.length - COLLAPSED_TOOL_COUNT);
  const visible = hidden > 0 ? tools.slice(-COLLAPSED_TOOL_COUNT) : tools;
  return (
    <div className='tool-group'>
      {hidden > 0 ? (
        <button type='button' className='tool-more' onClick={() => setExpanded(true)}>
          Show {hidden} earlier tool call{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
      {visible.map(({ key, tool }) => (
        <ToolRow key={key} tool={tool} />
      ))}
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const summary = argsSummary(tool.args);
  const status = tool.result ? (tool.result.isError ? 'error' : 'ok') : 'running';
  const icon =
    tool.name.toLowerCase().includes('bash') || tool.name.toLowerCase().includes('shell')
      ? 'terminal'
      : 'wrench';
  return (
    <div className={`tool tool-${status}`}>
      <button
        type='button'
        className='tool-head'
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={icon} size={13} />
        <span className='tool-name'>{tool.name}</span>
        <span className='tool-args truncate'>{summary}</span>
        <span className='tool-state'>
          {status === 'running' ? (
            <span className='spinner spinner-sm' aria-label='Running' />
          ) : status === 'error' ? (
            <Icon name='xCircle' size={14} />
          ) : (
            <Icon name='check' size={14} strokeWidth={2.4} />
          )}
          {tool.durationMs !== undefined ? (
            <span className='faint'>{duration(tool.durationMs)}</span>
          ) : null}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
      </button>
      {open ? (
        <div className='tool-detail'>
          <div className='tool-label'>Arguments</div>
          <pre>
            {typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2)}
          </pre>
          {tool.result ? (
            <>
              <div className='tool-label'>{tool.result.isError ? 'Error' : 'Result'}</div>
              <pre className={tool.result.isError ? 'tool-error' : ''}>
                {tool.result.text || '(empty)'}
              </pre>
            </>
          ) : (
            <div className='tool-label'>Waiting for result…</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
