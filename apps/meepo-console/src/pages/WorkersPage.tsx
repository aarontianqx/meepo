import type { WorkerNode } from '@meepo/core';

import { api } from '../api/client';
import { ErrorBanner, Section } from '../components/common';
import { usePolling } from '../hooks/usePolling';
import { relativeTime } from '../util';

export function WorkersPage(): React.JSX.Element {
  const workers = usePolling(() => api.listWorkers(), 10_000);

  return (
    <div>
      <h2>Workers</h2>
      <ErrorBanner error={workers.error} />
      <Section title={`All workers (${workers.data?.length ?? 0})`}>
        {workers.data?.length === 0 ? <p className='muted'>No workers registered.</p> : null}
        {workers.data && workers.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Hostname</th>
                <th>Status</th>
                <th>Slots</th>
                <th>Tags</th>
                <th>Spaces</th>
                <th>Version</th>
                <th>Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {workers.data.map((worker) => (
                <WorkerRow key={worker.id} worker={worker} />
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
    </div>
  );
}

function WorkerRow({ worker }: { worker: WorkerNode }): React.JSX.Element {
  return (
    <tr>
      <td>
        <code>{worker.id}</code>
      </td>
      <td>{worker.hostname}</td>
      <td>
        <span className={`status-pill status-${worker.status}`}>{worker.status}</span>
      </td>
      <td>
        {worker.activeSlots}/{worker.maxSlots}
      </td>
      <td>
        {worker.tags.map((tag) => (
          <span key={tag} className='tag'>
            {tag}
          </span>
        ))}
      </td>
      <td>
        {worker.spaceIds.map((spaceId) => (
          <div key={spaceId}>
            <code>{spaceId}</code>
          </div>
        ))}
      </td>
      <td>{worker.version}</td>
      <td title={new Date(worker.lastHeartbeatAt).toLocaleString()}>
        {relativeTime(worker.lastHeartbeatAt)}
      </td>
    </tr>
  );
}
