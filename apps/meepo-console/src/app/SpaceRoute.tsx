import type { Space } from '@meepo/core';
import { useEffect, type ComponentType } from 'react';

import { api } from '../api/endpoints';
import { keys } from '../api/keys';
import { useQuery } from '../api/query';
import { ConversationsPage } from '../features/conversations/ConversationsPage';
import { MemoryPage } from '../features/memory/MemoryPage';
import { OverviewPage } from '../features/overview/OverviewPage';
import { SchedulesPage } from '../features/schedules/SchedulesPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TicketsPage } from '../features/tickets/TicketsPage';
import { SpaceWorkersPage } from '../features/workers/SpaceWorkersPage';
import { Button } from '../ui/Button';
import { EmptyState, ListSkeleton } from '../ui/Misc';
import { SpaceProvider } from './context';
import {
  LAST_SPACE_KEY,
  navigate,
  type Route,
  type SectionProps,
  type SpaceSection,
} from './router';

const SECTIONS: Record<SpaceSection, ComponentType<SectionProps>> = {
  overview: OverviewPage,
  conversations: ConversationsPage,
  tickets: TicketsPage,
  schedules: SchedulesPage,
  memory: MemoryPage,
  workers: SpaceWorkersPage,
  settings: SettingsPage,
};

/** Resolves the route's space from the shared space list and renders the requested section. */
export function SpaceRoute({
  route,
}: {
  route: Extract<Route, { page: 'space' }>;
}): React.JSX.Element {
  const spaces = useQuery(keys.spaces, api.listSpaces, { interval: 20_000 });
  const space: Space | undefined = spaces.data?.find((s) => s.id === route.spaceId);

  useEffect(() => {
    if (space) localStorage.setItem(LAST_SPACE_KEY, space.id);
  }, [space]);

  if (!spaces.data) {
    return (
      <div className='view'>
        <ListSkeleton rows={6} />
      </div>
    );
  }
  if (!space) {
    return (
      <div className='detail-placeholder'>
        <EmptyState
          icon='ban'
          title='Space not found'
          action={
            <Button variant='primary' onClick={() => navigate('#/spaces')}>
              Back to spaces
            </Button>
          }
        >
          It may have been deleted, or your account is not a member of it.
        </EmptyState>
      </div>
    );
  }

  const Section = SECTIONS[route.section];
  return (
    <SpaceProvider value={space}>
      <Section key={space.id} item={route.item} query={route.query} />
    </SpaceProvider>
  );
}
