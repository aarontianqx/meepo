/** Pure helpers for the provider -> model registry views. */

import type { ReasoningEffort } from '@meepo/protocol';

/** A thinking-effort choice in a Space: an explicit strength or the model's own default. */
export type Level = ReasoningEffort | 'default';

/** Token count as a short label: 128000 -> "128k", 1048576 -> "1.05M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`;
  return String(n);
}

/** The choice a Space can keep for a model: its level if the model supports it, else the default. */
export function levelFor(
  level: Level,
  model: { reasoningEfforts: ReasoningEffort[] } | undefined
): Level {
  return level !== 'default' && model?.reasoningEfforts.includes(level) ? level : 'default';
}

export interface ProviderGroup<M extends { providerId: string; providerName: string }> {
  providerId: string;
  providerName: string;
  models: M[];
}

/** Groups models under their provider: groups sorted by name, models keep registry order. */
export function groupByProvider<M extends { providerId: string; providerName: string }>(
  models: M[]
): ProviderGroup<M>[] {
  const groups = new Map<string, ProviderGroup<M>>();
  for (const model of models) {
    const group = groups.get(model.providerId);
    if (group) group.models.push(model);
    else
      groups.set(model.providerId, {
        providerId: model.providerId,
        providerName: model.providerName,
        models: [model],
      });
  }
  return [...groups.values()].sort((a, b) => a.providerName.localeCompare(b.providerName));
}

/** A URL-safe provider id derived from its name, made unique against the existing ids. */
export function providerIdFor(name: string, existingIds: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider';
  let id = base;
  for (let n = 2; existingIds.includes(id); n++) id = `${base}-${n}`;
  return id;
}
