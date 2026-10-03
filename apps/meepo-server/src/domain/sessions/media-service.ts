import type { MediaReadParams, MediaReadResult } from '@meepo/protocol';
import type { SessionRepository } from './session-repository.js';
import type { SessionEventRepository } from './session-event-repository.js';
import { unauthorized, validation } from '../errors.js';

export interface MediaDownloader {
  download(channelId: string, messageId: string, fileKey: string): Promise<MediaReadResult>;
}
/** Only image references already admitted into this worker's live session are downloadable. */
export class MediaService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly events: SessionEventRepository,
    private readonly downloader: MediaDownloader
  ) {}
  async read(workerId: string, p: MediaReadParams): Promise<MediaReadResult> {
    if (
      ![p.sessionId, p.messageId, p.fileKey].every(
        (v) => typeof v === 'string' && v.length > 0 && v.length <= 256
      )
    )
      throw validation('Invalid image reference');
    const session = await this.sessions.getById(p.sessionId);
    if (
      !session ||
      session.status === 'closed' ||
      session.boundWorkerId !== workerId ||
      !session.channelId
    )
      throw unauthorized('Image session belongs to another worker or is closed');
    if (!(await this.events.hasImage(p.sessionId, p.messageId, p.fileKey)))
      throw unauthorized('Image is not referenced by this session');
    return this.downloader.download(session.channelId, p.messageId, p.fileKey);
  }
}
