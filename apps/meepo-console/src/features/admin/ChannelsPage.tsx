// Platform admin: Feishu bot channels that connect IM chats to spaces.

import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import type { Channel } from '../../api/types';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Field, Input, TagInput } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { EmptyState, ErrorState, ListSkeleton, Page, PageHeader } from '../../ui/Misc';
import { Modal, useConfirm } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

export function ChannelsPage(): React.JSX.Element {
  const channels = useQuery(keys.channels, api.listChannels);
  const spaces = useQuery(keys.spaces, api.listSpaces);
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();
  const [editing, setEditing] = useState<Channel | 'new'>();

  const remove = async (channel: Channel): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${channel.name}?`,
      message: 'The bot disconnects and stops answering in every chat it was bound to.',
      confirmLabel: 'Delete channel',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.deleteChannel(channel.id), {
      success: 'Channel deleted',
      key: channel.id,
    });
    if (done) {
      invalidate(keys.channels);
      invalidate(keys.spaces);
      invalidate('space-channels:');
    }
  };

  return (
    <div className='view'>
      <PageHeader
        title='Channels'
        subtitle='Feishu bots that bring chats into spaces. Secrets are stored encrypted and never shown again.'
        actions={
          <Button variant='primary' icon='plus' onClick={() => setEditing('new')}>
            Add channel
          </Button>
        }
      />
      <Page>
        {channels.error && !channels.data ? (
          <ErrorState message={channels.error} onRetry={() => void channels.refresh()} />
        ) : !channels.data ? (
          <ListSkeleton rows={3} />
        ) : channels.data.length === 0 ? (
          <EmptyState
            icon='plug'
            title='No channels yet'
            action={
              <Button variant='primary' icon='plus' onClick={() => setEditing('new')}>
                Add a Feishu bot
              </Button>
            }
          >
            Connect a Feishu app so people can talk to a space from chat.
          </EmptyState>
        ) : (
          <ul className='card admin-list'>
            {channels.data.map((c) => {
              const spaceName = spaces.data?.find((s) => s.id === c.spaceId)?.name;
              return (
                <li key={c.id} className='admin-row'>
                  <span className='admin-icon'>
                    <Icon name='plug' size={18} />
                  </span>
                  <div className='admin-main'>
                    <div className='admin-title'>
                      <strong className='truncate'>{c.name}</strong>
                      <Badge size='sm' tone='info'>
                        Feishu
                      </Badge>
                    </div>
                    <div className='admin-sub'>
                      <span className='mono'>{c.appId}</span>
                      <span className='faint'>·</span>
                      <span className='truncate'>
                        → {spaceName ?? <span className='mono'>{c.spaceId}</span>}
                      </span>
                      <span className='faint'>·</span>
                      <span>
                        {c.boundChatIds.length} group{c.boundChatIds.length === 1 ? '' : 's'}
                      </span>
                      <span className='faint'>·</span>
                      <span>
                        {c.allowedOpenIds.length === 0
                          ? 'Open to everyone'
                          : `${c.allowedOpenIds.length} allowed user${c.allowedOpenIds.length === 1 ? '' : 's'}`}
                      </span>
                    </div>
                  </div>
                  <div className='row'>
                    <Button size='sm' icon='pencil' onClick={() => setEditing(c)}>
                      Edit
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      icon='trash'
                      aria-label={`Delete ${c.name}`}
                      loading={pendingKey === c.id}
                      onClick={() => void remove(c)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Page>
      {editing ? (
        <ChannelModal
          channel={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function ChannelModal({
  channel,
  onClose,
}: {
  channel: Channel | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const { run, pending } = useAction();
  const [name, setName] = useState(channel?.name ?? '');
  const [appId, setAppId] = useState(channel?.appId ?? '');
  const [appSecret, setAppSecret] = useState('');
  const [spaceId, setSpaceId] = useState(channel?.spaceId ?? '');
  const [allowed, setAllowed] = useState(channel?.allowedOpenIds ?? []);
  const [chats, setChats] = useState(channel?.boundChatIds ?? []);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (!name.trim() || !appId.trim() || !spaceId.trim())
      return setError('Name, app id and space id are required.');
    if (!channel && !appSecret.trim())
      return setError('The app secret is required for a new channel.');
    setError(undefined);
    const base = {
      type: 'feishu' as const,
      name: name.trim(),
      appId: appId.trim(),
      spaceId: spaceId.trim(),
      allowedOpenIds: allowed,
      boundChatIds: chats,
      ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
    };
    const saved = await run(
      () => (channel ? api.updateChannel(channel.id, base) : api.createChannel(base)),
      {
        success: channel ? 'Channel updated' : 'Channel added',
      }
    );
    if (saved) {
      invalidate(keys.channels);
      invalidate(keys.spaceChannels(base.spaceId));
      invalidate(keys.spaces);
      onClose();
    }
  };

  return (
    <Modal
      title={channel ? `Edit ${channel.name}` : 'Add a Feishu channel'}
      onClose={onClose}
      locked={pending}
      wide
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending}>
            {channel ? 'Save' : 'Add channel'}
          </Button>
        </>
      }
    >
      <Field label='Name' hint='How people on the platform recognize this bot.'>
        <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
      </Field>
      <div className='grid-2'>
        <Field label='App id'>
          <Input
            mono
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder='cli_…'
          />
        </Field>
        <Field
          label='App secret'
          hint={channel ? 'Leave blank to keep the stored secret.' : undefined}
        >
          <Input
            type='password'
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            autoComplete='new-password'
            placeholder={channel ? '••••••••' : undefined}
          />
        </Field>
      </div>
      <Field
        label='Space id'
        hint='The space this bot talks to. Copy it from the space’s Settings, General tab.'
      >
        <Input mono value={spaceId} onChange={(e) => setSpaceId(e.target.value)} />
      </Field>
      <Field
        label='Allowed users'
        optional
        hint='Feishu open ids (ou_…). Leave empty to let everyone message the bot.'
      >
        <TagInput
          value={allowed}
          onChange={setAllowed}
          mono
          placeholder='ou_…'
          validate={(t) => (/^ou_[A-Za-z0-9]+$/.test(t) ? undefined : 'Open ids start with ou_')}
        />
      </Field>
      <Field
        label='Group chats'
        optional
        hint='Chat ids (oc_…). Space members can also manage these from the space settings.'
      >
        <TagInput
          value={chats}
          onChange={setChats}
          mono
          placeholder='oc_…'
          validate={(t) => (/^oc_[A-Za-z0-9]+$/.test(t) ? undefined : 'Chat ids start with oc_')}
        />
      </Field>
      {error ? (
        <div className='field-error' role='alert'>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
