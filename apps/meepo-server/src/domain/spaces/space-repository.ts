import type { Space } from '@meepo/core';

export interface SpaceRepository {
  save(space: Space): Promise<void>;
  getById(id: string): Promise<Space | undefined>;
  list(): Promise<Space[]>;
}
