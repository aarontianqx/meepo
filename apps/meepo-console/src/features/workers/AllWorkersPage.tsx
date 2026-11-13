// Platform-wide worker list across every space the user belongs to.

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { useQuery } from '../../api/query';
import { EmptyState, ErrorState, ListSkeleton, Page, PageHeader } from '../../ui/Misc';
import { WorkerRow } from './WorkerRow';

export function AllWorkersPage(): React.JSX.Element {
  const workers = useQuery(keys.allWorkers, () => api.listWorkers(), { interval: 5_000 });
  const spaces = useQuery(keys.spaces, api.listSpaces);
  const list = workers.data;
  const online = list?.filter((w) => w.status !== 'offline').length ?? 0;

  return (
    <div className='view'>
      <PageHeader
        title='All workers'
        subtitle={
          list
            ? `${online} of ${list.length} online across your spaces.`
            : 'Workers serving your spaces.'
        }
      />
      <Page>
        {workers.error && !list ? (
          <ErrorState message={workers.error} onRetry={() => void workers.refresh()} />
        ) : !list ? (
          <ListSkeleton rows={3} />
        ) : list.length === 0 ? (
          <EmptyState icon='server' title='No workers yet'>
            Open a space and add a worker from its Workers page.
          </EmptyState>
        ) : (
          <ul className='card worker-list'>
            {[...list]
              .sort(
                (a, b) =>
                  Number(a.status === 'offline') - Number(b.status === 'offline') ||
                  a.hostname.localeCompare(b.hostname)
              )
              .map((worker) => (
                <WorkerRow key={worker.id} worker={worker} spaces={spaces.data ?? []} />
              ))}
          </ul>
        )}
      </Page>
    </div>
  );
}
