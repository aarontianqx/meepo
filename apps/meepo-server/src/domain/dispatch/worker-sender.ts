import type { WorkerChannelDownstream } from '@meepo/protocol';

/** Narrow port for pushing frames to a connected worker; implemented by the WS transport. */
export interface WorkerSender {
  isConnected(workerId: string): boolean;
  sendToWorker(workerId: string, frame: WorkerChannelDownstream): void;
}
