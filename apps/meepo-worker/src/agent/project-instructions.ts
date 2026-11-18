// Lazy discovery of project AGENTS.md files: the first time a tool touches a project, its
// instructions are appended to that tool result, so the system prompt (and its cache) never change.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TOOL_PAYLOAD_BYTES } from '@meepo/protocol';

import type { AnyAgentTool } from './tools.js';

/** A single instruction file is cut here; the model is told which file to read for the rest. */
export const PROJECT_INSTRUCTIONS_FILE_BYTES = 16 * 1024;

const INSTRUCTIONS_FILE = 'AGENTS.md';
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
const MAX_BASH_PATHS = 20;
const MARKER =
  /^\[Project instructions: (.+?) \(project (.+?), sha256:([0-9a-f]+)\) — applies to files under /gm;

/** Tracks which project instructions the model has already been shown in one conversation. */
export class ProjectInstructionTracker {
  /** Instruction file path to the digest of the content the model last saw. */
  private readonly seen = new Map<string, string>();
  /** Project roots, least recently touched first. */
  private readonly projects = new Set<string>();

  private readonly workDir: string;

  constructor(workDir: string) {
    this.workDir = resolve(workDir);
  }

  /** Returns instruction text to append for the paths a tool call touches, if any is new. */
  async discover(
    toolName: string,
    args: unknown,
    resultBytes: number
  ): Promise<string | undefined> {
    const blocks: string[] = [];
    const found: { path: string; digest: string; root: string }[] = [];
    let bytes = resultBytes;
    for (const candidate of this.candidatePaths(toolName, args)) {
      const location = await this.locate(candidate);
      if (!location) continue;
      this.touch(location.root);
      for (const dir of directoriesDown(location.root, location.dir)) {
        const file = join(dir, INSTRUCTIONS_FILE);
        const content = await readOptional(file);
        if (content === undefined) continue;
        const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
        if (this.seen.get(file) === digest || found.some((f) => f.path === file)) continue;
        const block = formatBlock(file, location.root, digest, content);
        const total = bytes + Buffer.byteLength(JSON.stringify(block));
        // The journal bounds a whole tool result; never let instructions be cut out of the
        // middle. Leave them unseen so the next touch of the project delivers them.
        if (total > TOOL_PAYLOAD_BYTES) continue;
        bytes = total;
        blocks.push(block);
        found.push({ path: file, digest, root: location.root });
      }
    }
    for (const f of found) this.seen.set(f.path, f.digest);
    return blocks.length ? blocks.join('\n\n') : undefined;
  }

  /** Rebuilds what the model has seen from the tool results of a restored conversation. */
  restore(messages: AgentMessage[]): void {
    for (const message of messages) {
      if (message.role !== 'toolResult') continue;
      for (const part of message.content) {
        if (part.type !== 'text') continue;
        for (const match of part.text.matchAll(MARKER)) {
          this.seen.set(match[1], match[3]);
          this.touch(match[2]);
        }
      }
    }
  }

  private touch(root: string): void {
    this.projects.delete(root);
    this.projects.add(root);
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

function formatBlock(file: string, root: string, digest: string, content: string): string {
  const bytes = Buffer.from(content);
  const truncated = bytes.length > PROJECT_INSTRUCTIONS_FILE_BYTES;
  const body = truncated
    ? bytes
        .subarray(0, PROJECT_INSTRUCTIONS_FILE_BYTES)
        .toString('utf8')
        .replace(/\uFFFD+$/, '')
    : content;
  const header = `[Project instructions: ${file} (project ${root}, sha256:${digest}) — applies to files under ${dirname(file)}]`;
  return `${header}\n${body}${truncated ? `\n[truncated; read ${file} for the rest]` : ''}`;
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
