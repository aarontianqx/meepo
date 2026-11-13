// Space list: entry point for users with several spaces, plus space creation.

import type { Space } from '@meepo/core';
import { useEffect, useState } from 'react';

import { api, type CreateSpaceInput } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { setQueryData, useQuery } from '../../api/query';
import { useMe } from '../../app/context';
import { navigate, spaceHref, useRoute } from '../../app/router';
import { ACTIVE_TICKET } from '../../lib/status';
import { nonEmpty } from '../../lib/format';
import { browserTimezone, timezoneOptions } from '../../lib/timezone';
import { Avatar, Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Field, Input, Segmented, Select, TagInput, Textarea } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { EmptyState, ErrorState, ListSkeleton, Page, PageHeader } from '../../ui/Misc';
import { Modal } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

export function SpacesHome(): React.JSX.Element {
  const me = useMe();
  const route = useRoute();
  const spaces = useQuery(keys.spaces, api.listSpaces, { interval: 15_000 });
  const [creating, setCreating] = useState(false);

  // The space switcher links here with ?new=1 to open the creation dialog directly.
  useEffect(() => {
    if (window.location.hash.includes('new=1')) {
      setCreating(true);
      navigate('#/spaces', { replace: true });
    }
  }, [route]);

  const list = spaces.data;
  return (
    <div className='view'>
      <PageHeader
        title='Spaces'
        subtitle='A space is a team workspace: its own chats, tasks, memory and workers.'
        actions={
          <Button variant='primary' icon='plus' onClick={() => setCreating(true)}>
            New space
          </Button>
        }
      />
      <Page>
        {spaces.error && !list ? (
          <ErrorState message={spaces.error} onRetry={() => void spaces.refresh()} />
        ) : null}
        {!list && !spaces.error ? <ListSkeleton rows={4} /> : null}
        {list && list.length === 0 ? (
          <EmptyState
            icon='layers'
            title='No spaces yet'
            action={
              <Button variant='primary' icon='plus' onClick={() => setCreating(true)}>
                Create your first space
              </Button>
            }
          >
            {me.isAdmin
              ? 'Create a space to start, or open Models and Channels in the sidebar to configure the platform.'
              : 'Create a space, or ask an owner to add you to an existing one.'}
          </EmptyState>
        ) : null}
        {list && list.length > 0 ? (
          <div className='space-grid'>
            {list.map((space) => (
              <SpaceCard key={space.id} space={space} />
            ))}
          </div>
        ) : null}
      </Page>
      {creating ? <CreateSpaceModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function SpaceCard({ space }: { space: Space }): React.JSX.Element {
  const tickets = useQuery(keys.tickets(space.id), () => api.listTickets(space.id), {
    interval: 10_000,
  });
  const workers = useQuery(keys.workers(space.id), () => api.listWorkers(space.id), {
    interval: 15_000,
  });
  const active = tickets.data?.filter((t) => ACTIVE_TICKET.has(t.status)).length ?? 0;
  const review = tickets.data?.filter((t) => t.status === 'manual_review').length ?? 0;
  const online = workers.data?.filter((w) => w.status !== 'offline').length;

  return (
    <a className='space-card' href={spaceHref(space.id)}>
      <div className='row'>
        <Avatar name={space.name} size='lg' />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 className='truncate'>{space.name}</h3>
          <div className='faint' style={{ fontSize: 12 }}>
            {space.promptPreset === 'coding' ? 'Coding' : 'General'} · {space.timezone}
          </div>
        </div>
        <Icon name='arrowRight' size={16} />
      </div>
      <p className={`space-card-desc ${space.description ? 'muted' : 'faint'}`}>
        {space.description || 'No description'}
      </p>
      <div className='space-card-foot'>
        {online === undefined ? null : online > 0 ? (
          <Badge tone='ok' size='sm' icon='server'>
            {online} online
          </Badge>
        ) : (
          <Badge tone='warn' size='sm' icon='server'>
            No worker
          </Badge>
        )}
        {active > 0 ? (
          <Badge tone='accent' size='sm'>
            {active} running
          </Badge>
        ) : null}
        {review > 0 ? (
          <Badge tone='warn' size='sm'>
            {review} to review
          </Badge>
        ) : null}
      </div>
    </a>
  );
}

function CreateSpaceModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { run, pending } = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [preset, setPreset] = useState<'general' | 'coding'>('general');
  const [timezone, setTimezone] = useState(browserTimezone());
  const [tags, setTags] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const submit = async (): Promise<void> => {
    const input: CreateSpaceInput = {
      name: name.trim(),
      description: nonEmpty(description),
      promptPreset: preset,
      timezone,
      requiredTags: tags.length > 0 ? tags : undefined,
    };
    const created = await run(() => api.createSpace(input), { success: 'Space created' });
    if (!created) return;
    setQueryData<Space[]>(keys.spaces, (current) => [...(current ?? []), created]);
    onClose();
    navigate(spaceHref(created.id));
  };

  return (
    <Modal
      title='New space'
      description='You become the owner. You can change everything later in Settings.'
      onClose={onClose}
      locked={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending} disabled={!name.trim()}>
            Create space
          </Button>
        </>
      }
    >
      <Field label='Name'>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          data-autofocus
        />
      </Field>
      <Field
        label='Description'
        optional
        hint='Shown to teammates and given to the agent as context.'
      >
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </Field>
      <div className='field'>
        <span className='field-label'>What will the agent do here?</span>
        <Segmented
          label='Prompt preset'
          value={preset}
          onChange={setPreset}
          options={[
            { value: 'general', label: 'General assistant' },
            { value: 'coding', label: 'Software development' },
          ]}
        />
        <span className='field-hint'>
          {preset === 'general'
            ? 'Chat, research, writing and operations tasks in isolated working folders.'
            : 'Adds git worktree conventions to the agent prompt. The agent finds and clones repositories itself, using the worker machine’s own git access.'}
        </span>
      </div>
      <button
        type='button'
        className='disclosure'
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        <Icon name={showAdvanced ? 'chevronDown' : 'chevronRight'} size={14} />
        Advanced
      </button>
      {showAdvanced ? (
        <>
          <Field label='Timezone' hint='Default for schedules and relative times the agent sees.'>
            <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {timezoneOptions(browserTimezone()).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label='Required worker tags'
            optional
            hint='Only workers carrying all of these tags may run tickets. Press Enter to add.'
          >
            <TagInput value={tags} onChange={setTags} placeholder='Add a tag' mono />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}
