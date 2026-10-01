import { useState } from 'react';
import { request } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { ErrorBanner, Section } from '../components/common';
import { SpaceScope, enc } from './ObservationPages';
interface Entry {
  path: string;
  description: string;
  keywords: string[];
  content?: string;
  revision: number;
  pinned: boolean;
  snippets?: string[];
}
const fresh: Entry = {
  path: '',
  description: '',
  keywords: [],
  content: '',
  revision: 0,
  pinned: false,
};
export function MemoryPage() {
  return (
    <>
      <h2>Memory</h2>
      <SpaceScope>{(id) => <MemoryEditor spaceId={id} />}</SpaceScope>
    </>
  );
}
export function MemoryEditor({ spaceId }: { spaceId: string }) {
  const [query, setQuery] = useState(''),
    [activeQuery, setActiveQuery] = useState('');
  const entries = usePolling(
    () =>
      request<Entry[]>(
        'GET',
        `/api/memory${activeQuery ? '/search' : ''}?spaceId=${enc(spaceId)}&${activeQuery ? `q=${enc(activeQuery)}` : 'limit=500'}`
      ),
    5000
  );
  const [selected, setSelected] = useState<Entry | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const path = (name: string) =>
    `/api/memory/${name.split('/').map(enc).join('/')}?spaceId=${enc(spaceId)}`;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
      entries.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const read = async (name: string) => {
    const first = await request<Entry & { totalBytes: number; nextOffset: number }>(
      'GET',
      path(name)
    );
    let content = first.content ?? '',
      offset = first.nextOffset;
    while (offset < first.totalBytes) {
      const next = await request<typeof first>('GET', `${path(name)}&offset=${offset}`);
      if (next.revision !== first.revision)
        throw new Error('Memory changed during reading. Reload the current revision.');
      if (next.nextOffset <= offset) throw new Error('Memory read did not advance');
      content += next.content;
      offset = next.nextOffset;
    }
    setSelected({ ...first, content });
  };
  return (
    <>
      <ErrorBanner error={error ?? entries.error} />
      <form
        className='row-inline'
        onSubmit={(e) => {
          e.preventDefault();
          setActiveQuery(query);
          setTimeout(entries.refresh, 0);
        }}
      >
        <input
          aria-label='Search memory'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search memory (substring)'
        />
        <button>Search</button>
        <button type='button' onClick={() => setSelected({ ...fresh })}>
          New entry
        </button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Description</th>
            <th>Revision</th>
          </tr>
        </thead>
        <tbody>
          {entries.data?.map((entry) => (
            <tr key={entry.path}>
              <td>
                <button disabled={busy} onClick={() => void act(() => read(entry.path))}>
                  {entry.pinned ? '★ ' : ''}
                  {entry.path}
                </button>
              </td>
              <td>
                {entry.description}
                {entry.snippets?.map((s, i) => (
                  <p className='muted' key={i}>
                    {s}
                  </p>
                ))}
              </td>
              <td>{entry.revision}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <Section
          title={
            selected.revision ? `Edit memory · revision ${selected.revision}` : 'New memory entry'
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const saved = await request<Entry>('PUT', path(selected.path), {
                  ...selected,
                  expected_revision: selected.revision,
                });
                setSelected({ ...saved, content: selected.content });
              });
            }}
          >
            <label>
              Path
              <input
                required
                disabled={selected.revision > 0}
                value={selected.path}
                onChange={(e) => setSelected({ ...selected, path: e.target.value })}
                placeholder='project/conventions'
              />
            </label>
            <label>
              Description
              <input
                required
                maxLength={200}
                value={selected.description}
                onChange={(e) => setSelected({ ...selected, description: e.target.value })}
              />
            </label>
            <label>
              Keywords (comma separated)
              <input
                value={selected.keywords.join(',')}
                onChange={(e) =>
                  setSelected({ ...selected, keywords: e.target.value.split(',').filter(Boolean) })
                }
              />
            </label>
            <label>
              <input
                type='checkbox'
                checked={selected.pinned}
                onChange={(e) => setSelected({ ...selected, pinned: e.target.checked })}
              />{' '}
              Pinned
            </label>
            <label>
              Content
              <textarea
                rows={14}
                value={selected.content}
                onChange={(e) => setSelected({ ...selected, content: e.target.value })}
              />
            </label>
            <button disabled={busy}>Save</button>
            {selected.revision > 0 && (
              <>
                <button
                  type='button'
                  disabled={busy}
                  onClick={() => void act(() => read(selected.path))}
                >
                  Reload current revision
                </button>
                <button
                  className='danger'
                  type='button'
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Delete ${selected.path}?`))
                      void act(async () => {
                        await request(
                          'DELETE',
                          `${path(selected.path)}&expected_revision=${selected.revision}`
                        );
                        setSelected(null);
                      });
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </form>
        </Section>
      )}
    </>
  );
}
