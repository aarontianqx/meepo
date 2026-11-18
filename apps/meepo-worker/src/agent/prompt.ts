import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import type { AnyAgentTool } from './tools.js';

export const MEMORY_DISCLAIMER =
  'This map is a snapshot from session start and may be incomplete. Memory tools always return current data — search first; do not answer from this map alone.';
export interface PreparedPrompt {
  base: string;
  /** IANA timezone frozen with the session; absent for sessions created before it was frozen. */
  timezone?: string;
  memoryMap: string;
  memoryMapVersion: number;
}
export function buildBasePrompt(workDir: string, contribution?: string, session = true): string {
  return [
    contribution ?? 'You are Meepo, a general-purpose collaborative assistant.',
    `Your isolated working directory is ${workDir}.`,
    session
      ? "CronCreate/CronList/CronDelete manage future wakeups of this session. TicketCreate creates independent work with a self-contained objective. Your reply is delivered to this session's chat window automatically, including after a scheduled wakeup or a ticket receipt; do not send it through other tools (messaging CLIs, APIs) unless the user asks you to contact somewhere else."
      : 'Complete the objective independently and summarize the outcome.',
  ].join('\n\n');
}
export interface RenderPromptOptions {
  /** Ticket prompts omit the chat-delivery rules; defaults to a session prompt. */
  session?: boolean;
  /** Directory scanned for skills; no skill index when absent. */
  skillsDir?: string;
}

/** Render the cold-start system prompt: base, skill index, tool list and Memory Map. */
export async function renderPrompt(
  workDir: string,
  prepared: PreparedPrompt,
  tools: AnyAgentTool[],
  options: RenderPromptOptions = {}
) {
  const parts = [buildBasePrompt(workDir, prepared.base, options.session ?? true)];
  const skills = options.skillsDir ? loadSkillIndex(options.skillsDir) : [];
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

// Sorted by name so the same directory renders the same bytes on every host (prefix cache).
function loadSkillIndex(dir: string): string[] {
  const { skills, diagnostics } = loadSkillsFromDir({ dir, source: 'meepo' });
  for (const d of diagnostics) console.warn(`skills: ${d.message}${d.path ? ` (${d.path})` : ''}`);
  return skills
    .filter((skill) => !skill.disableModelInvocation)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((skill) => `- ${skill.name}: ${skill.description.slice(0, 1500)} (${skill.filePath})`);
}
