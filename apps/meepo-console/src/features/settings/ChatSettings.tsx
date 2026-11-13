import { useEffect, useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import type { Channel } from '../../api/types';
import { useMe, useSpace } from '../../app/context';
import { navigate } from '../../app/router';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Field, TagInput } from '../../ui/Form';
import { EmptyState, ErrorState, ListSkeleton } from '../../ui/Misc';
import { useAction } from '../../ui/useAction';

/** IM groups the bot answers in; private chats work without binding. */
export function ChatSettings(): React.JSX.Element {
  const space = useSpace();
  const me = useMe();
  const channels = useQuery(keys.spaceChannels(space.id), () => api.spaceChannels(space.id));

  if (channels.error && !channels.data)
    return <ErrorState message={channels.error} onRetry={() => void channels.refresh()} />;
  if (!channels.data) return <ListSkeleton rows={2} />;
  if (channels.data.length === 0)
    return (
      <div className='card'>
        <EmptyState
          icon='plug'
          title='No bot is connected to this space'
          action={
            me.isAdmin ? (
              <Button variant='primary' onClick={() => navigate('#/channels')}>
                Open channels
              </Button>
            ) : undefined
          }
        >
          {me.isAdmin
            ? 'Create a Feishu channel and point it at this space, then bind your group chats here.'
            : 'A platform admin connects a Feishu bot to this space. Once done, you can bind group chats here.'}
        </EmptyState>
      </div>
    );

  return (
    <>
      <p className='muted'>
        Everyone allowed on the bot can message it privately. To use it in a group, add the bot to
        the group and list the group’s chat id here.
      </p>
      {channels.data.map((channel) => (
        <ChannelCard key={channel.id} channel={channel} />
      ))}
    </>
  );
}

function ChannelCard({ channel }: { channel: Channel }): React.JSX.Element {
  const space = useSpace();
  const { run, pending } = useAction();
  const [chats, setChats] = useState(channel.boundChatIds);
  useEffect(() => setChats(channel.boundChatIds), [channel.boundChatIds]);
  const dirty = chats.join('\n') !== channel.boundChatIds.join('\n');

  const save = async (): Promise<void> => {
    const done = await run(() => api.bindChats(space.id, channel.id, chats), {
      success: 'Group chats saved',
    });
    if (done) {
      invalidate(keys.spaceChannels(space.id));
      // Space.boundChatIds is projected from channels; the overview checklist reads it.
      invalidate(keys.spaces);
    }
  };

  return (
    <form
      className='card card-pad stack'
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className='row'>
        <div style={{ flex: 1 }}>
          <h3 className='card-title'>{channel.name}</h3>
          <div className='muted mono' style={{ fontSize: 12 }}>
            {channel.appId}
          </div>
        </div>
        <Badge tone='info' icon='plug'>
          Feishu
        </Badge>
      </div>
      <Field
        label='Group chats'
        optional
        hint='Chat ids look like oc_1234abcd. Press Enter after each one.'
      >
        <TagInput
          value={chats}
          onChange={setChats}
          mono
          placeholder='oc_…'
          validate={(tag) =>
            /^oc_[A-Za-z0-9]+$/.test(tag) ? undefined : 'Chat ids start with oc_'
          }
        />
      </Field>
      <div className='row'>
        <Button type='submit' variant='primary' loading={pending} disabled={!dirty}>
          Save chats
        </Button>
        {dirty ? <Button onClick={() => setChats(channel.boundChatIds)}>Reset</Button> : null}
      </div>
    </form>
  );
}
