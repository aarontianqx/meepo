import { describe, expect, it } from 'vitest';

import { completeCapabilities, suggestCapabilities } from '../model-capabilities.js';

describe('suggestCapabilities', () => {
  it('knows the Kimi and GPT-5.6 families', () => {
    expect(suggestCapabilities('kimi-k3-0829')).toEqual({
      contextWindow: 1_048_576,
      maxTokens: 128_000,
      reasoningEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      imageInput: true,
    });
    expect(suggestCapabilities('gpt-5.6-sol')).toMatchObject({
      contextWindow: 1_050_000,
      defaultEffort: 'high',
      imageInput: true,
    });
  });

  it('gives an unknown model a conservative non-reasoning profile', () => {
    expect(suggestCapabilities('qwen3-max')).toEqual({
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoningEfforts: [],
      imageInput: false,
    });
  });

  it('returns fresh arrays so callers cannot corrupt later suggestions', () => {
    suggestCapabilities('kimi-k3').reasoningEfforts.pop();
    expect(suggestCapabilities('kimi-k3').reasoningEfforts).toHaveLength(3);
  });
});

describe('completeCapabilities', () => {
  it('takes the suggestion for a new model and keeps stored values on update', () => {
    const created = completeCapabilities('qwen3-max', {});
    expect(created).toEqual(suggestCapabilities('qwen3-max'));
    const edited = completeCapabilities('renamed', { maxTokens: 4096 }, created);
    expect(edited).toEqual({ ...created, maxTokens: 4096 });
  });

  it('lets explicit values win and derives a default effort', () => {
    expect(completeCapabilities('x', { reasoningEfforts: ['low', 'high'] })).toMatchObject({
      reasoningEfforts: ['low', 'high'],
      defaultEffort: 'high',
    });
    expect(
      completeCapabilities('kimi-k3', { reasoningEfforts: ['low', 'high'], defaultEffort: 'low' })
    ).toMatchObject({ defaultEffort: 'low' });
    // The suggestion's default ("max") is not supported, so the strongest supported level is used.
    expect(completeCapabilities('kimi-k3', { reasoningEfforts: ['low', 'high'] })).toMatchObject({
      defaultEffort: 'high',
    });
  });

  it('suggests image input for a new model, keeps it on update, and lets an explicit flag win', () => {
    expect(completeCapabilities('kimi-k3', {}).imageInput).toBe(true);
    expect(completeCapabilities('qwen3-max', {}).imageInput).toBe(false);
    const stored = completeCapabilities('qwen3-max', { imageInput: true });
    expect(stored.imageInput).toBe(true);
    expect(completeCapabilities('qwen3-max', { maxTokens: 4096 }, stored).imageInput).toBe(true);
    expect(completeCapabilities('kimi-k3', { imageInput: false }).imageInput).toBe(false);
  });

  it('accepts the smallest context window the worker can compact for', () => {
    expect(completeCapabilities('x', { contextWindow: 4096, maxTokens: 1024 })).toMatchObject({
      contextWindow: 4096,
    });
  });

  it('turning reasoning off drops the default effort', () => {
    const base = completeCapabilities('kimi-k3', {});
    expect(completeCapabilities('kimi-k3', { reasoningEfforts: [] }, base)).toEqual({
      contextWindow: base.contextWindow,
      maxTokens: base.maxTokens,
      reasoningEfforts: [],
      imageInput: base.imageInput,
    });
  });

  it.each([
    [{ imageInput: 'yes' }],
    [{ contextWindow: 0 }],
    [{ contextWindow: 4095, maxTokens: 1024 }],
    [{ contextWindow: 1.5 }],
    [{ maxTokens: -1 }],
    [{ contextWindow: 1000, maxTokens: 1000 }],
    [{ reasoningEfforts: ['low', 'low'] }],
    [{ reasoningEfforts: ['ultra'] }],
    [{ reasoningEfforts: ['low'], defaultEffort: 'max' }],
    [{ reasoningEfforts: [], defaultEffort: 'low' }],
  ] as const)('rejects %j', (input) => {
    expect(() =>
      completeCapabilities('x', input as Parameters<typeof completeCapabilities>[1])
    ).toThrow();
  });
});
