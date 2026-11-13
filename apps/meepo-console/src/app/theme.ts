/** Theme preference (system / light / dark), resolved to a `data-theme` attribute in JS. */

import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'meepo.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function stored(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

let preference = stored();

function apply(): void {
  const dark = preference === 'dark' || (preference === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Applies the saved theme before first render and follows OS changes while on "system". */
export function initTheme(): void {
  apply();
  media.addEventListener('change', apply);
}

export function setTheme(next: ThemePreference): void {
  preference = next;
  if (next === 'system') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, next);
  apply();
  for (const listener of listeners) listener();
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => preference
  );
}
