import type { InboundMessage } from './im-router.js';
export interface InboundInbox {
  put(channelId: string, message: InboundMessage): void;
  pending(channelId: string): InboundMessage[];
  done(channelId: string, messageId: string): void;
}
