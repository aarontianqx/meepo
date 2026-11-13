/**
 * Resumable live transcript for one session.
 *
 * History is paged over HTTP first (fast first paint), then a one-time stream grant opens
 * `/ws/console/:token?afterSeq=<highest seq>`. On any drop the hook asks for a fresh grant and
 * resumes from the highest sequence it has seen, so events are neither duplicated nor missed.
 */

import { useEffect, useState } from 'react';

import type { CanonicalEvent } from '@meepo/protocol';

import { api } from './endpoints';
import { enc, errorMessage } from './client';

export type StreamState = 'loading' | 'live' | 'reconnecting' | 'error';

export interface SessionStream {
  events: CanonicalEvent[];
  state: StreamState;
  error: string | undefined;
  /** True once the full history has been loaded (events may still arrive live). */
  historyLoaded: boolean;
}

const PAGE_SIZE = 500;
const RECONNECT_DELAY_MS = 2000;

export function useSessionStream(sessionId: string): SessionStream {
  const [stream, setStream] = useState<SessionStream>({
    events: [],
    state: 'loading',
    error: undefined,
    historyLoaded: false,
  });

  useEffect(() => {
    let stopped = false;
    let seq = 0;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: CanonicalEvent[] = [];
    let frame: number | undefined;

    setStream({ events: [], state: 'loading', error: undefined, historyLoaded: false });

    // Coalesce bursts of socket frames into a single render per animation frame.
    const flush = (): void => {
      frame = undefined;
      if (stopped || pending.length === 0) return;
      const batch = pending;
      pending = [];
      setStream((prev) => ({ ...prev, events: [...prev.events, ...batch] }));
    };
    const enqueue = (event: CanonicalEvent): void => {
      if (event.seq <= seq) return;
      seq = event.seq;
      pending.push(event);
      frame ??= requestAnimationFrame(flush);
    };

    const loadHistory = async (): Promise<void> => {
      for (;;) {
        const page = await api.sessionEvents(sessionId, seq);
        if (stopped) return;
        if (page.length > 0) {
          seq = page[page.length - 1].seq;
          setStream((prev) => ({ ...prev, events: [...prev.events, ...page] }));
        }
        if (page.length < PAGE_SIZE) return;
      }
    };

    const connect = async (): Promise<void> => {
      try {
        await loadHistory();
        if (stopped) return;
        setStream((prev) => ({ ...prev, historyLoaded: true }));
        const { token } = await api.streamToken(sessionId);
        if (stopped) return;
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(
          `${scheme}//${location.host}/ws/console/${enc(token)}?afterSeq=${seq}`
        );
        socket.onopen = () => {
          setStream((prev) => ({ ...prev, state: 'live', error: undefined }));
        };
        socket.onmessage = (message) => {
          enqueue(JSON.parse(message.data as string) as CanonicalEvent);
        };
        socket.onclose = () => {
          if (stopped) return;
          setStream((prev) => ({ ...prev, state: 'reconnecting' }));
          timer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
        };
      } catch (error) {
        if (stopped) return;
        setStream((prev) => ({ ...prev, state: 'error', error: errorMessage(error) }));
        timer = setTimeout(() => void connect(), RECONNECT_DELAY_MS * 1.5);
      }
    };
    void connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      socket?.close();
    };
  }, [sessionId]);

  return stream;
}
