import WebSocket from 'ws';
import type { WorkerChannelDownstream } from '@meepo/protocol';
import type { WorkerSender } from '../../domain/dispatch/worker-sender.js';

/** Transport-owned connection registry, shared by inbound RPC and domain senders. */
export class WorkerConnectionHub implements WorkerSender {
  private readonly sockets = new Map<string, WebSocket>();
  get(workerId: string): WebSocket | undefined {
    return this.sockets.get(workerId);
  }
  attach(workerId: string, socket: WebSocket): void {
    const previous = this.sockets.get(workerId);
    this.sockets.set(workerId, socket);
    if (previous && previous !== socket) previous.close();
  }
  detach(workerId: string, socket: WebSocket): boolean {
    if (this.sockets.get(workerId) !== socket) return false;
    this.sockets.delete(workerId);
    return true;
  }
  isConnected(workerId: string): boolean {
    return this.get(workerId)?.readyState === WebSocket.OPEN;
  }
  sendToWorker(workerId: string, frame: WorkerChannelDownstream): void {
    const socket = this.get(workerId);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }
}
