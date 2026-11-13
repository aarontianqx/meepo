import { Fragment, type ReactNode } from 'react';

import { CopyButton } from './Misc';

/**
 * Small, dependency-free Markdown renderer for assistant text and memory previews.
 * It builds React elements directly (never raw HTML) and only links http(s)/mailto URLs,
 * so untrusted model output cannot inject markup or script URLs.
 */

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | {
      t: 'table';
      head: string[];
      align: Array<'left' | 'right' | 'center' | undefined>;
      rows: string[][];
    };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function Markdown({ source }: { source: string }): React.JSX.Element {
  return <div className='md'>{renderBlocks(parseBlocks(source))}</div>;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence (or end of input for an unterminated block)
      blocks.push({ t: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', text: body.join('\n') });
      continue;
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined;
      });
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i++]));
      }
      blocks.push({ t: 'table', head, align, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const baseIndent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const start = ordered ? parseInt(item[2], 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        const match = LIST_ITEM.exec(next);
        if (match && match[1].length <= baseIndent) {
          if (match[1].length < baseIndent || /\d/.test(match[2]) !== ordered) break;
          items.push(match[3]);
          i++;
          continue;
        }
        if (next.trim() === '') {
          // A blank line continues the list only if an indented line follows.
          const after = lines[i + 1];
          if (after !== undefined && after.length - after.trimStart().length > baseIndent) {
            items[items.length - 1] += '\n';
            i++;
            continue;
          }
          break;
        }
        const indent = next.length - next.trimStart().length;
        if (indent > baseIndent) {
          items[items.length - 1] += `\n${next.slice(Math.min(indent, baseIndent + 2))}`;
          i++;
          continue;
        }
        if (!match && !/^\s{0,3}(#|>|```|~~~)/.test(next)) {
          // Lazy continuation of the previous item's paragraph.
          items[items.length - 1] += `\n${next.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ t: 'list', ordered, start, items });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i], lines[i + 1])) {
      paragraph.push(lines[i++]);
    }
    if (paragraph.length === 0) paragraph.push(lines[i++]);
    blocks.push({ t: 'p', text: paragraph.join('\n') });
  }
  return blocks;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-'))
  );
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderBlocks(blocks: Block[], keyPrefix = 'b'): ReactNode {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}${index}`;
    switch (block.t) {
      case 'p':
        return <p key={key}>{renderInline(block.text, key)}</p>;
      case 'h': {
        const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
        return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
      }
      case 'hr':
        return <hr key={key} />;
      case 'quote':
        return (
          <blockquote key={key}>{renderBlocks(parseBlocks(block.text), `${key}q`)}</blockquote>
        );
      case 'code':
        return (
          <div key={key} className='md-code'>
            <div className='md-code-bar'>
              <span>{block.lang || 'text'}</span>
              <CopyButton text={block.text} variant='ghost' />
            </div>
            <pre>
              <code>{block.text}</code>
            </pre>
          </div>
        );
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag key={key} start={block.ordered && block.start !== 1 ? block.start : undefined}>
            {block.items.map((item, itemIndex) => {
              const inner = parseBlocks(item);
              const itemKey = `${key}i${itemIndex}`;
              // Tight list items render their paragraph inline to avoid extra spacing.
              if (inner.length === 1 && inner[0].t === 'p') {
                return <li key={itemKey}>{renderInline(inner[0].text, itemKey)}</li>;
              }
              if (inner.length > 0 && inner[0].t === 'p') {
                const [first, ...rest] = inner;
                return (
                  <li key={itemKey}>
                    {renderInline(first.t === 'p' ? first.text : '', itemKey)}
                    {renderBlocks(rest, `${itemKey}r`)}
                  </li>
                );
              }
              return <li key={itemKey}>{renderBlocks(inner, `${itemKey}r`)}</li>;
            })}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={key} className='md-table'>
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, c) => (
                    <th key={c} style={{ textAlign: block.align[c] }}>
                      {renderInline(cell, `${key}h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {block.head.map((_, c) => (
                      <td key={c} style={{ textAlign: block.align[c] }}>
                        {renderInline(row[c] ?? '', `${key}r${r}c${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

// Groups: 1-2 code span, 3/4 bold, 5 strike, 6/7 emphasis, 8-9 [text](url), 10 bare URL.
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|(?<![A-Za-z0-9])_([^\s_][\s\S]*?)_(?![A-Za-z0-9])|\[([^\]]+)\]\(([^\s)]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url);
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const pushText = (value: string): void => {
    if (!value) return;
    const parts = value.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) out.push(<br key={`${keyPrefix}-br${n++}`} />);
      if (part) out.push(<Fragment key={`${keyPrefix}-t${n++}`}>{part}</Fragment>);
    });
  };

  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    pushText(text.slice(last, start));
    last = start + match[0].length;
    const key = `${keyPrefix}-m${n++}`;
    if (match[2] !== undefined) {
      out.push(<code key={key}>{match[2].trim()}</code>);
    } else if (match[3] !== undefined || match[4] !== undefined) {
      out.push(<strong key={key}>{renderInline(match[3] ?? match[4], key)}</strong>);
    } else if (match[5] !== undefined) {
      out.push(<del key={key}>{renderInline(match[5], key)}</del>);
    } else if (match[6] !== undefined || match[7] !== undefined) {
      out.push(<em key={key}>{renderInline(match[6] ?? match[7], key)}</em>);
    } else if (match[8] !== undefined) {
      out.push(
        isSafeUrl(match[9]) ? (
          <a key={key} href={match[9]} target='_blank' rel='noreferrer noopener'>
            {renderInline(match[8], key)}
          </a>
        ) : (
          <Fragment key={key}>{match[0]}</Fragment>
        )
      );
    } else if (match[10] !== undefined) {
      out.push(
        <a key={key} href={match[10]} target='_blank' rel='noreferrer noopener'>
          {match[10]}
        </a>
      );
    }
  }
  pushText(text.slice(last));
  return out;
}
