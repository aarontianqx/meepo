import type { ModelConfig } from '@meepo/protocol';
import { describe, expect, it } from 'vitest';

import { createModel, createStreamFn, effectiveEffort, supportedLevel } from '../model-factory.js';

const config: ModelConfig = {
  provider: 'internal-gw',
  baseUrl: 'https://gw.internal/v1',
  apiKey: 'sk-test',
  model: 'qwen3-coder',
  contextWindow: 131_072,
  maxTokens: 16_384,
  reasoningEfforts: [],
  imageInput: false,
};

describe('createModel', () => {
  it('maps ModelConfig to an openai-completions model literal using the supplied limits', () => {
    expect(createModel(config)).toMatchObject({
      id: 'qwen3-coder',
      name: 'qwen3-coder',
      api: 'openai-completions',
      provider: 'internal-gw',
      baseUrl: 'https://gw.internal/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131_072,
      maxTokens: 16_384,
      compat: { supportsDeveloperRole: false },
    });
  });

  it('marks the model as reasoning only when it declares supported efforts', () => {
    const reasoning = {
      ...config,
      reasoningEfforts: ['low', 'high'],
      defaultEffort: 'high',
    } as const;
    expect(
      createModel({ ...reasoning, reasoningEfforts: [...reasoning.reasoningEfforts] }).reasoning
    ).toBe(true);
  });

  it('accepts images exactly when the config says so, whatever the model is called', () => {
    expect(createModel({ ...config, imageInput: true }).input).toEqual(['text', 'image']);
    expect(createModel({ ...config, model: 'kimi-k3' }).input).toEqual(['text']);
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

describe('effectiveEffort', () => {
  const reasoning: ModelConfig = {
    ...config,
    reasoningEfforts: ['low', 'high'],
    defaultEffort: 'high',
  };

  it('requests no effort from a non-reasoning model, even when a level is set', () => {
    expect(effectiveEffort({ ...config, thinkingLevel: 'max' })).toBeUndefined();
  });

  it('uses the wanted level when the model supports it', () => {
    expect(effectiveEffort({ ...reasoning, thinkingLevel: 'low' })).toBe('low');
  });

  it('falls back to the default when the level is absent or unsupported', () => {
    expect(effectiveEffort(reasoning)).toBe('high');
    expect(effectiveEffort({ ...reasoning, thinkingLevel: 'max' })).toBe('high');
  });
});

describe('supportedLevel', () => {
  const reasoning: ModelConfig = {
    ...config,
    reasoningEfforts: ['low', 'high'],
    defaultEffort: 'high',
  };

  it('returns the requested level only when the model offers it', () => {
    expect(supportedLevel({ ...reasoning, thinkingLevel: 'low' })).toBe('low');
    expect(supportedLevel({ ...reasoning, thinkingLevel: 'max' })).toBeUndefined();
    expect(supportedLevel(reasoning)).toBeUndefined();
    expect(supportedLevel({ ...config, thinkingLevel: 'high' })).toBeUndefined();
  });
});
