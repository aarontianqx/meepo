import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Space, WorkerNode } from '@meepo/core';

interface HealthStatus {
  status: string;
  uptimeSeconds: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [workers, setWorkers] = useState<WorkerNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, s, w] = await Promise.all([
        fetchJson<HealthStatus>('/healthz'),
        fetchJson<Space[]>('/api/spaces'),
        fetchJson<WorkerNode[]>('/api/workers'),
      ]);
      setHealth(h);
      setSpaces(s);
      setWorkers(w);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '960px', margin: '0 auto' }}>
      <h1>MEEPO Console</h1>
      <p>Multi-worker Execution Engine for Project-isolated Orchestration</p>

      <section>
        <h2>Server</h2>
        {error ? (
          <p style={{ color: 'crimson' }}>unreachable: {error}</p>
        ) : (
          <p>
            status: {health?.status ?? '...'} {health ? `(uptime ${health.uptimeSeconds}s)` : ''}
          </p>
        )}
      </section>

      <section>
        <h2>Spaces ({spaces.length})</h2>
        <ul>
          {spaces.map((space) => (
            <li key={space.id}>
              <strong>{space.name}</strong> — {space.repoUrl} ({space.defaultBranch}) · chats:{' '}
              {space.boundChatIds.length} · tags: [{space.requiredTags.join(', ')}]
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Workers ({workers.length})</h2>
        <ul>
          {workers.map((worker) => (
            <li key={worker.id}>
              <strong>{worker.id}</strong> — {worker.hostname} · {worker.status} · slots{' '}
              {worker.activeSlots}/{worker.maxSlots} · spaces: [{worker.spaceIds.join(', ')}]
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
