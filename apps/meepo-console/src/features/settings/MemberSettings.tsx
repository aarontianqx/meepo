import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import { useMe, useSpace } from '../../app/context';
import { Avatar, Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Field, Input } from '../../ui/Form';
import { ErrorState, ListSkeleton, Time } from '../../ui/Misc';
import { useConfirm } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

export function MemberSettings(): React.JSX.Element {
  const space = useSpace();
  const me = useMe();
  const confirm = useConfirm();
  const { run, pending, pendingKey } = useAction();
  const members = useQuery(keys.members(space.id), () => api.listMembers(space.id));
  const [userId, setUserId] = useState('');

  if (members.error && !members.data)
    return <ErrorState message={members.error} onRetry={() => void members.refresh()} />;
  if (!members.data) return <ListSkeleton rows={3} />;

  const isOwner = members.data.some((m) => m.userId === me.userId && m.role === 'owner');
  const refresh = (): void => invalidate(keys.members(space.id));

  const add = async (): Promise<void> => {
    const id = userId.trim();
    if (!id) return;
    const added = await run(() => api.addMember(space.id, id), { success: `${id} added` });
    if (added) {
      setUserId('');
      refresh();
    }
  };

  const remove = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: `Remove ${id}?`,
      message: 'They lose access to this space immediately.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.removeMember(space.id, id), {
      success: `${id} removed`,
      key: `rm:${id}`,
    });
    if (done) refresh();
  };

  const transfer = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: `Make ${id} the owner?`,
      message:
        'You become an operator. Only the owner can delete the space, remove members or transfer ownership.',
      confirmLabel: 'Transfer ownership',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.transferOwner(space.id, id), {
      success: `${id} is now the owner`,
      key: `tx:${id}`,
    });
    if (done) refresh();
  };

  return (
    <>
      <form
        className='card card-pad stack'
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div>
          <h3 className='card-title'>Add a teammate</h3>
          <p className='muted'>
            Members can use every part of the space. The owner additionally manages membership and
            can delete it.
          </p>
        </div>
        <div className='row-end'>
          <div style={{ flex: 1 }}>
            <Field label='User id'>
              <Input
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder='User ID'
                autoComplete='off'
              />
            </Field>
          </div>
          <Button
            type='submit'
            variant='primary'
            icon='plus'
            loading={pending && pendingKey === undefined}
            disabled={!userId.trim()}
          >
            Add
          </Button>
        </div>
      </form>

      <section className='card'>
        <div className='card-head'>
          <h3>Members ({members.data.length})</h3>
        </div>
        <ul className='member-list'>
          {members.data.map((m) => (
            <li key={m.userId} className='member-row'>
              <Avatar name={m.userId} round />
              <div className='member-main'>
                <strong className='truncate'>{m.userId}</strong>
                {m.userId === me.userId ? <span className='faint'> (you)</span> : null}
                <div className='faint' style={{ fontSize: 12 }}>
                  Joined <Time at={m.createdAt} />
                </div>
              </div>
              <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'} size='sm'>
                {m.role === 'owner' ? 'Owner' : 'Member'}
              </Badge>
              {isOwner && m.role !== 'owner' ? (
                <div className='row'>
                  <Button
                    size='sm'
                    variant='ghost'
                    loading={pendingKey === `tx:${m.userId}`}
                    onClick={() => void transfer(m.userId)}
                  >
                    Make owner
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    icon='trash'
                    aria-label={`Remove ${m.userId}`}
                    loading={pendingKey === `rm:${m.userId}`}
                    onClick={() => void remove(m.userId)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
