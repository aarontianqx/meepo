// Memory: the space's shared notebook, browsable as a folder tree with search and an editor.

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { useQuery } from '../../api/query';
import type { MemorySearchHit } from '../../api/types';
import { useSpace } from '../../app/context';
import { navigate, spaceHref, type SectionProps } from '../../app/router';
import { MEMORY_ENTRY_CAP, NEW_ENTRY } from '../../lib/memory';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, SplitView } from '../../ui/Misc';
import { MemoryEntryPane, type MemoryDraft } from './MemoryEntryPane';
import { buildTree, type TreeNode } from './tree';

const SEARCH_DEBOUNCE_MS = 250;

export function MemoryPage({ item, query }: SectionProps): React.JSX.Element {
  const space = useSpace();
  const list = useQuery(keys.memory(space.id), () => api.listMemory(space.id), {
    interval: 15_000,
  });
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Unsaved edits survive switching between entries until saved or discarded.
  const [drafts, setDrafts] = useState<Readonly<Record<string, MemoryDraft>>>({});

  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (Object.keys(drafts).length === 0) return undefined;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [drafts]);

  const hits = useQuery(
    `${keys.memory(space.id)}:search:${term}`,
    () => api.searchMemory(space.id, term),
    { enabled: term.length > 0 }
  );

  const entries = list.data;
  const tree = useMemo(() => buildTree(entries ?? []), [entries]);
  const meta = entries?.find((e) => e.path === item);
  const setDraft = (key: string, draft: MemoryDraft | undefined): void =>
    setDrafts((current) => {
      const next = { ...current };
      if (draft) next[key] = draft;
      else delete next[key];
      return next;
    });

  const toggle = (path: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const open = (path: string): string => spaceHref(space.id, 'memory', path);
  const searching = term.length > 0;

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const isFolder = node.children.length > 0;
    const isCollapsed = collapsed.has(node.path);
    const pad = { paddingLeft: 10 + depth * 14 };
    return (
      <div key={node.path}>
        {isFolder ? (
          <button
            type='button'
            className='tree-row tree-folder'
            style={pad}
            aria-expanded={!isCollapsed}
            onClick={() => toggle(node.path)}
          >
            <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={13} />
            <Icon name='folder' size={14} />
            <span className='tree-name truncate'>{node.name}</span>
            <span className='tree-count'>{node.count}</span>
          </button>
        ) : null}
        {node.entry ? (
          <a
            className='tree-row tree-entry'
            style={
              isFolder
                ? { paddingLeft: 10 + (depth + 1) * 14 }
                : { ...pad, paddingLeft: 10 + depth * 14 + 18 }
            }
            href={open(node.entry.path)}
            aria-current={node.entry.path === item}
            title={node.entry.description}
          >
            <Icon name={node.entry.pinned ? 'star' : 'file'} size={14} />
            <span className='tree-main'>
              <span className='tree-name truncate'>
                {isFolder ? `${node.name} (index)` : node.name}
              </span>
              <span className='tree-desc truncate'>{node.entry.description}</span>
            </span>
            {drafts[node.entry.path] ? (
              <span className='tree-dirty' title='Unsaved changes' />
            ) : null}
          </a>
        ) : null}
        {isFolder && !isCollapsed
          ? node.children.map((child) => renderNode(child, depth + 1))
          : null}
      </div>
    );
  };

  const prefill = query.get('prefix') ?? '';

  return (
    <div className='view'>
      <PageHeader
        title='Memory'
        subtitle='Shared notes the agent reads and writes: conventions, runbooks, environment facts.'
        actions={
          <>
            {entries ? (
              <span className='faint' style={{ fontSize: 12.5 }}>
                {entries.length} / {MEMORY_ENTRY_CAP} entries
              </span>
            ) : null}
            <Button
              variant='primary'
              icon='plus'
              onClick={() => navigate(spaceHref(space.id, 'memory', NEW_ENTRY))}
            >
              New entry
            </Button>
          </>
        }
      />
      <SplitView
        detailOpen={Boolean(item)}
        listWidth={340}
        list={
          <>
            <div className='list-toolbar'>
              <div className='input-group'>
                <Icon name='search' size={14} />
                <input
                  className='input'
                  placeholder='Search notes'
                  aria-label='Search memory'
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search ? (
                  <button
                    type='button'
                    className='input-clear'
                    aria-label='Clear search'
                    onClick={() => setSearch('')}
                  >
                    <Icon name='x' size={13} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className='list-scroll'>
              {list.error && !entries ? (
                <div style={{ padding: 14 }}>
                  <ErrorState message={list.error} onRetry={() => void list.refresh()} />
                </div>
              ) : !entries ? (
                <ListSkeleton />
              ) : searching ? (
                <SearchResults
                  hits={hits.data}
                  loading={hits.loading}
                  error={hits.error}
                  term={term}
                  selected={item}
                  open={open}
                />
              ) : entries.length === 0 ? (
                <EmptyState
                  icon='book'
                  title='No notes yet'
                  action={
                    <Button
                      variant='primary'
                      icon='plus'
                      onClick={() => navigate(spaceHref(space.id, 'memory', NEW_ENTRY))}
                    >
                      Write the first note
                    </Button>
                  }
                >
                  The agent can save what it learns here too. Notes are searched, never copied
                  wholesale into every prompt.
                </EmptyState>
              ) : (
                <nav className='tree' aria-label='Memory notes'>
                  {tree.map((node) => renderNode(node, 0))}
                </nav>
              )}
            </div>
          </>
        }
        detail={
          item ? (
            item === NEW_ENTRY || meta || !entries ? (
              <MemoryEntryPane
                key={item}
                spaceId={space.id}
                path={item}
                meta={meta}
                loadingList={!entries}
                draft={drafts[item]}
                onDraft={(draft) => setDraft(item, draft)}
                prefillPath={prefill}
                existingPaths={entries?.map((e) => e.path) ?? []}
              />
            ) : (
              <div className='detail-placeholder'>
                <EmptyState
                  icon='ban'
                  title='Note not found'
                  action={
                    <Button onClick={() => navigate(spaceHref(space.id, 'memory'))}>
                      Back to notes
                    </Button>
                  }
                >
                  <code>{item}</code> does not exist; it may have been deleted.
                </EmptyState>
              </div>
            )
          ) : (
            <div className='detail-placeholder'>
              <EmptyState icon='book' title='Select a note'>
                Browse the folders on the left, or search by keyword.
              </EmptyState>
            </div>
          )
        }
      />
    </div>
  );
}

