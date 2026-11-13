import { useEffect, useState } from 'react';

import { api } from '../api/endpoints';
import { keys } from '../api/keys';
import { useQuery } from '../api/query';
import { AllWorkersPage } from '../features/workers/AllWorkersPage';
import { ChannelsPage } from '../features/admin/ChannelsPage';
import { ModelsPage } from '../features/admin/ModelsPage';
import { SpacesHome } from '../features/spaces/SpacesHome';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/Misc';
import { useMe } from './context';
import { ErrorBoundary } from './ErrorBoundary';
import { LAST_SPACE_KEY, navigate, useRoute, type Route } from './router';
import { Sidebar } from './Sidebar';
import { SpaceRoute } from './SpaceRoute';

/** Sidebar + main sheet. Everything below the identity gate lives here. */
export function Shell({ onSwitchUser }: { onSwitchUser: () => void }): React.JSX.Element {
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
  const spaces = useQuery(keys.spaces, api.listSpaces, { interval: 20_000 });
  const space =
    route.page === 'space' ? spaces.data?.find((s) => s.id === route.spaceId) : undefined;

  // Close the mobile drawer on navigation and Esc.
  useEffect(() => setDrawer(false), [route]);
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className='app' data-drawer={drawer ? 'open' : 'closed'}>
      <Sidebar
        route={route}
        space={space}
        onNavigate={() => setDrawer(false)}
        onSwitchUser={onSwitchUser}
      />
      <div className='scrim' onClick={() => setDrawer(false)} aria-hidden='true' />
      <main className='main' inert={drawer}>
        <div className='mobile-bar'>
          <Button
            variant='ghost'
            icon='menu'
            aria-label='Open menu'
            onClick={() => setDrawer(true)}
          />
          <strong>{space?.name ?? 'Meepo'}</strong>
        </div>
        <ErrorBoundary key={pageKey(route)}>
          <RouteView route={route} />
        </ErrorBoundary>
      </main>
    </div>
  );
}

/** Error boundary resets when the page changes, not on every in-page selection. */
function pageKey(route: Route): string {
  return route.page === 'space' ? `${route.spaceId}/${route.section}` : route.page;
}

function RouteView({ route }: { route: Route }): React.JSX.Element {
  const me = useMe();
  switch (route.page) {
    case 'home':
      return <HomeRedirect />;
    case 'spaces':
      return <SpacesHome />;
    case 'space':
      return <SpaceRoute route={route} />;
    case 'workers':
      return <AllWorkersPage />;
    case 'models':
      return me.isAdmin ? <ModelsPage /> : <AdminOnly />;
    case 'channels':
      return me.isAdmin ? <ChannelsPage /> : <AdminOnly />;
    case 'not-found':
      return (
        <div className='detail-placeholder'>
          <EmptyState
            icon='search'
            title='Page not found'
            action={
              <Button variant='primary' onClick={() => navigate('#/')}>
                Go home
              </Button>
            }
          >
            The address does not match any page in the console.
          </EmptyState>
        </div>
      );
  }
}

function AdminOnly(): React.JSX.Element {
  return (
    <div className='detail-placeholder'>
      <EmptyState icon='shield' title='Administrators only'>
        This page manages platform-wide settings and needs the global administrator role.
      </EmptyState>
    </div>
  );
}

/** `#/` lands on the last-used space (or the only one), otherwise the space list. */
function HomeRedirect(): React.JSX.Element {
  const spaces = useQuery(keys.spaces, api.listSpaces);
  useEffect(() => {
    if (!spaces.data) return;
    const last = localStorage.getItem(LAST_SPACE_KEY);
    const target =
      spaces.data.find((s) => s.id === last) ??
      (spaces.data.length === 1 ? spaces.data[0] : undefined);
    navigate(target ? `#/s/${encodeURIComponent(target.id)}` : '#/spaces', { replace: true });
  }, [spaces.data]);
  return (
    <div className='detail-placeholder' aria-busy='true'>
      <Icon name='refresh' size={18} />
    </div>
  );
}
