/** Display names for sessions, which have no name of their own. */

import { sessionFlavor } from './status';
import type { SessionItem } from '../api/types';

/** The conversation's headline: its opening message. */
export function sessionName(session: SessionItem): string {
  return session.title || 'Conversation without messages';
}

/** Where the conversation lives, e.g. "Group · <chat name>" or "Private chat · <person>". */
export function sessionWhere(session: SessionItem): string {
  const flavor = sessionFlavor(session);
  const label = session.chatLabel && session.chatLabel !== '私聊' ? session.chatLabel : undefined;
  switch (flavor) {
    case 'console':
      return `Console · ${session.chatId.slice('console:'.length)}`;
    case 'private':
      return session.author ? `Private chat · ${session.author}` : 'Private chat';
    case 'group':
      return label ? `Group · ${label}` : 'Group chat';
    case 'thread':
      return label ? `Thread · ${label}` : 'Thread';
  }
}