function Highlight({ text, term }: { text: string; term: string }): React.JSX.Element {
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let at = lower.indexOf(needle); needle && at !== -1; at = lower.indexOf(needle, cursor)) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function SearchResults({
  hits,
  loading,
  error,
  term,
  selected,
  open,
}: {
  hits: MemorySearchHit[] | undefined;
  loading: boolean;
  error: string | undefined;
  term: string;
  selected: string | undefined;
  open: (path: string) => string;
}): React.JSX.Element {
  if (error && !hits)
    return (
      <div style={{ padding: 14 }}>
        <ErrorState message={error} />
      </div>
    );
  if (loading || !hits) return <ListSkeleton rows={4} />;
  if (hits.length === 0)
    return (
      <EmptyState icon='search' title='No matches'>
        Nothing in this space contains “{term}”.
      </EmptyState>
    );
  return (
    <div>
      {hits.map((hit) => (
        <a
          key={hit.path}
          className='list-row'
          href={open(hit.path)}
          aria-current={hit.path === selected}
        >
          <div className='list-row-top'>
            <span className='list-row-title mono truncate'>
              <Highlight text={hit.path} term={term} />
            </span>
            {hit.pinned ? <Icon name='star' size={13} /> : null}
          </div>
          <div className='list-row-preview'>
            <Highlight text={hit.snippets[0] ?? hit.description} term={term} />
          </div>
          <div className='list-row-meta'>matched in {hit.matched_fields.join(', ')}</div>
        </a>
      ))}
    </div>
  );
}
