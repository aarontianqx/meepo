import type { ReactNode } from 'react';

import { hueOf } from '../lib/format';
import type { StatusView, Tone } from '../lib/status';
import { Icon, type IconName } from './Icon';

export function Badge({
  tone = 'neutral',
  size = 'md',
  icon,
  children,
  title,
}: {
  tone?: Tone;
  size?: 'md' | 'sm';
  icon?: IconName;
  children: ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <span className={`badge badge-${tone} ${size === 'sm' ? 'badge-sm' : ''}`} title={title}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 11 : 12} /> : null}
      {children}
    </span>
  );
}

/** Pill showing a status with a leading (optionally pulsing) dot. */
export function StatusBadge({
  status,
  size = 'md',
}: {
  status: StatusView;
  size?: 'md' | 'sm';
}): React.JSX.Element {
  return (
    <span className={`badge badge-${status.tone} ${size === 'sm' ? 'badge-sm' : ''}`}>
      <span className={`dot ${status.live ? 'dot-live' : ''}`} />
      {status.label}
    </span>
  );
}

/** Bare colored dot with an accessible label. */
export function StatusDot({ status }: { status: StatusView }): React.JSX.Element {
  return (
    <span
      className={`dot tone-${status.tone} ${status.live ? 'dot-live' : ''}`}
      role='img'
      aria-label={status.label}
      title={status.label}
    />
  );
}

export function Chip({
  children,
  mono,
  onRemove,
  title,
}: {
  children: ReactNode;
  mono?: boolean;
  onRemove?: () => void;
  title?: string;
}): React.JSX.Element {
  return (
    <span className={`chip ${mono ? 'chip-mono' : ''}`} title={title}>
      {children}
      {onRemove ? (
        <button type='button' className='chip-remove' onClick={onRemove} aria-label='Remove'>
          <Icon name='x' size={11} strokeWidth={2.4} />
        </button>
      ) : null}
    </span>
  );
}

/** Deterministic colored square with the entity's initial. */
export function Avatar({
  name,
  size = 'md',
  round,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  round?: boolean;
}): React.JSX.Element {
  const hue = hueOf(name);
  const initial = [...(name.trim() || '?')][0]?.toUpperCase() ?? '?';
  return (
    <span
      className={`avatar ${size === 'sm' ? 'avatar-sm' : size === 'lg' ? 'avatar-lg' : ''} ${round ? 'avatar-round' : ''}`}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 40) % 360} 62% 44%))`,
      }}
      aria-hidden='true'
    >
      {initial}
    </span>
  );
}
