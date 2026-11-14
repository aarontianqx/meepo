// Flattens the content of a Feishu `post` (rich text) message into plain text plus image keys.

export interface PostContent {
  text: string;
  imageKeys: string[];
}

interface PostNode {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  image_key?: string;
  language?: string;
  emoji_type?: string;
}

interface PostBody {
  title?: string;
  content?: PostNode[][];
}

const MD_MENTION = /<at user_id="([^"]*)">([^<]*)<\/at>/g;

/**
 * Parses parsed-JSON `post` content (wire input). Mentions are emitted as the
 * event's mention keys (`@_user_1`) so the caller's key-to-name substitution
 * handles them exactly as it does for `text` messages.
 */
export function parsePostContent(content: unknown): PostContent {
  const body = findBody(content);
  const imageKeys: string[] = [];
  const lines: string[] = [];
  if (body.title) lines.push(body.title);
  for (const paragraph of body.content ?? []) {
    lines.push(paragraph.map((node) => renderNode(node, imageKeys)).join(''));
  }
  return { text: lines.join('\n').trim(), imageKeys };
}

// Received posts carry `{ title, content }` directly; some payloads wrap it in a locale key.
function findBody(content: unknown): PostBody {
  if (!content || typeof content !== 'object') return {};
  if (Array.isArray((content as PostBody).content)) return content as PostBody;
  for (const value of Object.values(content)) {
    if (value && typeof value === 'object' && Array.isArray((value as PostBody).content)) {
      return value as PostBody;
    }
  }
  return {};
}

function renderNode(node: PostNode, imageKeys: string[]): string {
  switch (node.tag) {
    case 'text':
      return node.text ?? '';
    case 'a':
      return node.href && node.href !== node.text
        ? `[${node.text ?? node.href}](${node.href})`
        : (node.text ?? '');
    case 'at':
      // A mention key (`@_user_1`) is resolved by the caller; a real id is replaced by the name.
      if (node.user_id?.startsWith('@_')) return node.user_id;
      return node.user_name ? `@${node.user_name}` : (node.user_id ?? '');
    case 'img':
      if (node.image_key) imageKeys.push(node.image_key);
      return '[Image]';
    case 'media':
      return '[Video]';
    case 'emotion':
      return node.emoji_type ? `:${node.emoji_type}:` : '';
    case 'hr':
      return '---';
    case 'code_block':
      return `\`\`\`${node.language?.toLowerCase() ?? ''}\n${node.text ?? ''}\n\`\`\``;
    case 'md':
      return (node.text ?? '').replace(MD_MENTION, (_all, id: string, name: string) =>
        id.startsWith('@_') ? id : `@${name}`
      );
    default:
      return '';
  }
}
