import { useState } from 'react';

import type { Space } from '@meepo/core';

import { api } from '../api/client';
import { ErrorBanner, Section } from '../components/common';
import { usePolling } from '../hooks/usePolling';
import { nonEmpty, parseTags } from '../util';

interface SpacesPageProps {
  onOpenSpace: (spaceId: string) => void;
}

export function SpacesPage({ onOpenSpace }: SpacesPageProps): React.JSX.Element {
  const spaces = usePolling(() => api.listSpaces(), 10_000);

  return (
    <div>
      <h2>Spaces</h2>
      <ErrorBanner error={spaces.error} />
      <Section title={`All spaces (${spaces.data?.length ?? 0})`}>
        {spaces.data?.length === 0 ? <p className='muted'>No spaces yet.</p> : null}
        {spaces.data && spaces.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Repo</th>
                <th>Bound worker</th>
                <th>Chats</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {spaces.data.map((space) => (
                <SpaceRow key={space.id} space={space} onOpen={onOpenSpace} />
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
      <CreateSpaceForm
        onCreated={(space) => {
          spaces.refresh();
          onOpenSpace(space.id);
        }}
      />
    </div>
  );
}

function SpaceRow({
  space,
  onOpen,
}: {
  space: Space;
  onOpen: (spaceId: string) => void;
}): React.JSX.Element {
  return (
    <tr>
      <td>
        <button className='clickable' onClick={() => onOpen(space.id)}>
          {space.name}
        </button>
      </td>
      <td>
        <code>{space.repoUrl}</code> <span className='muted'>({space.defaultBranch})</span>
      </td>
      <td>{space.boundWorkerId ?? <span className='muted'>unbound</span>}</td>
      <td>{space.boundChatIds.length}</td>
      <td>
        {space.requiredTags.map((tag) => (
          <span key={tag} className='tag'>
            {tag}
          </span>
        ))}
      </td>
    </tr>
  );
}

function CreateSpaceForm({ onCreated }: { onCreated: (space: Space) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [description, setDescription] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [requiredTags, setRequiredTags] = useState('');
  const [timezone, setTimezone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const space = await api.createSpace({
        name: name.trim(),
        repoUrl: repoUrl.trim(),
        description: nonEmpty(description),
        defaultBranch: nonEmpty(defaultBranch),
        requiredTags: parseTags(requiredTags),
        timezone: nonEmpty(timezone),
      });
      setName('');
      setRepoUrl('');
      setDescription('');
      setDefaultBranch('');
      setRequiredTags('');
      setTimezone('');
      onCreated(space);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create space');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title='Create space'>
      <form onSubmit={(event) => void submit(event)}>
        <div className='form-grid'>
          <label>
            <span>Name *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            <span>Repo URL *</span>
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder='git@github.com:org/repo.git'
              required
            />
          </label>
          <label>
            <span>Default branch</span>
            <input
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder='main'
            />
          </label>
          <label>
            <span>Timezone (IANA)</span>
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder='Asia/Shanghai'
            />
          </label>
          <label>
            <span>Required tags (comma separated)</span>
            <input
              value={requiredTags}
              onChange={(e) => setRequiredTags(e.target.value)}
              placeholder='gpu, linux'
            />
          </label>
          <label>
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <ErrorBanner error={error} />
        <div className='form-actions'>
          <button className='primary' type='submit' disabled={busy}>
            Create space
          </button>
        </div>
      </form>
    </Section>
  );
}
