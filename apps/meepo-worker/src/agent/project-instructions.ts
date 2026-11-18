// Lazy discovery of project AGENTS.md files: the first time a tool touches a project, its
// instructions are appended to that tool result, so the system prompt (and its cache) never change.
// When history is compacted they are carried into the summary note, re-read from disk.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { resultText, TOOL_PAYLOAD_BYTES, type CanonicalEvent } from '@meepo/protocol';

import type { AnyAgentTool } from './tools.js';

/** Size limits for project instructions, in bytes. */
export interface ProjectInstructionLimits {
  /** A single instruction file is cut here; the model is told which file to read for the rest. */
  fileBytes: number;
  /** All instruction files carried into one compaction summary. */
  totalBytes: number;
}

export const DEFAULT_PROJECT_INSTRUCTION_LIMITS: ProjectInstructionLimits = {
  fileBytes: 16 * 1024,
  totalBytes: 32 * 1024,
};

const INSTRUCTIONS_FILE = 'AGENTS.md';
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
const MAX_BASH_PATHS = 20;
/** A carried file shorter than this is not worth including. */
const MIN_CARRIED_BYTES = 1024;
const CARRY_HEADING = '[Project instructions carried over]';
const MARKER =
  /^\[Project instructions: (.+?) \(project (.+?), sha256:([0-9a-f]+)\) — applies to files under /gm;

export interface InstructionMarker {
  file: string;
  root: string;
  digest: string;
}

/** Tracks which project instructions the model has already been shown in one conversation. */
export class ProjectInstructionTracker {
  /** Instruction file to the digest of the content the conversation currently contains. */
  private seen = new Map<string, string>();
  /** Instruction files known to the conversation with their project root, least recent first. */
  private readonly files = new Map<string, string>();
  /** Project roots, least recently touched first. */
  private readonly projects = new Set<string>();
  /** The project the model was last told is active. */
  private announced?: string;
  private readonly workDir: string;

  constructor(
    workDir: string,
    private readonly limits: ProjectInstructionLimits = DEFAULT_PROJECT_INSTRUCTION_LIMITS
  ) {
    this.workDir = resolve(workDir);
  }

  /** Returns instruction text to append for the paths a tool call touches, if any is new. */
  async discover(
    toolName: string,
    args: unknown,
    resultBytes: number
  ): Promise<string | undefined> {
    const blocks: string[] = [];
    const delivered: InstructionMarker[] = [];
    let bytes = resultBytes;
    for (const candidate of this.candidatePaths(toolName, args)) {
      const location = await this.locate(candidate);
      if (!location) continue;
      this.touchProject(location.root);
      for (const dir of directoriesDown(location.root, location.dir)) {
        const file = join(dir, INSTRUCTIONS_FILE);
        const content = await readOptional(file);
        if (content === undefined) continue;
        this.touchFile(file, location.root);
        const digest = digestOf(content);
        if (this.seen.get(file) === digest || delivered.some((d) => d.file === file)) continue;
        const block = formatBlock(file, location.root, digest, content, this.limits.fileBytes);
        const total = bytes + Buffer.byteLength(JSON.stringify(block));
        // The journal bounds a whole tool result; never let instructions be cut out of the
        // middle. Leave them unseen so the next touch of the project delivers them.
        if (total > TOOL_PAYLOAD_BYTES) continue;
        bytes = total;
        blocks.push(block);
        delivered.push({ file, root: location.root, digest });
      }
    }
    for (const d of delivered) this.seen.set(d.file, d.digest);
    return blocks.length ? blocks.join('\n\n') : undefined;
  }

  /** Rebuilds what the model has seen from the tool results of a restored conversation. */
  restore(messages: AgentMessage[]): void {
    this.restoreMarkers(markersIn(messages));
  }

  /** Same as {@link restore} for markers already extracted, e.g. from events a compaction dropped. */
  restoreMarkers(markers: InstructionMarker[]): void {
    for (const marker of markers) this.remember(marker);
  }

  /**
   * After history was replaced by a summary plus the `retained` tail: returns the instructions
   * of the projects worked in, re-read from disk, to merge into the summary note. Files whose
   * current content the tail still holds are skipped. Resets what counts as seen to what the
   * new history contains, so anything left out is delivered again on its next touch.
   */
  async carryOver(retained: AgentMessage[]): Promise<string | undefined> {
    const inTail = new Map(markersIn(retained).map((m) => [m.file, m.digest]));
    const next = new Map(inTail);
    const blocks: string[] = [];
    let remaining = this.limits.totalBytes;
    for (const file of this.carryOrder()) {
      const cap = Math.min(this.limits.fileBytes, remaining);
      if (cap < MIN_CARRIED_BYTES) break;
      const content = await readOptional(file);
      if (content === undefined) continue;
      const digest = digestOf(content);
      if (inTail.get(file) === digest) continue;
      const block = formatBlock(file, this.files.get(file)!, digest, content, cap);
      remaining -= Buffer.byteLength(block);
      blocks.push(block);
      next.set(file, digest);
    }
    this.seen = next;
    if (!blocks.length) return undefined;
    const roots = [...this.projects].reverse();
    return `${CARRY_HEADING}\nProjects worked in, most recent first: ${roots.join(', ')}\n\n${blocks.join('\n\n')}`;
  }

  /** A note naming the project the agent is working in, only when it changed since last told. */
  activeProjectNote(): string | undefined {
    const active = [...this.projects].at(-1);
    if (active === undefined || active === this.announced) return undefined;
    this.announced = active;
    return `<active-project root=${JSON.stringify(active)}/>`;
  }

  /** Root files of all projects first (most recent project first), then nested files by recency. */
  private carryOrder(): string[] {
    const roots = [...this.projects].reverse();
    const known = [...this.files.keys()].reverse();
    const rootFiles = roots
      .map((root) => join(root, INSTRUCTIONS_FILE))
      .filter((file) => this.files.has(file));
    return [...rootFiles, ...known.filter((file) => !rootFiles.includes(file))];
  }

  private remember(marker: InstructionMarker): void {
    this.seen.set(marker.file, marker.digest);
    this.touchFile(marker.file, marker.root);
    this.touchProject(marker.root);
  }

  private touchProject(root: string): void {
    this.projects.delete(root);
    this.projects.add(root);
  }

  private touchFile(file: string, root: string): void {
    this.files.delete(file);
    this.files.set(file, root);
  }

  private candidatePaths(toolName: string, args: unknown): string[] {
    const input = args as { path?: unknown; command?: unknown };
    if (FILE_TOOLS.has(toolName))
      return typeof input.path === 'string' ? [this.absolute(input.path)] : [];
    if (toolName === 'bash' && typeof input.command === 'string')
      return bashPaths(input.command).map((p) => this.absolute(p));
    return [];
  }

  private absolute(path: string): string {
    if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
    return isAbsolute(path) ? resolve(path) : resolve(this.workDir, path);
  }

  /** The directory a path lives in and the project root bounding the upward search. */
  private async locate(path: string): Promise<{ dir: string; root: string } | undefined> {
    const info = await stat(path).catch(() => undefined);
    if (!info) return undefined;
    const dir = info.isDirectory() ? path : dirname(path);
    const root = (await gitRoot(dir)) ?? (isInside(dir, this.workDir) ? this.workDir : undefined);
    return root ? { dir, root } : undefined;
  }
}

/** Instruction markers in the tool results of canonical events. */
export function instructionMarkersInEvents(events: CanonicalEvent[]): InstructionMarker[] {
  return events.flatMap((event) =>
    event.type === 'tool_result'
      ? markersOf(resultText((event.payload as { result?: unknown }).result))
      : []
  );
}

/** Merges carried-over instructions into a compaction summary message (always the first). */
export function withCarryOver(summary: AgentMessage, carried: string): AgentMessage {
  if (summary.role !== 'user' || typeof summary.content !== 'string') return summary;
  const closing = '</system_note>';
  const content = summary.content.endsWith(closing)
    ? `${summary.content.slice(0, -closing.length)}\n\n${carried}${closing}`
    : `${summary.content}\n\n${carried}`;
  return { ...summary, content };
}

/** Wraps tools so the first touch of a project appends its AGENTS.md files to the tool result. */
export function withProjectInstructions(
  tools: AnyAgentTool[],
  tracker: ProjectInstructionTracker
): AnyAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      const result = await tool.execute(id, params, signal, onUpdate);
      const text = await tracker
        .discover(tool.name, params, Buffer.byteLength(JSON.stringify(result)))
        // Discovery is a convenience: a failure must never fail the tool call itself.
        .catch((error: unknown) => {
          console.warn('project instructions: discovery failed', error);
          return undefined;
        });
      return text ? { ...result, content: [...result.content, { type: 'text', text }] } : result;
    },
  }));
}

function digestOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function formatBlock(
  file: string,
  root: string,
  digest: string,
  content: string,
  maxBytes: number
): string {
  const bytes = Buffer.from(content);
  const truncated = bytes.length > maxBytes;
  const body = truncated
    ? bytes
        .subarray(0, maxBytes)
        .toString('utf8')
        .replace(/\uFFFD+$/, '')
    : content;
  const header = `[Project instructions: ${file} (project ${root}, sha256:${digest}) — applies to files under ${dirname(file)}]`;
  return `${header}\n${body}${truncated ? `\n[truncated; read ${file} for the rest]` : ''}`;
}

function markersIn(messages: AgentMessage[]): InstructionMarker[] {
  return messages.flatMap((message) =>
    message.role === 'toolResult' || message.role === 'user'
      ? typeof message.content === 'string'
        ? markersOf(message.content)
        : message.content.flatMap((part) => (part.type === 'text' ? markersOf(part.text) : []))
      : []
  );
}

function markersOf(text: string): InstructionMarker[] {
  return [...text.matchAll(MARKER)].map((m) => ({ file: m[1], root: m[2], digest: m[3] }));
}

/** Paths a shell command visibly mentions: absolute, `./`, `../`, `~/` and `cd` targets. */
function bashPaths(command: string): string[] {
  const tokens = command.split(/[\s;|&()<>"'`=]+/).filter(Boolean);
  const paths = new Set<string>();
  tokens.forEach((token, index) => {
    const target = token === 'cd' ? tokens[index + 1] : /^(\/|\.\.?\/|~\/)/.test(token) && token;
    if (target && !target.includes('://')) paths.add(target);
  });
  return [...paths].slice(0, MAX_BASH_PATHS);
}

async function gitRoot(dir: string): Promise<string | undefined> {
  for (let current = dir; ; current = dirname(current)) {
    // `.git` is a file inside worktrees, so any entry counts.
    if (
      await stat(join(current, '.git')).then(
        () => true,
        () => false
      )
    )
      return current;
    if (dirname(current) === current) return undefined;
  }
}

/** Directories from `root` down to `dir`, both included. */
function directoriesDown(root: string, dir: string): string[] {
  const dirs: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    dirs.unshift(current);
    if (current === root) return dirs;
  }
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    // Missing, or a directory/unreadable entry: there are no instructions to show.
    if (
      ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      )
    )
      return undefined;
    throw error;
  }
}
