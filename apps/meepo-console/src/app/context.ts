import type { Space } from '@meepo/core';
import { createContext, useContext } from 'react';

import type { Me } from '../api/types';

const MeContext = createContext<Me | undefined>(undefined);
export const MeProvider = MeContext.Provider;

/** The signed-in user (always available below the identity gate). */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe requires <MeProvider>');
  return me;
}

const SpaceContext = createContext<Space | undefined>(undefined);
export const SpaceProvider = SpaceContext.Provider;

/** The space the current route belongs to. */
export function useSpace(): Space {
  const space = useContext(SpaceContext);
  if (!space) throw new Error('useSpace requires <SpaceProvider>');
  return space;
}
