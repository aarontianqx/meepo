import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { absoluteTime, relativeTime } from '../lib/format';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export function EmptyState({
  icon = 'inbox',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className='empty'>
      <span className='empty-icon'>
        <Icon name={icon} size={20} />
      </span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className='row'>{action}</div> : null}
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = 14,
  style,
}: {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}): React.JSX.Element {
  return <span className='skeleton' style={{ width, height, ...style }} aria-hidden='true' />;
}

/** A few skeleton rows for lists that are loading for the first time. */
export function ListSkeleton({ rows = 5 }: { rows?: number }): React.JSX.Element {
  return (
    <div className='stack-sm' style={{ padding: 16 }} aria-busy='true' aria-label='Loading'>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className='stack-sm' style={{ gap: 6 }}>
          <Skeleton width={`${60 + ((i * 13) % 35)}%`} height={13} />
          <Skeleton width={`${30 + ((i * 17) % 30)}%`} height={11} />
        </div>
      ))}
    </div>
  );
}

export function Callout({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  const icon: IconName =
    tone === 'danger'
      ? 'alert'
      : tone === 'warn'
        ? 'alert'
        : tone === 'ok'
          ? 'checkCircle'
          : 'info';
  return (
    <div className={`callout callout-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon} size={16} />
      <div className='callout-body'>
        {title ? <div className='callout-title'>{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** Inline error with retry, for failed queries. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <Callout
      tone='danger'
      title='Something went wrong'
      action={
        onRetry ? (
          <Button size='sm' onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {message}
    </Callout>
  );
}

export function CopyButton({
  text,
  label = 'Copy',
  size = 'sm',
  variant = 'default',
}: {
  text: string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost';
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size={size}
      variant={variant}
      icon={copied ? 'check' : 'copy'}
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined
        );
      }}
    >
      {label ? (copied ? 'Copied' : label) : undefined}
    </Button>
  );
}

/** Read-only monospace block with a copy button. */
export function CopyBox({
  text,
  multiline,
}: {
  text: string;
  multiline?: boolean;
}): React.JSX.Element {
  return (
    <div className='copy-box'>
      {multiline ? <pre>{text}</pre> : <code>{text}</code>}
      <CopyButton text={text} />
    </div>
  );
}

/** Relative timestamp with the absolute time in a tooltip; re-renders every 30s. */
export function Time({ at, prefix }: { at: number; prefix?: string }): React.JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
      {prefix}
      {relativeTime(at)}
    </time>
  );
}

/** Section links styled as tabs; real links keep middle-click and copy-link working. */
export function Tabs<T extends string>({
  value,
  tabs,
  label,
}: {
  value: T;
  tabs: Array<{ id: T; label: string; href: string; badge?: ReactNode }>;
  label: string;
}): React.JSX.Element {
  return (
    <nav className='tabs' aria-label={label}>
      {tabs.map((tab) => (
        <a
          key={tab.id}
          className='tab'
          href={tab.href}
          aria-current={tab.id === value ? 'page' : undefined}
        >
          {tab.label}
          {tab.badge}
        </a>
      ))}
    </nav>
  );
}

/** Title row used at the top of every page. */
export function PageHeader({
  title,
  subtitle,
  leading,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}): React.JSX.Element {
  return (
    <header className='page-header'>
      {back ? (
        <a className='back-link' href={back.href}>
          <Icon name='arrowLeft' size={13} />
          {back.label}
        </a>
      ) : null}
      <div className='page-header-row'>
        {leading}
        <div className='page-header-text'>
          <h1>{title}</h1>
          {subtitle ? <p className='muted'>{subtitle}</p> : null}
        </div>
        {actions ? <div className='row page-header-actions'>{actions}</div> : null}
      </div>
    </header>
  );
}

/** Centered, scrollable page container. */
export function Page({
  children,
  narrow,
}: {
  children: ReactNode;
  narrow?: boolean;
}): React.JSX.Element {
  return (
    <div className='page-scroll'>
      <div className={`page-inner ${narrow ? 'page-narrow' : ''}`}>{children}</div>
    </div>
  );
}

/** List/detail layout; on narrow screens only one pane is visible at a time. */
export function SplitView({
  list,
  detail,
  detailOpen,
  listWidth,
}: {
  list: ReactNode;
  detail: ReactNode;
  /** When true on narrow screens the detail pane replaces the list. */
  detailOpen: boolean;
  listWidth?: number;
}): React.JSX.Element {
  return (
    <div
      className={`split ${detailOpen ? 'split-detail-open' : ''}`}
      style={listWidth ? ({ '--split-list': `${listWidth}px` } as CSSProperties) : undefined}
    >
      <section className='split-list'>{list}</section>
      <section className='split-detail'>{detail}</section>
    </div>
  );
}

/** Small section heading with an optional trailing action. */
export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className='section-title'>
      <h2>{children}</h2>
      {action}
    </div>
  );
}
