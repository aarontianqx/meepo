import { describe, expect, it } from 'vitest';

import { loadConfig, resolveModel } from '../config.js';

describe('loadConfig model seeds', () => {
  it('converts MEEPO_MODELS entries into providers that share credentials', () => {
    const { models } = loadConfig({
      MEEPO_MODELS: JSON.stringify([
        {
          id: 'a',
          provider: 'openai-completions',
          baseUrl: 'https://h.test/v1',
          apiKey: 'k',
          model: 'ma',
        },
        {
          id: 'b',
          provider: 'openai-completions',
          baseUrl: 'https://h.test/v1',
          apiKey: 'k',
          model: 'mb',
        },
      ]),
    });
    expect(models.providers).toHaveLength(1);
    expect(models.defaultModelId).toBe('a');
    expect(resolveModel(models, 'b')).toMatchObject({
      baseUrl: 'https://h.test/v1',
      apiKey: 'k',
      model: 'mb',
    });
  });

  it('converts the legacy single-model env', () => {
    const { models } = loadConfig({
      MEEPO_MODEL_PROVIDER: 'openai',
      MEEPO_MODEL_BASE_URL: 'https://h.test/v1',
      MEEPO_MODEL_API_KEY: 'k',
      MEEPO_MODEL_ID: 'gpt',
    });
    expect(models.defaultModelId).toBe('gpt');
    expect(resolveModel(models, 'gpt')).toMatchObject({ provider: 'openai', model: 'gpt' });
  });

  it('starts empty without model env', () => {
    expect(loadConfig({}).models).toEqual({
      providers: [],
      entries: [],
      defaultModelId: undefined,
    });
  });
});
