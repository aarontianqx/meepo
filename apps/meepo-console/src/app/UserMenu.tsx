import { useCallback, useRef, useState } from 'react';

import { getUserId, setUserId } from '../api/client';
import { api } from '../api/endpoints';
import { keys } from '../api/keys';
import { clearQueries, useQuery } from '../api/query';
import { Avatar, Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Field, Input, Segmented } from '../ui/Form';
import { Icon } from '../ui/Icon';
import { Popover } from '../ui/Popover';
import { useMe } from './context';
import { setTheme, useThemePreference, type ThemePreference } from './theme';

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Footer account control: identity, theme and server status. */
export function UserMenu({ onSwitchUser }: { onSwitchUser: () => void }): React.JSX.Element {
  const me = useMe();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const theme = useThemePreference();
  const health = useQuery(keys.health, api.health, { interval: 15_000 });
  const [draft, setDraft] = useState(getUserId());

  const switchUser = (): void => {
    const next = draft.trim();
    if (!next || next === me.userId) return;
    setUserId(next);
    clearQueries();
    close();
    onSwitchUser();
  };

  return (
    <>
      <button
        ref={anchor}
        type='button'
        className='user-chip'
        aria-haspopup='dialog'
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar name={me.displayName || me.userId} round />
        <span className='user-chip-text'>
          <span className='user-chip-name truncate' style={{ display: 'block' }}>
            {me.displayName || me.userId}
          </span>
          <span className='user-chip-sub truncate' style={{ display: 'block' }}>
            {me.isAdmin ? 'Administrator' : 'Member'}
          </span>
        </span>
        <Icon name='more' size={16} />
      </button>
      {open ? (
        <Popover anchor={anchor} onClose={close} label='Account' placement='top' width={288}>
          <div className='user-menu'>
            <div className='user-menu-head'>
              <div className='row'>
                <strong>{me.displayName || me.userId}</strong>
                {me.isAdmin ? (
                  <Badge tone='accent' size='sm'>
                    admin
                  </Badge>
                ) : null}
              </div>
              <div className='faint mono' style={{ fontSize: 12 }}>
                {me.userId}
              </div>
            </div>
            <div className='menu-sep' />
            <div className='menu-label'>Appearance</div>
            <div className='user-menu-section'>
              <Segmented
                label='Theme'
                value={theme}
                options={THEMES}
                onChange={(value) => setTheme(value)}
              />
            </div>
            <div className='menu-sep' />
            <div className='menu-label'>Switch identity</div>
            <form
              className='user-menu-section'
              onSubmit={(event) => {
                event.preventDefault();
                switchUser();
              }}
            >
              <Field label='User id' hint='Sent as x-meepo-user-id (development header auth).'>
                <Input
                  mono
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder='User ID'
                />
              </Field>
              <div className='row' style={{ marginTop: 8 }}>
                <Button
                  type='submit'
                  size='sm'
                  disabled={!draft.trim() || draft.trim() === me.userId}
                >
                  Switch
                </Button>
              </div>
            </form>
            <div className='menu-sep' />
            <div className='health-line'>
              <span
                className={`dot ${health.data ? 'tone-ok' : 'tone-danger'}`}
                style={{ color: health.data ? 'var(--ok)' : 'var(--danger)' }}
              />
              {health.data
                ? `Server healthy, up ${formatUptime(health.data.uptimeSeconds)}`
                : (health.error ?? 'Connecting to server…')}
            </div>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
