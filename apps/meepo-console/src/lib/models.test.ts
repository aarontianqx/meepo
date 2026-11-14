import { describe, expect, it } from 'vitest';

import { formatTokens, groupByProvider, levelFor, providerIdFor } from './models';

const m = (id: string, providerId: string, providerName: string) => ({
  id,
  providerId,
  providerName,
});

describe('groupByProvider', () => {
  it('sorts groups by provider name and keeps registry order inside a group', () => {
    const groups = groupByProvider([
      m('k3', 'moonshot', 'Moonshot'),
      m('gpt', 'openai', 'Azure OpenAI'),
      m('k2', 'moonshot', 'Moonshot'),
    ]);
    expect(groups.map((g) => g.providerName)).toEqual(['Azure OpenAI', 'Moonshot']);
    expect(groups[1].models.map((x) => x.id)).toEqual(['k3', 'k2']);
  });

  it('returns no groups for no models', () => {
    expect(groupByProvider([])).toEqual([]);
  });
});

describe('providerIdFor', () => {
  it('slugs the name and falls back when nothing usable remains', () => {
    expect(providerIdFor('Internal gateway (CN)', [])).toBe('internal-gateway-cn');
    expect(providerIdFor('  ', [])).toBe('provider');
    expect(providerIdFor('中文', [])).toBe('provider');
  });

  it('appends a counter until the id is free', () => {
    expect(providerIdFor('Moonshot', ['moonshot', 'moonshot-2'])).toBe('moonshot-3');
  });
});

describe('formatTokens', () => {
  it('shortens token counts for display', () => {
    expect(formatTokens(128_000)).toBe('128k');
    expect(formatTokens(16_384)).toBe('16.4k');
    expect(formatTokens(1_048_576)).toBe('1.05M');
    expect(formatTokens(1_050_000)).toBe('1.05M');
    expect(formatTokens(900)).toBe('900');
  });
});

describe('levelFor', () => {
  const reasoning = { reasoningEfforts: ['low', 'high'] as ('low' | 'high' | 'max')[] };

  it('keeps a level the model supports', () => {
    expect(levelFor('high', reasoning)).toBe('high');
  });

  it('falls back to the model default for an unsupported level or a non-reasoning model', () => {
    expect(levelFor('max', reasoning)).toBe('default');
    expect(levelFor('high', { reasoningEfforts: [] })).toBe('default');
    expect(levelFor('default', reasoning)).toBe('default');
  });
});
