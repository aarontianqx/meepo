import type { Space } from '@meepo/core';
import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { setQueryData, useQuery } from '../../api/query';
import { useMe, useSpace } from '../../app/context';
import { LAST_SPACE_KEY, navigate } from '../../app/router';
import { timezoneOptions } from '../../lib/timezone';
import { Button } from '../../ui/Button';
import { Field, Input, Select, TagInput, Textarea } from '../../ui/Form';
import { CopyBox } from '../../ui/Misc';
import { useConfirm } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

export function GeneralSettings(): React.JSX.Element {
  const space = useSpace();
  const { run, pending } = useAction();
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? '');
  const [timezone, setTimezone] = useState(space.timezone);
  const [tags, setTags] = useState(space.requiredTags);

  const dirty =
    name.trim() !== space.name ||
    description !== (space.description ?? '') ||
    timezone !== space.timezone ||
    tags.join('\n') !== space.requiredTags.join('\n');

  const save = async (): Promise<void> => {
    const updated = await run(
      () =>
        api.updateSpace(space.id, {
          name: name.trim(),
          description,
          timezone,
          requiredTags: tags,
        }),
      { success: 'Settings saved' }
    );
    if (updated)
      setQueryData<Space[]>(keys.spaces, (cur) =>
        (cur ?? []).map((s) => (s.id === updated.id ? updated : s))
      );
  };

  return (
    <>
      <form
        className='card card-pad stack'
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label='Name'>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field
          label='Description'
          optional
          hint='Teammates see this, and the agent gets it as context.'
        >
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <Field label='Timezone' hint='Default for schedules in this space.'>
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {timezoneOptions(space.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label='Required worker tags'
          optional
          hint='Tickets only run on workers carrying all of these tags.'
        >
          <TagInput value={tags} onChange={setTags} mono placeholder='Add a tag' />
        </Field>
        <div className='field'>
          <span className='field-label'>Space id</span>
          <CopyBox text={space.id} />
        </div>
        <div className='row'>
          <Button
            type='submit'
            variant='primary'
            loading={pending}
            disabled={!dirty || !name.trim()}
          >
            Save changes
          </Button>
          {dirty ? (
            <Button
              onClick={() => {
                setName(space.name);
                setDescription(space.description ?? '');
                setTimezone(space.timezone);
                setTags(space.requiredTags);
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </form>
      <DangerZone />
    </>
  );
}

function DangerZone(): React.JSX.Element | null {
  const space = useSpace();
  const me = useMe();
  const confirm = useConfirm();
  const { run, pending } = useAction();
  const members = useQuery(keys.members(space.id), () => api.listMembers(space.id));
  const isOwner = members.data?.some((m) => m.userId === me.userId && m.role === 'owner');
  if (!isOwner) return null;

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Delete this space?',
      message:
        'All of its conversations, tickets, schedules, notes and settings are permanently deleted. Workers and chats are disconnected.',
      confirmLabel: 'Delete space',
      tone: 'danger',
      requireText: space.name,
    });
    if (!ok) return;
    const done = await run(() => api.deleteSpace(space.id), { success: 'Space deleted' });
    if (!done) return;
    setQueryData<Space[]>(keys.spaces, (cur) => (cur ?? []).filter((s) => s.id !== space.id));
    localStorage.removeItem(LAST_SPACE_KEY);
    navigate('#/spaces');
  };

  return (
    <section className='card danger-zone'>
      <div className='card-head'>
        <h3>Danger zone</h3>
      </div>
      <div className='card-body row'>
        <div style={{ flex: 1 }}>
          <strong>Delete this space</strong>
          <div className='muted' style={{ fontSize: 13 }}>
            Only the owner can do this. It cannot be undone.
          </div>
        </div>
        <Button variant='danger' icon='trash' loading={pending} onClick={() => void remove()}>
          Delete space
        </Button>
      </div>
    </section>
  );
}
