import { describe, expect, it } from 'vitest';

import { formatInstant, formatUserMessage, parseInstant, resultText } from '../format.js';

describe('formatInstant', () => {
  const at = Date.UTC(2026, 10, 15, 2, 18, 0, 573);

  it('renders UTC with Z when no timezone is given', () => {
    expect(formatInstant(at)).toBe('2026-11-15T02:18:00Z');
  });

  it('renders the wall clock and offset of the timezone', () => {
    expect(formatInstant(at, 'Asia/Shanghai')).toBe('2026-11-15T10:18:00+08:00');
    expect(formatInstant(at, 'Asia/Kolkata')).toBe('2026-11-15T07:48:00+05:30');
    expect(formatInstant(at, 'UTC')).toBe('2026-11-15T02:18:00Z');
  });

  it('crosses the date line and follows daylight saving time', () => {
    expect(formatInstant(Date.UTC(2026, 10, 15, 20, 0, 0), 'Asia/Shanghai')).toBe(
      '2026-11-16T04:00:00+08:00'
    );
    expect(formatInstant(Date.UTC(2026, 0, 15, 12, 0, 0), 'America/New_York')).toBe(
      '2026-01-15T07:00:00-05:00'
    );
    expect(formatInstant(Date.UTC(2026, 6, 15, 12, 0, 0), 'America/New_York')).toBe(
      '2026-07-15T08:00:00-04:00'
    );
  });

  it('never renders hour 24 at local midnight', () => {
    expect(formatInstant(Date.UTC(2026, 10, 14, 16, 0, 0), 'Asia/Shanghai')).toBe(
      '2026-11-15T00:00:00+08:00'
    );
  });
});

describe('parseInstant', () => {
  it('reads ISO times with an explicit offset', () => {
    expect(parseInstant('2026-11-17T09:00:00+08:00')).toBe(1794877200000);
    expect(parseInstant('2026-11-17T01:00Z')).toBe(1794877200000);
    expect(parseInstant(' 2026-11-17T09:00:00.500+08:00 ')).toBe(1794877200500);
  });

  it('round-trips with formatInstant', () => {
    const at = Date.UTC(2026, 10, 15, 2, 18, 0);
    expect(parseInstant(formatInstant(at, 'Asia/Shanghai'))).toBe(at);
  });

  it.each([
    '2026-11-17T09:00:00',
    '2026-11-17',
    '1794877200000',
    'tomorrow 9am',
    '2026-02-30T09:00:00+08:00',
    '2026-11-17T25:00:00+08:00',
  ])('rejects %s with a hint', (text) => {
    expect(() => parseInstant(text)).toThrow(/UTC offset/);
  });
});

describe('formatUserMessage', () => {
  it('renders the message time in the session timezone', () => {
    const at = Date.UTC(2026, 10, 15, 2, 1, 5);
    expect(formatUserMessage('hi', { author: 'Alice', timestamp: at })).toBe(
      '<message sender="Alice" time="2026-11-15T02:01:05Z">\nhi\n</message>'
    );
    expect(
      formatUserMessage('hi', { author: 'Alice', timestamp: at, timezone: 'Asia/Shanghai' })
    ).toBe('<message sender="Alice" time="2026-11-15T10:01:05+08:00">\nhi\n</message>');
  });
});

describe('resultText', () => {
  it('joins text parts, marks other parts, and falls back to JSON', () => {
    expect(resultText('plain')).toBe('plain');
    expect(
      resultText({
        content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
      })
    ).toBe('a\n[image]\nb');
    expect(resultText({ n: 1 })).toBe('{\n  "n": 1\n}');
    expect(resultText(undefined)).toBe('');
  });
});
