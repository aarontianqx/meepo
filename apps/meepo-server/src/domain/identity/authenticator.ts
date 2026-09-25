import type { UserIdentity } from '@meepo/core';

/**
 * Auth port: resolves transport-agnostic request headers into a normalized
 * user identity. Adapters (SSO JWT, header-based dev) live in `infra/`.
 */
export interface Authenticator {
  authenticate(headers: Record<string, unknown>): Promise<UserIdentity>;
}
