import type { FastifyRequest } from 'fastify';

import type { UserIdentity } from '@meepo/core';

declare module 'fastify' {
  interface FastifyRequest {
    identity: UserIdentity;
  }
}

/** Identity resolved by the auth hook; never read from request payloads. */
export function identityOf(req: FastifyRequest): UserIdentity {
  return req.identity;
}
