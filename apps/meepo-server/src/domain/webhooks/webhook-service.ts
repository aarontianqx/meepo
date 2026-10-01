import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { unauthorized } from '../errors.js';
export interface WebhookTokenRepository {
  get(spaceId: string): string | undefined;
  save(spaceId: string, hash: string): void;
  delete(spaceId: string): void;
}
export class WebhookService {
  constructor(private readonly tokens: WebhookTokenRepository) {}
  issue(spaceId: string): { token: string } {
    const token = 'mwh_' + randomBytes(32).toString('base64url');
    this.tokens.save(spaceId, createHash('sha256').update(token).digest('hex'));
    return { token };
  }
  revoke(spaceId: string): void {
    this.tokens.delete(spaceId);
  }
  requireToken(spaceId: string, token: string): void {
    const expected = this.tokens.get(spaceId);
    const actual = createHash('sha256').update(token).digest();
    if (!expected || !timingSafeEqual(Buffer.from(expected, 'hex'), actual))
      throw unauthorized('Invalid webhook token');
  }
}
