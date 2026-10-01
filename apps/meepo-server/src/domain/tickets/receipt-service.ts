import type { DispatchService } from '../dispatch/dispatch-service.js';
import type { SessionRepository } from '../sessions/session-repository.js';

export interface TicketReceipt {
  runId: string;
  sessionId: string;
  content: string;
  timestamp: number;
}
export interface ReceiptRepository {
  pending(): TicketReceipt[];
  delivered(runId: string): void;
  TxDeliverClosed(receipt: TicketReceipt): void;
}

export class ReceiptService {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly sessions: SessionRepository,
    private readonly dispatch: Pick<DispatchService, 'dispatchSessionTurn'>,
    private readonly onError: (error: unknown) => void = (error) =>
      console.error('Ticket receipt delivery failed', error)
  ) {}
  async flush(): Promise<void> {
    for (const receipt of this.receipts.pending()) {
      try {
        const session = await this.sessions.getById(receipt.sessionId);
        if (!session || session.status === 'closed') {
          this.receipts.TxDeliverClosed(receipt);
          continue;
        }
        await this.dispatch.dispatchSessionTurn({
          sessionId: session.id,
          prompt: receipt.content,
          source: { kind: 'system' },
          sourceId: `receipt:${receipt.runId}`,
          delivery: 'wait',
          eventType: 'system_note',
          ingress: { channelId: 'ticket-receipts', messageId: receipt.runId },
        });
        this.receipts.delivered(receipt.runId);
      } catch (error) {
        this.onError(error);
      }
    }
  }
}
