import { createHash } from 'node:crypto';
import type { ChannelService } from '../../domain/channels/channel-service.js';
import type { MediaDownloader } from '../../domain/sessions/media-service.js';
const MAX_BYTES = 10 * 1024 * 1024;
interface TokenEntry {
  fingerprint: string;
  token?: string;
  expiresAt: number;
  pending?: Promise<string>;
}
/** App credentials and tenant tokens never cross the worker connection. */
export class FeishuMediaDownloader implements MediaDownloader {
  private readonly tokens = new Map<string, TokenEntry>();
  constructor(
    private readonly channels: ChannelService,
    private readonly now: () => number = Date.now
  ) {}

  private async accessToken(channelId: string): Promise<string> {
    const channel = this.channels.get(channelId);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([channel.appId, channel.appSecret]))
      .digest('hex');
    let entry = this.tokens.get(channelId);
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, expiresAt: 0 };
      this.tokens.set(channelId, entry);
    }
    if (entry.token && entry.expiresAt > this.now()) return entry.token;
    if (entry.pending) return entry.pending;
    const current = entry;
    const started = this.now();
    current.pending = (async () => {
      const response = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_id: channel.appId, app_secret: channel.appSecret }),
          signal: AbortSignal.timeout(15000),
        }
      );
      const data = (await response.json()) as {
        code?: number;
        tenant_access_token?: string;
        expire?: number;
      };
      if (!response.ok || (data.code !== undefined && data.code !== 0) || !data.tenant_access_token)
        throw new Error('Channel authentication failed');
      const lifetime =
        typeof data.expire === 'number' && Number.isFinite(data.expire)
          ? Math.max(0, data.expire * 1000)
          : 0;
      current.token = data.tenant_access_token;
      current.expiresAt = started + Math.max(0, lifetime - Math.min(60000, lifetime * 0.1));
      return current.token;
    })();
    try {
      return await current.pending;
    } finally {
      current.pending = undefined;
    }
  }
  async download(channelId: string, messageId: string, fileKey: string) {
    const signal = AbortSignal.timeout(25000);
    const token = await this.accessToken(channelId);
    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=image`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      }
    );
    if (response.status === 401) {
      const entry = this.tokens.get(channelId);
      if (entry?.token === token) entry.expiresAt = 0;
    }
    if (!response.ok || !response.body) throw new Error('Image download failed');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body.cancel();
      throw new Error('Image exceeds 10 MB');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new Error('Image exceeds 10 MB');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      data: Buffer.concat(chunks).toString('base64'),
      sizeBytes: size,
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
