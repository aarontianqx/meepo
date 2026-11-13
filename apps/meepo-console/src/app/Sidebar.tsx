import type { Space } from '@meepo/core';
import type { ReactNode } from 'react';

import { api } from '../api/endpoints';
import { keys } from '../api/keys';
import { useQuery } from '../api/query';
import { ACTIVE_TICKET } from '../lib/status';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { useMe } from './context';
import { spaceHref, type Route, type SpaceSection } from './router';
import { SpaceSwitcher } from './SpaceSwitcher';
import { UserMenu } from './UserMenu';

const SPACE_NAV: Array<{ section: SpaceSection; label: string; icon: IconName }> = [
  { section: 'overview', label: 'Overview', icon: 'home' },
  { section: 'conversations', label: 'Conversations', icon: 'message' },
  { section: 'tickets', label: 'Tickets', icon: 'tickets' },
  { section: 'schedules', label: 'Schedules', icon: 'clock' },
  { section: 'memory', label: 'Memory', icon: 'book' },
  { section: 'workers', label: 'Workers', icon: 'server' },
  { section: 'settings', label: 'Settings', icon: 'sliders' },
];

function NavLink({
  href,
  icon,
  label,
  current,
  badge,
  onNavigate,
}: {
  href: string;
  icon: IconName;
  label: string;
  current: boolean;
  badge?: ReactNode;
  onNavigate: () => void;
}): React.JSX.Element {
  return (
    <a
      className='nav-item'
      href={href}
      aria-current={current ? 'page' : undefined}
      onClick={onNavigate}
    >
      <Icon name={icon} size={16} />
      {label}
      {badge}
    </a>
  );
}

/** Counts that deserve attention in the nav, derived from the same queries the pages use. */
function useSpaceBadges(spaceId: string | undefined): {
  review: number;
  active: number;
  noWorker: boolean;
} {
  const tickets = useQuery(keys.tickets(spaceId ?? ''), () => api.listTickets(spaceId), {
    interval: 5_000,
    enabled: spaceId !== undefined,
  });
  const workers = useQuery(keys.workers(spaceId ?? ''), () => api.listWorkers(spaceId), {
    interval: 10_000,
    enabled: spaceId !== undefined,
  });
  const list = tickets.data ?? [];
  return {
    review: list.filter((ticket) => ticket.status === 'manual_review').length,
    active: list.filter((ticket) => ACTIVE_TICKET.has(ticket.status)).length,
    noWorker: workers.data !== undefined && !workers.data.some((w) => w.status !== 'offline'),
  };
}

export function Sidebar({
  route,
  space,
  onNavigate,
  onSwitchUser,
}: {
  route: Route;
  space: Space | undefined;
  onNavigate: () => void;
  onSwitchUser: () => void;
}): React.JSX.Element {
  const me = useMe();
  const badges = useSpaceBadges(space?.id);
  const section = route.page === 'space' ? route.section : 'overview';

  return (
    <aside className='sidebar' aria-label='Primary'>
      <div className='sb-head'>
        <span className='brand-mark' aria-hidden='true'>
          <Icon name='bot' size={15} strokeWidth={2.2} />
        </span>
        <span className='brand-name'>Meepo</span>
        <Button
          className='sb-close'
          variant='ghost'
          size='sm'
          icon='x'
          aria-label='Close menu'
          onClick={onNavigate}
        />
      </div>
      <div className='sb-body'>
        <SpaceSwitcher current={space} section={section} onNavigate={onNavigate} />

        {space ? (
          <nav className='nav' aria-label='Space'>
            {SPACE_NAV.map((item) => {
              let badge: ReactNode;
              if (item.section === 'tickets') {
                if (badges.review > 0)
                  badge = (
                    <span className='nav-badge nav-badge-warn' title='Need review'>
                      {badges.review}
                    </span>
                  );
                else if (badges.active > 0)
                  badge = (
                    <span className='nav-badge nav-badge-accent' title='In progress'>
                      {badges.active}
                    </span>
                  );
              } else if (item.section === 'workers' && badges.noWorker) {
                badge = (
                  <span
                    className='nav-dot'
                    title='No worker online'
                    aria-label='No worker online'
                  />
                );
              }
              return (
                <NavLink
                  key={item.section}
                  href={spaceHref(space.id, item.section)}
                  icon={item.icon}
                  label={item.label}
                  current={route.page === 'space' && route.section === item.section}
                  badge={badge}
                  onNavigate={onNavigate}
                />
              );
            })}
          </nav>
        ) : null}

        <nav className='nav' aria-label='Platform'>
          <div className='nav-label'>Platform</div>
          <NavLink
            href='#/spaces'
            icon='layers'
            label='All spaces'
            current={route.page === 'spaces'}
            onNavigate={onNavigate}
          />
          <NavLink
            href='#/workers'
            icon='cpu'
            label='All workers'
            current={route.page === 'workers'}
            onNavigate={onNavigate}
          />
          {me.isAdmin ? (
            <>
              <NavLink
                href='#/models'
                icon='sparkles'
                label='Models'
                current={route.page === 'models'}
                onNavigate={onNavigate}
              />
              <NavLink
                href='#/channels'
                icon='plug'
                label='Channels'
                current={route.page === 'channels'}
                onNavigate={onNavigate}
              />
            </>
          ) : null}
        </nav>
      </div>
      <div className='sb-foot'>
        <UserMenu onSwitchUser={onSwitchUser} />
      </div>
    </aside>
  );
}
