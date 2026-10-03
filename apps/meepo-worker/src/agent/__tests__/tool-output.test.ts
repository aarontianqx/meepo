import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boundedTools } from '../tool-output.js';
import type { AnyAgentTool } from '../tools.js';
import { boundedPayload, TOOL_PAYLOAD_BYTES } from '@meepo/protocol';
describe('tool output limits', () => {
  it('keeps the full MCP-style result in a local artifact and returns a bounded preview', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meepo-output-'));
    try {
      const text = '前'.repeat(100000) + 'END';
      const tool = {
        name: 'mcp__test__large',
        label: 'large',
        description: 'test',
        parameters: { type: 'object' },
        execute: async () => ({ content: [{ type: 'text', text }], details: undefined }),
      } as AnyAgentTool;
      const result = await boundedTools([tool], dir)[0].execute('call', {});
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(TOOL_PAYLOAD_BYTES);
      expect(JSON.stringify(result)).toContain('END');
      expect(JSON.stringify(result)).toContain('truncated');
      const files = await readdir(join(dir, '.tool-output'));
      expect(files).toHaveLength(1);
      expect(
        JSON.parse(await readFile(join(dir, '.tool-output', files[0]), 'utf8')).content[0].text
      ).toBe(text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('bounds JSON-escaped payloads and preserves ordinary structured results', () => {
    expect(Buffer.byteLength(JSON.stringify(boundedPayload('\u0000'.repeat(100000))))).toBeLessThan(
      TOOL_PAYLOAD_BYTES
    );
    expect(boundedPayload({ ok: true })).toEqual({ ok: true });
  });
  it('bounds tool errors as well as successful results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meepo-output-error-'));
    try {
      const tool = {
        name: 'mcp__test__error',
        label: 'error',
        description: 'test',
        parameters: { type: 'object' },
        execute: async () => {
          throw new Error('x'.repeat(100000));
        },
      } as AnyAgentTool;
      try {
        await boundedTools([tool], dir)[0].execute('error', {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(Buffer.byteLength((error as Error).message)).toBeLessThan(TOOL_PAYLOAD_BYTES);
        expect((error as Error).message).toContain('完整错误');
      }
      expect(await readdir(join(dir, '.tool-output'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
