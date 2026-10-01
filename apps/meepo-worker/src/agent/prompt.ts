import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AnyAgentTool } from './tools.js';

export const MEMORY_DISCLAIMER =
  'This map is a snapshot from session start and may be incomplete. Memory tools always return current data — search first; do not answer from this map alone.';
export interface PreparedPrompt {
  base: string;
  memoryMap: string;
  memoryMapVersion: number;
}
export function buildBasePrompt(workDir: string, contribution?: string, session = true): string {
  return [
    contribution ?? 'You are Meepo, a general-purpose collaborative assistant.',
    `Your isolated working directory is ${workDir}.`,
    session
      ? 'CronCreate/CronList/CronDelete manage future wakeups of this session. TicketCreate creates independent work with a self-contained objective.'
      : 'Complete the objective independently and summarize the outcome.',
  ].join('\n\n');
}
export async function renderPrompt(
  workDir: string,
  prepared: PreparedPrompt,
  tools: AnyAgentTool[],
  session = true
) {
  const parts = [buildBasePrompt(workDir, prepared.base, session)];
  const root = join(homedir(), '.agents');
  const rules = await optionalFile(join(root, 'AGENTS.md'));
  if (rules) parts.push(`Local operating instructions:\n${rules}`);
  const skills: string[] = [];
  for (const item of await readdir(join(root, 'skills'), { withFileTypes: true }).catch(() => [])) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    const path = join(root, 'skills', item.name, 'SKILL.md');
    const source = await optionalFile(path);
    if (!source) continue;
    const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    const description = front
      .match(/^description:\s*(.+(?:\n[ \t]+[^\n]+)*)/m)?.[1]
      ?.replace(/\n\s+/g, ' ')
      .replace(/^[>|][+-]?\s*/, '')
      .replace(/^['"]|['"]$/g, '');
    if (description) skills.push(`- ${item.name}: ${description.slice(0, 1500)} (${path})`);
  }
  if (skills.length)
    parts.push(
      'Available skills — read the applicable SKILL.md before using a skill:\n' + skills.join('\n')
    );
  parts.push('Available tools:\n' + tools.map((t) => `- ${t.name}: ${t.description}`).join('\n'));
  parts.push(
    `Memory Map (revision ${prepared.memoryMapVersion})\n${MEMORY_DISCLAIMER}\n${prepared.memoryMap || '(empty)'}`
  );
  return parts.join('\n\n');
}
async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
