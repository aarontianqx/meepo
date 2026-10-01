export interface PendingReply {
  id: string;
  channelId: string;
  messageId: string;
  text: string;
  createdAt: number;
}
export interface MessageOutbox {
  pending(channelId: string): PendingReply[];
  sent(id: string): void;
}
