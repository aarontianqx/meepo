import type { Space, WorkerNode } from '@meepo/core';
import type { ReactNode } from 'react';

import { absoluteTime } from '../../lib/format';
import { workerStatus } from '../../lib/status';
import { Chip, StatusBadge } from '../../ui/Badge';
import { Icon } from '../../ui/Icon';
import { Time } from '../../ui/Misc';

/** One worker as a card row: identity, health, load, tags and serving spaces. */
export function WorkerRow({
  worker,
  spaces,
  label,
  badge,
  actions,
}: {
  worker: WorkerNode;
  /** Name given to the join token this worker used; several workers can share a hostname. */
  label?: string;
  /** Used to name the spaces this worker serves; unknown ids (other users' spaces) are counted. */
  spaces: Space[];
  badge?: ReactNode;
  actions?: ReactNode;
}): React.JSX.Element {
  const known = worker.spaceIds
    .map((id) => spaces.find((s) => s.id === id))
    .filter((s): s is Space => s !== undefined);
  const hidden = worker.spaceIds.length - known.length;
  const offline = worker.status === 'offline';
  const load = worker.maxSlots > 0 ? worker.activeSlots / worker.maxSlots : 0;
  return (
    <li className={`worker-row ${offline ? 'worker-offline' : ''}`}>
      <span className='worker-icon'>
        <Icon name='server' size={18} />
      </span>
      <div className='worker-main'>
        <div className='worker-title'>
          <strong className='truncate'>{label ?? worker.hostname}</strong>
          <StatusBadge status={workerStatus(worker.status)} size='sm' />
          {badge}
        </div>
        <div className='worker-sub'>
          {label ? (
            <>
              <span>{worker.hostname}</span>
              <span className='faint'>·</span>
            </>
          ) : null}
          <span title={absoluteTime(worker.lastHeartbeatAt)}>
            {offline ? 'Last seen ' : 'Heartbeat '}
            <Time at={worker.lastHeartbeatAt} />
          </span>
          <span className='faint'>·</span>
          <span>v{worker.version}</span>
          {known.length > 0 || hidden > 0 ? (
            <>
              <span className='faint'>·</span>
              <span className='truncate'>
                Serves {known.map((s) => s.name).join(', ')}
                {hidden > 0
                  ? `${known.length > 0 ? ' and ' : ''}${hidden} other space${hidden === 1 ? '' : 's'}`
                  : ''}
              </span>
            </>
          ) : null}
        </div>
        {worker.tags.length > 0 ? (
          <div className='row-wrap' style={{ marginTop: 6 }}>
            {worker.tags.map((tag) => (
              <Chip key={tag} mono>
                {tag}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
      <div
        className='worker-load'
        title={`${worker.activeSlots} of ${worker.maxSlots} slots in use`}
      >
        <div className='worker-load-label'>
          <span className='tabular'>
            {worker.activeSlots}/{worker.maxSlots}
          </span>{' '}
          slots
        </div>
        <div className='progress progress-sm' aria-hidden='true'>
          <span
            style={{ width: `${Math.round(load * 100)}%` }}
            className={load >= 1 ? 'progress-full' : ''}
          />
        </div>
      </div>
      {actions ? <div className='worker-actions'>{actions}</div> : null}
    </li>
  );
}
