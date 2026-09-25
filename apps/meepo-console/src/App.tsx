import { useState } from 'react';

import { api, getUserId, setUserId } from './api/client';
import { usePolling } from './hooks/usePolling';
import { SpaceDetailPage } from './pages/SpaceDetailPage';
import { SpacesPage } from './pages/SpacesPage';
import { TicketsPage } from './pages/TicketsPage';
import { WorkersPage } from './pages/WorkersPage';

type Route =
  | { page: 'spaces' }
  | { page: 'space'; spaceId: string }
  | { page: 'workers' }
  | { page: 'tickets' };

const NAV_ITEMS: Array<{ page: Route['page']; label: string }> = [
  { page: 'spaces', label: 'Spaces' },
  { page: 'workers', label: 'Workers' },
  { page: 'tickets', label: 'Tickets' },
];

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ page: 'spaces' });
  const [userId, setUserIdState] = useState(getUserId());
  const health = usePolling(() => api.health(), 10_000);

  const activeNav = route.page === 'space' ? 'spaces' : route.page;
  // Remount content when the acting user changes so every page refetches with new identity.
  const contentKey = `${userId}:${route.page}:${route.page === 'space' ? route.spaceId : ''}`;

  return (
    <div>
      <header className='topbar'>
        <span className='brand'>MEEPO Console</span>
        <span>
          <span className={`health-dot ${health.data ? 'health-ok' : 'health-down'}`} />
          {health.data
            ? `server ok (uptime ${health.data.uptimeSeconds}s)`
            : (health.error ?? 'connecting...')}
        </span>
        <span className='spacer' />
        <span className='user-field'>
          <label htmlFor='meepo-user'>User</label>
          <input
            id='meepo-user'
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              setUserIdState(e.target.value.trim());
            }}
            placeholder='x-meepo-user-id'
          />
        </span>
      </header>
      <div className='layout'>
        <nav className='sidenav'>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.page}
              className={activeNav === item.page ? 'active' : ''}
              onClick={() => setRoute({ page: item.page } as Route)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <main className='content' key={contentKey}>
          {route.page === 'spaces' ? (
            <SpacesPage onOpenSpace={(spaceId) => setRoute({ page: 'space', spaceId })} />
          ) : null}
          {route.page === 'space' ? (
            <SpaceDetailPage spaceId={route.spaceId} onBack={() => setRoute({ page: 'spaces' })} />
          ) : null}
          {route.page === 'workers' ? <WorkersPage /> : null}
          {route.page === 'tickets' ? <TicketsPage /> : null}
        </main>
      </div>
    </div>
  );
}
