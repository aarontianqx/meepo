import { describe, expect, it } from 'vitest';

import { createModel, createStreamFn } from '../model-factory.js';

const config = {
  provider: 'internal-gw',
  baseUrl: 'https://gw.internal/v1',
  apiKey: 'sk-test',
  model: 'qwen3-coder',
};

describe('createModel', () => {
  it('maps ModelConfig to an openai-completions model literal', () => {
    const model = createModel(config);
    expect(model).toMatchObject({
      id: 'qwen3-coder',
      name: 'qwen3-coder',
      api: 'openai-completions',
      provider: 'internal-gw',
      baseUrl: 'https://gw.internal/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 128_000,
      compat: { supportsDeveloperRole: false },
    });
  });

  it('does not embed the api key on the model (it is passed per request)', () => {
    expect(createModel(config)).not.toHaveProperty('apiKey');
  });
});

describe('createStreamFn', () => {
  it('returns a stream function', () => {
    expect(typeof createStreamFn(config)).toBe('function');
  });
});
