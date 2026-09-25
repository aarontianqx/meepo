import type { Space } from '@meepo/core';

import type { SpaceRepository } from '../../domain/spaces/space-repository.js';
import { MemoryTable } from './memory-table.js';

export class MemorySpaceRepository extends MemoryTable<Space> implements SpaceRepository {}
