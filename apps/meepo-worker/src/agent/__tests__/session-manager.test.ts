import type { ModelConfig, TranscriptMessage } from '@meepo/protocol';
import { describe, expect, it } from 'vitest';

import { transcriptToAgentMessage } from '../session-manager.js';

const model: ModelConfig = {
  provider: 'internal-gw',
  baseUrl: 'https://gw.internal/v1',
  apiKey: 'sk-test',
  model: 'qwen3-coder',
};

function entry(
  partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, 'role'>
): TranscriptMessage {
  return { content: 'content', timestamp: 0, ...partial };
}

describe('transcriptToAgentMessage', () => {
  it('prefixes user messages with the author when present', () => {
    const message = transcriptToAgentMessage(
      entry({ role: 'user', content: 'hello', author: 'Alice' }),
      0,
      model
    );
    expect(message).toEqual({ role: 'user', content: '[Alice] hello', timestamp: 0 });
  });

  it('leaves user messages without an author untouched', () => {
    const message = transcriptToAgentMessage(entry({ role: 'user', content: 'hello' }), 0, model);
    expect(message).toEqual({ role: 'user', content: 'hello', timestamp: 0 });
  });

  it('does not prefix assistant messages even when an author is present', () => {
    const message = transcriptToAgentMessage(
      entry({ role: 'assistant', content: 'reply', author: 'meepo-bot' }),
      1,
      model
    );
    expect(message.role).toBe('assistant');
    expect(message).toMatchObject({
      content: [{ type: 'text', text: 'reply' }],
      api: 'openai-completions',
      provider: model.provider,
      model: model.model,
      stopReason: 'stop',
    });
  });

  it('maps tool entries to toolResult messages without an author prefix', () => {
    const message = transcriptToAgentMessage(
      entry({ role: 'tool', content: 'ls output' }),
      2,
      model
    );
    expect(message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'restored-2',
      content: [{ type: 'text', text: 'ls output' }],
      isError: false,
    });
  });
});
