import type { UserIdentity } from '@meepo/core';

import type { Authenticator } from '../../domain/identity/authenticator.js';

const DEFAULT_USER: UserIdentity = { userId: 'dev-user', displayName: 'Dev User' };

/**
 * Development adapter: trusts `x-meepo-user-id` / `x-meepo-user-name` headers,
 * falling back to a single default user. Replace with an SSO adapter for
 * real deployments.
 */
export class HeaderAuthenticator implements Authenticator {
  async authenticate(headers: Record<string, unknown>): Promise<UserIdentity> {
    const userId = readHeader(headers, 'x-meepo-user-id') ?? DEFAULT_USER.userId;
    const displayName = readHeader(headers, 'x-meepo-user-name') ?? userId;
    return { userId, displayName };
  }
}

function readHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
