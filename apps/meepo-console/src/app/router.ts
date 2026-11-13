/**
 * Hash router. Hash URLs keep deep links working behind any reverse-proxy prefix and need no
 * server-side fallback rules.
 *
 *   #/spaces
 *   #/s/:spaceId[/overview|conversations[/:id]|tickets[/:id]|schedules|memory|workers|settings[/:tab]]
 *   #/workers | #/models | #/channels
 */

import { useSyncExternalStore } from 'react';

export type SpaceSection =
  'overview' | 'conversations' | 'tickets' | 'schedules' | 'memory' | 'workers' | 'settings';

/** Props every space section page receives from the router. */
export interface SectionProps {
  /** Selected item id from the URL (session id, ticket id, memory path, settings tab). */
  item: string | undefined;
  query: URLSearchParams;
}

export const LAST_SPACE_KEY = 'meepo.lastSpace';

export const SPACE_SECTIONS: readonly SpaceSection[] = [
  'overview',
  'conversations',
  'tickets',
  'schedules',
  'memory',
  'workers',
  'settings',
];

export type Route =
  | { page: 'home' }
  | { page: 'spaces' }
  | { page: 'space'; spaceId: string; section: SpaceSection; item?: string; query: URLSearchParams }
  | { page: 'workers' | 'models' | 'channels' }
  | { page: 'not-found' };

export function parseRoute(hash: string): Route {
  const [pathPart, queryPart = ''] = hash.replace(/^#/, '').split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) return { page: 'home' };
  const [head, ...rest] = segments;
  switch (head) {
    case 'spaces':
      return { page: 'spaces' };
    case 'workers':
    case 'models':
    case 'channels':
      return { page: head };
    case 's': {
      const [spaceId, section = 'overview', ...item] = rest;
      if (!spaceId) return { page: 'spaces' };
      if (!(SPACE_SECTIONS as readonly string[]).includes(section)) return { page: 'not-found' };
      return {
        page: 'space',
        spaceId,
        section: section as SpaceSection,
        item: item.length > 0 ? item.join('/') : undefined,
        query: new URLSearchParams(queryPart),
      };
    }
    default:
      return { page: 'not-found' };
  }
}

/** Builds the hash for a space section, optionally selecting an item. */
export function spaceHref(
  spaceId: string,
  section: SpaceSection = 'overview',
  item?: string,
  query?: Record<string, string>
): string {
  const base = `#/s/${encodeURIComponent(spaceId)}${section === 'overview' && !item ? '' : `/${section}`}`;
  const path = item ? `${base}/${item.split('/').map(encodeURIComponent).join('/')}` : base;
  const search = query ? new URLSearchParams(query).toString() : '';
  return search ? `${path}?${search}` : path;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const snapshot = (): string => window.location.hash;

/** Current route, re-rendering on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '');
  return parseCached(hash);
}

// Parsing allocates a URLSearchParams; memoize on the hash string so identity is stable.
let lastHash: string | undefined;
let lastRoute: Route = { page: 'home' };
function parseCached(hash: string): Route {
  if (hash !== lastHash) {
    lastHash = hash;
    lastRoute = parseRoute(hash);
  }
  return lastRoute;
}

export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.location.replace(href);
  else window.location.hash = href.replace(/^#/, '');
}
