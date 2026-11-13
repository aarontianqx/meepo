import type { Space } from '@meepo/core';
import { useCallback, useMemo, useRef, useState } from 'react';

import { api } from '../api/endpoints';
import { keys } from '../api/keys';
import { useQuery } from '../api/query';
import { Avatar } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Popover } from '../ui/Popover';
import { navigate, spaceHref, type SpaceSection } from './router';

const SEARCH_THRESHOLD = 7;

/** Sidebar control showing the current space; opens a searchable list of the user's spaces. */
export function SpaceSwitcher({
  current,
  section,
  onNavigate,
}: {
  current: Space | undefined;
  section: SpaceSection;
  onNavigate: () => void;
}): React.JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const spaces = useQuery(keys.spaces, api.listSpaces, { interval: 20_000 });
  const close = useCallback(() => {
    setOpen(false);
    setFilter('');
  }, []);

  const list = spaces.data ?? [];
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? list.filter((space) => space.name.toLowerCase().includes(needle)) : list;
  }, [list, filter]);

  const go = (href: string): void => {
    close();
    onNavigate();
    navigate(href);
  };

  return (
    <>
      <button
        ref={anchor}
        type='button'
        className='space-switch'
        aria-haspopup='dialog'
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {current ? (
          <Avatar name={current.name} />
        ) : (
          <span className='avatar avatar-muted'>
            <Icon name='layers' size={14} />
          </span>
        )}
        <span className='space-switch-text'>
          <span className='space-switch-name truncate' style={{ display: 'block' }}>
            {current?.name ?? 'Choose a space'}
          </span>
          <span className='space-switch-sub truncate' style={{ display: 'block' }}>
            {current
              ? current.promptPreset === 'coding'
                ? 'Coding space'
                : 'General space'
              : `${list.length} available`}
          </span>
        </span>
        <Icon name='chevronsUpDown' size={14} />
      </button>
      {open ? (
        <Popover anchor={anchor} onClose={close} label='Switch space' width={280}>
          <div className='switcher'>
            {list.length > SEARCH_THRESHOLD ? (
              <div className='switcher-search'>
                <div className='input-group'>
                  <Icon name='search' size={14} />
                  <input
                    className='input'
                    placeholder='Find a space'
                    aria-label='Find a space'
                    value={filter}
                    autoFocus
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
            <div className='switcher-list'>
              {visible.map((space) => (
                <button
                  key={space.id}
                  type='button'
                  className='menu-item'
                  aria-current={space.id === current?.id}
                  onClick={() => go(spaceHref(space.id, section))}
                >
                  <Avatar name={space.name} size='sm' />
                  <span className='menu-item-main truncate'>{space.name}</span>
                  {space.id === current?.id ? <Icon name='check' size={14} /> : null}
                </button>
              ))}
              {visible.length === 0 ? (
                <div className='switcher-empty'>
                  {list.length === 0 ? 'No spaces yet' : 'No space matches'}
                </div>
              ) : null}
            </div>
            <div className='menu-sep' />
            <button type='button' className='menu-item' onClick={() => go('#/spaces')}>
              <Icon name='layers' size={15} />
              All spaces
            </button>
            <button type='button' className='menu-item' onClick={() => go('#/spaces?new=1')}>
              <Icon name='plus' size={15} />
              New space
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
